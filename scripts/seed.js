require('dotenv').config();
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const id = process.env.DEMO_TENANT_ID || crypto.randomUUID();
  try {
    const plan = await pool.query("SELECT id FROM plans WHERE name='Free'");
    if (!plan.rowCount) throw new Error('Run database initialization first.');
    await pool.query(`
      INSERT INTO tenants(id,name,plan_id,subscription_status)
      VALUES($1,$2,$3,'active')
      ON CONFLICT (id) DO NOTHING
    `, [id, 'Demo Tenant', plan.rows[0].id]);
    console.log(`Demo tenant: ${id}`);
    console.log(`Use header: x-tenant-id: ${id}`);
  } finally {
    await pool.end();
  }
})().catch(error => { console.error(error.message); process.exit(1); });
