require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const Stripe = require('stripe');
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PORT = Number(process.env.PORT || 3000);
const MICRO_PER_DOLLAR = 1_000_000;
const tenantId = req => req.header('x-tenant-id');
const validUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

function calculateAiCostMicro({ inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, reasoningTokens = 0 }, plan) {
  const freshInput = Math.max(0, inputTokens - cachedInputTokens);
  const billedOutput = outputTokens + reasoningTokens;
  return Math.floor((freshInput * plan.input_token_price_micro + cachedInputTokens * plan.cached_input_token_price_micro + billedOutput * plan.output_token_price_micro) / 1000);
}

// Cached input is a subset of input, so it is not added a second time to quota usage.
function totalAiTokens(u) { return u.inputTokens + u.outputTokens + u.reasoningTokens; }

async function meterRequest(id, usage, key) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT t.*,p.name plan_name,p.api_call_limit,p.ai_token_limit,p.api_call_price_cents,p.input_token_price_micro,p.cached_input_token_price_micro,p.output_token_price_micro FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.id=$1 FOR UPDATE`, [id]);
    if (!r.rowCount) throw Object.assign(new Error('Tenant not found'), { status: 404 });
    const tenant = r.rows[0];
    const existing = await client.query('SELECT * FROM usage_events WHERE tenant_id=$1 AND idempotency_key=$2', [id, `${key}:api`]);
    if (existing.rowCount) {
      const token = await client.query('SELECT * FROM usage_events WHERE tenant_id=$1 AND idempotency_key=$2', [id, `${key}:tokens`]);
      await client.query('COMMIT');
      return { duplicate: true, apiEvent: existing.rows[0], tokenEvent: token.rows[0] || null };
    }
    const totals = await client.query(`SELECT COALESCE(SUM(CASE WHEN usage_type='api_call' THEN quantity ELSE 0 END),0)::bigint api_calls, COALESCE(SUM(CASE WHEN usage_type='ai_tokens' THEN quantity ELSE 0 END),0)::bigint ai_tokens FROM usage_events WHERE tenant_id=$1 AND created_at>=date_trunc('month',NOW())`, [id]);
    const current = totals.rows[0];
    const tokenQty = totalAiTokens(usage);
    if (Number(current.api_calls)+1 > tenant.api_call_limit) throw Object.assign(new Error(`API call quota exceeded: ${current.api_calls}/${tenant.api_call_limit} used`), { status:429, code:'API_QUOTA_EXCEEDED' });
    if (Number(current.ai_tokens)+tokenQty > tenant.ai_token_limit) throw Object.assign(new Error(`AI token quota exceeded: ${current.ai_tokens}/${tenant.ai_token_limit} used`), { status:429, code:'AI_TOKEN_QUOTA_EXCEEDED' });
    const apiInsert = await client.query(`INSERT INTO usage_events(tenant_id,usage_type,quantity,cost_micro,idempotency_key) VALUES($1,'api_call',1,$2,$3) RETURNING *`, [id, tenant.api_call_price_cents*10_000, `${key}:api`]);
    let tokenEvent = null;
    if (tokenQty > 0) tokenEvent = (await client.query(`INSERT INTO usage_events(tenant_id,usage_type,quantity,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_micro,idempotency_key) VALUES($1,'ai_tokens',$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id,tokenQty,usage.inputTokens,usage.cachedInputTokens,usage.outputTokens,usage.reasoningTokens,calculateAiCostMicro(usage,tenant),`${key}:tokens`])).rows[0];
    await client.query('COMMIT');
    return { duplicate:false, apiEvent:apiInsert.rows[0], tokenEvent };
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

app.get('/health', async (_req,res) => { try { await pool.query('SELECT 1'); res.json({status:'ok'}); } catch(e) { res.status(503).json({status:'error',message:'Database unavailable'}); } });
app.use('/webhooks/stripe', express.raw({type:'application/json'}));
app.use(express.json({limit:'100kb'}));

app.get('/usage', async (req,res) => {
  const id=tenantId(req); if(!validUuid(id)) return res.status(400).json({error:'x-tenant-id must be a valid UUID'});
  try {
    const r=await pool.query(`SELECT t.id,t.name,t.subscription_status,p.name plan_name,p.api_call_limit,p.ai_token_limit,COALESCE(SUM(CASE WHEN u.usage_type='api_call' THEN u.quantity ELSE 0 END),0)::bigint api_calls_used,COALESCE(SUM(CASE WHEN u.usage_type='ai_tokens' THEN u.quantity ELSE 0 END),0)::bigint ai_tokens_used,COALESCE(SUM(u.cost_micro),0)::bigint cost_micro FROM tenants t JOIN plans p ON p.id=t.plan_id LEFT JOIN usage_events u ON u.tenant_id=t.id AND u.created_at>=date_trunc('month',NOW()) WHERE t.id=$1 GROUP BY t.id,t.name,t.subscription_status,p.name,p.api_call_limit,p.ai_token_limit`,[id]);
    if(!r.rowCount) return res.status(404).json({error:'Tenant not found'}); const x=r.rows[0];
    res.json({tenant_id:x.id,tenant_name:x.name,plan:x.plan_name,subscription_status:x.subscription_status,api_calls:{used:Number(x.api_calls_used),limit:x.api_call_limit},ai_tokens:{used:Number(x.ai_tokens_used),limit:x.ai_token_limit},cost_microdollars:Number(x.cost_micro),cost_dollars:Number(x.cost_micro)/MICRO_PER_DOLLAR});
  } catch(e) { res.status(500).json({error:'Unable to load usage'}); }
});

app.post('/v1/generate', async (req,res) => {
  const id=tenantId(req), key=req.header('Idempotency-Key');
  if(!validUuid(id)) return res.status(400).json({error:'x-tenant-id must be a valid UUID'});
  if(!key||key.length>255) return res.status(400).json({error:'Idempotency-Key header is required and must be <=255 characters'});
  const b=req.body||{}; const usage={inputTokens:Number(b.input_tokens||0),cachedInputTokens:Number(b.cached_input_tokens||0),outputTokens:Number(b.output_tokens||0),reasoningTokens:Number(b.reasoning_tokens||0)};
  if(Object.values(usage).some(n=>!Number.isInteger(n)||n<0)) return res.status(400).json({error:'Token counts must be non-negative integers'});
  if(usage.cachedInputTokens>usage.inputTokens) return res.status(400).json({error:'cached_input_tokens cannot exceed input_tokens'});
  try { const x=await meterRequest(id,usage,key); res.status(x.duplicate?200:201).json({message:x.duplicate?'Request already processed; original usage returned':'Billable request accepted',idempotent:x.duplicate,usage_event_id:x.apiEvent.id,token_usage_event_id:x.tokenEvent?.id||null}); }
  catch(e) { res.status(e.status||500).json({error:e.message||'Unable to meter request',code:e.code}); }
});

app.post('/billing/checkout', async (req,res) => {
  if(!stripe) return res.status(503).json({error:'Stripe is not configured'}); const id=tenantId(req);
  if(!validUuid(id)) return res.status(400).json({error:'x-tenant-id must be a valid UUID'}); if(!process.env.STRIPE_PRICE_ID) return res.status(503).json({error:'STRIPE_PRICE_ID is not configured'});
  try { const r=await pool.query('SELECT * FROM tenants WHERE id=$1',[id]); if(!r.rowCount)return res.status(404).json({error:'Tenant not found'}); const t=r.rows[0]; let customerId=t.stripe_customer_id;
    if(!customerId){const c=await stripe.customers.create({name:t.name,metadata:{tenant_id:t.id}});customerId=c.id;await pool.query('UPDATE tenants SET stripe_customer_id=$1 WHERE id=$2',[customerId,id]);}
    const s=await stripe.checkout.sessions.create({mode:'subscription',customer:customerId,line_items:[{price:process.env.STRIPE_PRICE_ID,quantity:1}],success_url:`${process.env.APP_BASE_URL||'http://localhost:3000'}/billing/success`,cancel_url:`${process.env.APP_BASE_URL||'http://localhost:3000'}/billing/cancel`,metadata:{tenant_id:id}});
    res.json({checkout_url:s.url,session_id:s.id});
  } catch(e){res.status(500).json({error:'Unable to create Checkout session'});}
});

app.post('/webhooks/stripe', async (req,res) => {
  if(!stripe||!process.env.STRIPE_WEBHOOK_SECRET)return res.status(503).json({error:'Stripe webhook is not configured'}); let event;
  try{event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET);}catch(e){return res.status(400).json({error:'Invalid Stripe webhook signature'});}
  const client=await pool.connect();
  try{await client.query('BEGIN'); const d=await client.query('INSERT INTO stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',[event.id,event.type]); if(!d.rowCount){await client.query('COMMIT');return res.json({received:true,duplicate:true});}
    const o=event.data.object; let id=o.metadata?.tenant_id; if(!id&&o.customer){const t=await client.query('SELECT id FROM tenants WHERE stripe_customer_id=$1',[o.customer]);id=t.rows[0]?.id;}
    if(id&&['checkout.session.completed','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
      const pro=(await client.query("SELECT id FROM plans WHERE name='Pro'")).rows[0], free=(await client.query("SELECT id FROM plans WHERE name='Free'")).rows[0]; if(!pro||!free)throw new Error('Plans are not seeded');
      if(event.type==='checkout.session.completed'){await client.query('UPDATE tenants SET plan_id=$1,subscription_status=$2,stripe_customer_id=COALESCE(stripe_customer_id,$3) WHERE id=$4',[pro.id,'active',o.customer,id]); if(o.subscription)await client.query(`INSERT INTO subscriptions(tenant_id,stripe_subscription_id,stripe_customer_id,plan_id,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(stripe_subscription_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,status=EXCLUDED.status,updated_at=NOW()`,[id,o.subscription,o.customer,pro.id,'active']);}
      else{const status=o.status||(event.type==='customer.subscription.deleted'?'canceled':'active'),isPro=!['canceled','unpaid','incomplete_expired'].includes(status); await client.query('UPDATE tenants SET plan_id=$1,subscription_status=$2 WHERE id=$3',[isPro?pro.id:free.id,status,id]); if(o.id)await client.query(`INSERT INTO subscriptions(tenant_id,stripe_subscription_id,stripe_customer_id,plan_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7)) ON CONFLICT(stripe_subscription_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,status=EXCLUDED.status,current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,updated_at=NOW()`,[id,o.id,o.customer,isPro?pro.id:free.id,status,o.current_period_start||null,o.current_period_end||null]);}
    }
    await client.query('COMMIT');res.json({received:true,processed:true});
  }catch(e){await client.query('ROLLBACK');res.status(500).json({error:'Webhook processing failed'});}finally{client.release();}
});

if(require.main===module)app.listen(PORT,()=>console.log(`Metering service listening on http://localhost:${PORT}`));
module.exports={app,calculateAiCostMicro,totalAiTokens};
