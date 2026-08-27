# FlyRank Capstone — Usage Metering & Billing Engine

A small, correctness-first backend service for SaaS usage metering, quotas, cost calculation, and Stripe test-mode subscriptions.

## What this implements

- Multi-tenant usage tracking for API calls and simulated AI tokens.
- Idempotency keys so retries do not create duplicate usage events.
- Monthly quota enforcement with clear `429` responses.
- Integer money math using micro-dollars; no floating-point persistence.
- AI pricing that treats cached input separately and bills reasoning tokens as output.
- `GET /usage` monthly rollup.
- Stripe Checkout in test mode.
- Stripe webhook signature verification and event deduplication.
- Subscription plan synchronization from verified Stripe events.
- PostgreSQL persistence with tenant-scoped indexes.
- Deterministic unit tests for the pricing rules.

## Architecture

```text
Client
  |
  v
POST /v1/generate
  |
  v
Metering transaction -> idempotency check -> quota check -> usage event
  |                                      |
  |                                      +--> 429 when quota exceeded
  v
GET /usage -> monthly rollup -> used / limit / cost

POST /billing/checkout -> Stripe Checkout (test mode)
                              |
                              v
                      signed Stripe webhook
                              |
                       verify + deduplicate
                              |
                              v
                    tenant plan/status sync
```

## Plans and pinned pricing

| Plan | API calls/month | AI tokens/month | API call price |
|---|---:|---:|---:|
| Free | 1,000 | 100,000 | $0.00 |
| Pro | 10,000 | 1,000,000 | $0.01 |

AI prices in `db/init.sql` are integer **micro-dollars per 1,000 tokens**:

- Fresh input: 10 micro-dollars / 1k tokens (Free), 8 (Pro)
- Cached input: 3 micro-dollars / 1k tokens (Free), 2 (Pro)
- Output: 20 micro-dollars / 1k tokens (Free), 16 (Pro)
- Reasoning tokens are included in the output-priced quantity.
- Cached input is a subset of input, so fresh input is `input_tokens - cached_input_tokens`.

These are capstone demonstration prices, not a claim about a provider's current commercial pricing.

## Run locally

### 1. Requirements

- Node.js 20+
- Docker + Docker Compose
- Stripe CLI for webhook testing

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in Stripe test-mode values. Never commit `.env` or any secret.

### 3. Start PostgreSQL

```bash
docker compose up -d
```

### 4. Install dependencies and start

```bash
npm install
npm start
```

### 5. Seed a demo tenant

In another terminal:

```bash
node scripts/seed.js
```

Copy the printed UUID and use it as the `x-tenant-id` header.

## API examples

Health check:

```bash
curl http://localhost:3000/health
```

Bill one request with simulated token usage:

```bash
curl -X POST http://localhost:3000/v1/generate \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: YOUR_TENANT_UUID" \
  -H "Idempotency-Key: demo-request-001" \
  -d '{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":500,"reasoning_tokens":300}'
```

Send the exact same request again. The API returns the original event IDs instead of creating another usage event.

View the monthly rollup:

```bash
curl http://localhost:3000/usage \
  -H "x-tenant-id: YOUR_TENANT_UUID"
```

Create a Stripe Checkout session after configuring `STRIPE_PRICE_ID`:

```bash
curl -X POST http://localhost:3000/billing/checkout \
  -H "x-tenant-id: YOUR_TENANT_UUID"
```

Forward Stripe events locally:

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Copy the `whsec_...` value printed by Stripe CLI into `.env` as `STRIPE_WEBHOOK_SECRET`.

## Tests

```bash
npm test
```

The included tests prove the pinned cached-input/reasoning pricing behavior and token aggregation. The end-to-end Stripe and quota probes are documented in `EVIDENCE.md` and require a running local environment.

## Required capstone files

- `README.md` — system overview, architecture, setup, seed, limitations.
- `capstone.yaml` — evaluator run/seed/test commands and endpoints.
- `EVIDENCE.md` — evidence checklist and reproducible commands.
- `BUILDLOG.md` — AI-assisted development log.
- `.env.example` — safe configuration template.

## Limitations

- AI calls are simulated; no model provider is called.
- Stripe is intentionally test-mode only.
- No invoicing, proration, overage billing, or production payment capture.
- The demo uses a simple tenant header rather than a full authentication service.
- The application is designed as a compact capstone, not a production-ready distributed billing platform.
