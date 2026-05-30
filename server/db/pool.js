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

// ─── RLS enforcement on the global pool (Jules F-05, 2026-05-16) ────────────
//
// The bug: services call pool.query() directly. The base connection role
// (postgres) has BYPASSRLS, so the RLS policies on tenant tables never fire —
// tenant isolation rests entirely on hand-written `client_id` WHERE clauses
// (666 query call sites). One forgotten filter = a cross-tenant leak.
//
// The fix: wrap pool.query so that — when a tenant context is active
// (AsyncLocalStorage clientId set by clientContext / runWithClientContext) —
// the query runs on a dedicated connection as the non-BYPASSRLS role
// `beavrdam_app` with `app.current_client_id` set. RLS then enforces tenant
// isolation automatically, regardless of whether the query author remembered
// the WHERE clause. Defence-in-depth, the way RLS was meant to work.
//
// Gated by RLS_ENFORCE_ENABLED (default OFF) — ships inert, zero behaviour
// change until flipped. Flag ON + no tenant context (migrations, crons before
// context, system queries) → runs as today on the owner role. Validation on
// flip: watch for "permission denied for table X" — beavrdam_app has grants on
// 36/many tables; any gap is a one-line GRANT, surfaced cleanly by the flag.
const RLS_ENFORCE_ENABLED = process.env.RLS_ENFORCE_ENABLED === 'true';
const rawPoolQuery = pool.query.bind(pool);

// Super-admin endpoints are intentionally cross-tenant. They must run as the
// connection owner instead of the tenant-scoped app role used by normal routes.
pool.ownerQuery = async function ownerQuery(...args) {
  return rawPoolQuery(...args);
};

if (RLS_ENFORCE_ENABLED) {
  let getCurrentClientId;
  try {
    ({ getCurrentClientId } = require('../middleware/clientContext'));
  } catch {
    getCurrentClientId = () => null;
  }

  pool.query = async function tenantAwareQuery(...args) {
    // Callback-style call → passthrough (this codebase is promise-style, but be safe).
    if (typeof args[args.length - 1] === 'function') return rawPoolQuery(...args);

    const clientId = getCurrentClientId();
    if (!clientId) return rawPoolQuery(...args); // system / cron / migration — owner role

    // Tenant context active → enforce RLS on a dedicated connection.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE beavrdam_app');
      await client.query("SELECT set_config('app.current_client_id', $1, true)", [clientId]);
      const result = await client.query(...args);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  };
  logger.info({ msg: 'RLS enforcement ENABLED on global pool (Jules F-05)' });
}

// Graceful shutdown: release all connections on process exit
async function drainPool() {
  try { await pool.end(); } catch {}
}
process.on('SIGTERM', drainPool);
process.on('SIGINT', drainPool);

module.exports = pool;
module.exports.withTenant = withTenant;
