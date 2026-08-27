CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  api_call_limit INTEGER NOT NULL CHECK (api_call_limit > 0),
  ai_token_limit INTEGER NOT NULL CHECK (ai_token_limit > 0),
  api_call_price_cents INTEGER NOT NULL CHECK (api_call_price_cents >= 0),
  input_token_price_micro INTEGER NOT NULL CHECK (input_token_price_micro >= 0),
  cached_input_token_price_micro INTEGER NOT NULL CHECK (cached_input_token_price_micro >= 0),
  output_token_price_micro INTEGER NOT NULL CHECK (output_token_price_micro >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  subscription_status TEXT NOT NULL DEFAULT 'active',
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_type TEXT NOT NULL CHECK (usage_type IN ('api_call', 'ai_tokens')),
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  input_tokens BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micro BIGINT NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS monthly_usage_rollups (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month_start TIMESTAMPTZ NOT NULL,
  api_calls BIGINT NOT NULL DEFAULT 0,
  ai_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micro BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_created ON usage_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions (tenant_id);

INSERT INTO plans (name, api_call_limit, ai_token_limit, api_call_price_cents, input_token_price_micro, cached_input_token_price_micro, output_token_price_micro)
VALUES
  ('Free', 1000, 100000, 0, 10, 3, 20),
  ('Pro', 10000, 1000000, 1, 8, 2, 16)
ON CONFLICT (name) DO NOTHING;
