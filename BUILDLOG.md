# BUILDLOG

## 2026-08-27 — Initial implementation

### Where AI helped
- Converted the capstone brief into a compact Node.js + Express architecture.
- Generated the PostgreSQL schema for tenants, plans, subscriptions, usage events, and Stripe event deduplication.
- Implemented idempotent usage metering, monthly quota checks, integer cost calculations, Stripe Checkout, and signed webhook handling.
- Added deterministic tests and evaluator documentation.

### Human review / changes
- Pinned Free and Pro limits in the database seed.
- Kept Stripe credentials in environment variables and added `.env.example` only.
- Used integer micro-dollar values for persisted cost instead of floating-point money.
- Documented that AI token usage is simulated and provider pricing is not represented as current commercial pricing.

### Known verification boundary
The repository was assembled from the capstone requirements, but live Stripe behavior requires the developer's own Stripe test-mode credentials and local Stripe CLI. Those values are intentionally not committed.
