require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function rollupWithRetry(attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query(`
        INSERT INTO monthly_usage_rollups (tenant_id, month_start, api_calls, ai_tokens, cost_micro)
        SELECT tenant_id, date_trunc('month', created_at),
          COALESCE(SUM(CASE WHEN usage_type='api_call' THEN quantity ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN usage_type='ai_tokens' THEN quantity ELSE 0 END),0),
          COALESCE(SUM(cost_micro),0)
        FROM usage_events
        GROUP BY tenant_id, date_trunc('month', created_at)
        ON CONFLICT (tenant_id, month_start) DO UPDATE SET
          api_calls=EXCLUDED.api_calls,
          ai_tokens=EXCLUDED.ai_tokens,
          cost_micro=EXCLUDED.cost_micro,
          updated_at=NOW()
      `);
      return;
    } catch (error) {
      if (attempt === attempts) {
        console.error('[background-job] monthly rollup failed after retries:', error.message);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
}

if (require.main === module) {
  rollupWithRetry().finally(() => pool.end());
}

module.exports = { rollupWithRetry };
