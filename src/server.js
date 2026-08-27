require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const Stripe = require('stripe');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PORT = Number(process.env.PORT || 3000);
const MICRO_PER_DOLLAR = 1_000_000;

function tenantId(req) {
  return req.header('x-tenant-id');
}

function validUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function calculateAiCostMicro({ inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, reasoningTokens = 0 }, plan) {
  // Rates are micro-dollars per 1,000 tokens. Reasoning is priced as output.
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  const billedOutput = outputTokens + reasoningTokens;
  return Math.floor((freshInput * plan.input_token_price_micro + cachedInputTokens * plan.cached_input_token_price_micro + billedOutput * plan.output_token_price_micro) / 1000);
}

function totalAiTokens(usage) {
  return usage.inputTokens + usage.cachedInputTokens + usage.outputTokens + usage.reasoningTokens;
}

async function getTenant(client, id) {
  const result = await client.query(`
    SELECT t.*, p.name AS plan_name, p.api_call_limit, p.ai_token_limit,
      p.api_call_price_cents, p.input_token_price_micro,
      p.cached_input_token_price_micro, p.output_token_price_micro
    FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1
  `, [id]);
  return result.rows[0];
}

async function recordUsage({ tenant, usageType, quantity, usage, idempotencyKey }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await getTenant(client, tenant.id);
    if (!locked) throw Object.assign(new Error('Tenant not found'), { status: 404 });

    const existing = await client.query(
      'SELECT * FROM usage_events WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenant.id, idempotencyKey]
    );
    if (existing.rowCount) {
      await client.query('COMMIT');
      return { duplicate: true, event: existing.rows[0] };
    }

    const usageTotals = await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN usage_type = 'api_call' THEN quantity ELSE 0 END), 0)::bigint AS api_calls,
        COALESCE(SUM(CASE WHEN usage_type = 'ai_tokens' THEN quantity ELSE 0 END), 0)::bigint AS ai_tokens
      FROM usage_events
      WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())
    `, [tenant.id]);
    const current = usageTotals.rows[0];
    const apiAfter = Number(current.api_calls) + (usageType === 'api_call' ? quantity : 0);
    const tokensAfter = Number(current.ai_tokens) + (usageType === 'ai_tokens' ? quantity : 0);

    if (apiAfter > locked.api_call_limit) {
      throw Object.assign(new Error(`API call quota exceeded: ${current.api_calls}/${locked.api_call_limit} used`), { status: 429, code: 'API_QUOTA_EXCEEDED' });
    }
    if (tokensAfter > locked.ai_token_limit) {
      throw Object.assign(new Error(`AI token quota exceeded: ${current.ai_tokens}/${locked.ai_token_limit} used`), { status: 429, code: 'AI_TOKEN_QUOTA_EXCEEDED' });
    }

    const costMicro = usageType === 'api_call'
      ? locked.api_call_price_cents * 10_000 * quantity
      : calculateAiCostMicro(usage, locked);

    const inserted = await client.query(`
      INSERT INTO usage_events
        (tenant_id, usage_type, quantity, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, cost_micro, idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [tenant.id, usageType, quantity, usage.inputTokens || 0, usage.cachedInputTokens || 0, usage.outputTokens || 0, usage.reasoningTokens || 0, costMicro, idempotencyKey]);

    await client.query('COMMIT');
    return { duplicate: false, event: inserted.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (_error) {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '100kb' }));

app.get('/usage', async (req, res) => {
  const id = tenantId(req);
  if (!validUuid(id)) return res.status(400).json({ error: 'x-tenant-id must be a valid UUID' });
  try {
    const result = await pool.query(`
      SELECT t.id, t.name, t.subscription_status, p.name AS plan_name,
        p.api_call_limit, p.ai_token_limit,
        COALESCE(SUM(CASE WHEN u.usage_type='api_call' THEN u.quantity ELSE 0 END),0)::bigint AS api_calls_used,
        COALESCE(SUM(CASE WHEN u.usage_type='ai_tokens' THEN u.quantity ELSE 0 END),0)::bigint AS ai_tokens_used,
        COALESCE(SUM(u.cost_micro),0)::bigint AS cost_micro
      FROM tenants t JOIN plans p ON p.id=t.plan_id
      LEFT JOIN usage_events u ON u.tenant_id=t.id AND u.created_at >= date_trunc('month', NOW())
      WHERE t.id=$1 GROUP BY t.id, t.name, t.subscription_status, p.name, p.api_call_limit, p.ai_token_limit
    `, [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Tenant not found' });
    const row = result.rows[0];
    res.json({ tenant_id: row.id, tenant_name: row.name, plan: row.plan_name, subscription_status: row.subscription_status,
      api_calls: { used: Number(row.api_calls_used), limit: row.api_call_limit },
      ai_tokens: { used: Number(row.ai_tokens_used), limit: row.ai_token_limit },
      cost_microdollars: Number(row.cost_micro), cost_dollars: Number(row.cost_micro) / MICRO_PER_DOLLAR });
  } catch (error) { res.status(500).json({ error: 'Unable to load usage' }); }
});

app.post('/v1/generate', async (req, res) => {
  const id = tenantId(req);
  const key = req.header('Idempotency-Key');
  if (!validUuid(id)) return res.status(400).json({ error: 'x-tenant-id must be a valid UUID' });
  if (!key || key.length > 255) return res.status(400).json({ error: 'Idempotency-Key header is required and must be <=255 characters' });

  const body = req.body || {};
  const usage = {
    inputTokens: Number(body.input_tokens || 0),
    cachedInputTokens: Number(body.cached_input_tokens || 0),
    outputTokens: Number(body.output_tokens || 0),
    reasoningTokens: Number(body.reasoning_tokens || 0)
  };
  if (Object.values(usage).some(n => !Number.isInteger(n) || n < 0)) return res.status(400).json({ error: 'Token counts must be non-negative integers' });
  if (usage.cachedInputTokens > usage.inputTokens) return res.status(400).json({ error: 'cached_input_tokens cannot exceed input_tokens' });

  try {
    const tenantResult = await pool.query('SELECT * FROM tenants WHERE id=$1', [id]);
    if (!tenantResult.rowCount) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = tenantResult.rows[0];

    const api = await recordUsage({ tenant, usageType: 'api_call', quantity: 1, usage, idempotencyKey: `${key}:api` });
    const tokenQty = totalAiTokens(usage);
    let tokens = null;
    if (tokenQty > 0) {
      tokens = await recordUsage({ tenant, usageType: 'ai_tokens', quantity: tokenQty, usage, idempotencyKey: `${key}:tokens` });
    }

    res.status(api.duplicate ? 200 : 201).json({
      message: api.duplicate ? 'Request already processed; original usage returned' : 'Billable request accepted',
      idempotent: api.duplicate,
      usage_event_id: api.event.id,
      token_usage_event_id: tokens?.event.id || null
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Unable to meter request', code: error.code });
  }
});

app.post('/billing/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });
  const id = tenantId(req);
  if (!validUuid(id)) return res.status(400).json({ error: 'x-tenant-id must be a valid UUID' });
  try {
    const result = await pool.query('SELECT * FROM tenants WHERE id=$1', [id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = result.rows[0];
    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ name: tenant.name, metadata: { tenant_id: tenant.id } });
      customerId = customer.id;
      await pool.query('UPDATE tenants SET stripe_customer_id=$1 WHERE id=$2', [customerId, tenant.id]);
    }
    if (!process.env.STRIPE_PRICE_ID) return res.status(503).json({ error: 'STRIPE_PRICE_ID is not configured' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/billing/success`,
      cancel_url: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/billing/cancel`,
      metadata: { tenant_id: tenant.id }
    });
    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (error) { res.status(500).json({ error: 'Unable to create Checkout session' }); }
});

app.post('/webhooks/stripe', async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe webhook is not configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (_error) {
    return res.status(400).json({ error: 'Invalid Stripe webhook signature' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query('INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [event.id, event.type]);
    if (!inserted.rowCount) {
      await client.query('COMMIT');
      return res.json({ received: true, duplicate: true });
    }

    const object = event.data.object;
    const tenantIdFromMetadata = object.metadata?.tenant_id;
    let tenantIdValue = tenantIdFromMetadata;
    if (!tenantIdValue && object.customer) {
      const tenant = await client.query('SELECT id FROM tenants WHERE stripe_customer_id=$1', [object.customer]);
      tenantIdValue = tenant.rows[0]?.id;
    }

    if (tenantIdValue && ['checkout.session.completed','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)) {
      const pro = await client.query("SELECT id FROM plans WHERE name='Pro'");
      const free = await client.query("SELECT id FROM plans WHERE name='Free'");
      if (!pro.rowCount || !free.rowCount) throw new Error('Plans are not seeded');
      if (event.type === 'checkout.session.completed') {
        await client.query('UPDATE tenants SET plan_id=$1, subscription_status=$2 WHERE id=$3', [pro.rows[0].id, 'active', tenantIdValue]);
      } else {
        const status = object.status || (event.type.endsWith('.deleted') ? 'canceled' : 'active');
        const isPro = !['canceled','unpaid','incomplete_expired'].includes(status);
        await client.query('UPDATE tenants SET plan_id=$1, subscription_status=$2 WHERE id=$3', [isPro ? pro.rows[0].id : free.rows[0].id, status, tenantIdValue]);
      }
    }
    await client.query('COMMIT');
    res.json({ received: true, processed: true });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Webhook processing failed' });
  } finally { client.release(); }
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
});

if (require.main === module) app.listen(PORT, () => console.log(`Metering service listening on http://localhost:${PORT}`));

module.exports = { app, calculateAiCostMicro, totalAiTokens };
