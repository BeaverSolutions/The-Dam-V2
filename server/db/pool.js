'use strict';
const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        // Railway internal network (.railway.internal) does not use SSL.
        // External managed PG providers do. Auto-detect based on URL.
        ssl: process.env.DATABASE_URL?.includes('.railway.internal')
          ? false
          : process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
        max: parseInt(process.env.PG_POOL_MAX || '15'),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        statement_timeout: 30000,
        allowExitOnIdle: true,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        database: process.env.DB_NAME || 'the_dam',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        statement_timeout: 30000,
      }
);

pool.on('error', (err) => {
  logger.error({ msg: 'Unexpected DB pool error', err: err.message });
});

// Helper: set tenant context and run callback within transaction.
// SET LOCAL ROLE beavrdam_app activates the RLS policies on all tenant-scoped
// tables (migrations 002/017/023/027). Role reverts to postgres at COMMIT/ROLLBACK.
// Migrations use pool.connect() directly (no withTenant), so DDL still runs as superuser.
async function withTenant(clientId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE beavrdam_app');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_client_id', clientId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Graceful shutdown: release all connections on process exit
async function drainPool() {
  try { await pool.end(); } catch {}
}
process.on('SIGTERM', drainPool);
process.on('SIGINT', drainPool);

module.exports = pool;
module.exports.withTenant = withTenant;
