# One-Page Design

## Problem
SaaS tenants need a reliable answer to: how much did I use, what does it cost, and have I reached my plan limit?

## Data model
- `tenants`: customer organization and current plan/status.
- `plans`: monthly quotas and pinned integer pricing constants.
- `subscriptions`: Stripe subscription state mirrored from verified events.
- `usage_events`: immutable billable events with tenant, type, quantity, token breakdown, cost, timestamp, and idempotency key.
- `stripe_events`: processed Stripe event IDs for replay protection.
- `monthly_usage_rollups`: background aggregate for reporting.

## API surface
- `GET /health` — service/database health.
- `POST /v1/generate` — dummy billable endpoint; requires `x-tenant-id` and `Idempotency-Key`.
- `GET /usage` — current-month usage, limits, and cost.
- `POST /billing/checkout` — creates Stripe test-mode Checkout session.
- `POST /webhooks/stripe` — verifies and processes Stripe subscription events.

## Idempotency strategy
The database enforces `UNIQUE (tenant_id, idempotency_key)`. The metering transaction locks the tenant row before checking current usage and inserting events. This prevents duplicate recording and quota races for concurrent requests.

## Quota strategy
Quota is checked before insertion. Free is 1,000 API calls and 100,000 AI tokens per month. Pro is 10,000 API calls and 1,000,000 AI tokens. A rejected quota request returns `429` with a human-readable reason.

## Money strategy
All persisted cost is integer micro-dollars. AI cost separates fresh input from cached input; reasoning tokens are billed at the output rate. No floating-point money is stored.

## Stripe strategy
Stripe test mode is the payment source of truth. Webhook signatures are verified against the raw request body. Event IDs are unique, so replayed events are ignored. Verified subscription events update the tenant and subscription mirror.

## Background work
`jobs/monthly-rollup.js` aggregates usage into monthly rollups with three attempts and a final error log. It is exposed as `npm run rollup` and can be scheduled externally.

## Explicit non-goal
No real payment capture, invoicing, proration, overage billing, or live AI-model calls.
