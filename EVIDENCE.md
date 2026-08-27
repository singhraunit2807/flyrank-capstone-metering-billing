# EVIDENCE

This file is the reviewer checklist. Run the commands below against the local service and paste the observed output after each probe. The repository intentionally does not fabricate live Stripe evidence.

## 1. Exactly-once metering

Run the same `POST /v1/generate` twice with the same `Idempotency-Key` and tenant ID.

Expected: first response creates usage; second response says the request was already processed and returns the same event ID(s).

```text
COMMAND:
<first curl command>
<second identical curl command>

OBSERVED OUTPUT:
<paste both responses here>
```

## 2. Quota boundary

Drive the demo tenant to its documented Free-plan limit and send one request beyond it.

Expected: HTTP `429` with a clear quota message and no usage event for the rejected action.

```text
COMMAND:
<paste boundary curl/test transcript here>

OBSERVED OUTPUT:
<paste output here>
```

## 3. Stripe Checkout → Pro

Configure Stripe test mode, create a Checkout session, complete it with a Stripe test card, and forward the webhook using Stripe CLI.

Expected: tenant changes from Free to Pro and `GET /usage` reports the Pro limits.

```text
COMMAND:
stripe listen --forward-to localhost:3000/webhooks/stripe
<checkout/test-card transcript>

OBSERVED OUTPUT:
<paste webhook and GET /usage output here>
```

## 4. Webhook signature + replay

Send a webhook with an invalid signature.

Expected: HTTP `400` and no database change.

Replay the same valid event twice.

Expected: first event is processed; second response identifies it as a duplicate.

```text
OBSERVED OUTPUT:
<paste transcripts here>
```

## 5. Pinned token pricing

Run:

```bash
npm test
```

Expected output includes two passing tests covering cached input, reasoning-as-output pricing, and token aggregation.

```text
OBSERVED OUTPUT:
<paste npm test output here>
```

## 6. Shared engineering requirements

- Layered responsibility: HTTP handlers delegate metering and persistence work.
- Boundary validation: malformed UUIDs, missing idempotency keys, and invalid token counts return `4xx`.
- Persistence: PostgreSQL schema includes tenant, plan, subscription, usage, and Stripe event tables with indexes.
- Idempotency: `(tenant_id, idempotency_key)` is unique and checked before insertion.
- Secrets: `.env` is ignored; only placeholders are committed.
- Cost tracking: each usage event stores integer micro-dollar cost.

Replace the placeholder evidence above with actual local transcripts before final submission.
