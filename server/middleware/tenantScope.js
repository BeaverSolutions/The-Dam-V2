'use strict';

const pool = require('../db/pool');
const logger = require('../utils/logger');

/**
 * Tenant scope middleware — activates RLS as a safety net.
 *
 * For each authenticated request:
 * 1. Sets req.clientId from JWT
 * 2. Acquires a dedicated pg connection
 * 3. Runs SET LOCAL app.current_client_id (activates RLS policies)
 * 4. Exposes req.tenantDb for optional tenant-scoped queries
 * 5. Releases connection on response finish/close
 *
 * Existing pool.query() calls still work (manual client_id WHERE clauses).
 * RLS acts as a second line of defence if any query forgets the filter.
 */
async function tenantScope(req, res, next) {
  if (!req.user?.clientId) {
    return res.status(403).json({ error: 'No tenant context', code: 'NO_TENANT' });
  }
  req.clientId = req.user.clientId;

  // Acquire a dedicated connection and set tenant context for RLS
  let client;
  let released = false;

  function releaseClient(mode) {
    if (released) return;
    released = true;
    const op = mode === 'rollback' ? 'ROLLBACK' : 'COMMIT';
    client.query(op)
      .catch(err => logger.warn({ msg: `tenantScope ${op} failed`, err: err.message }))
      .finally(() => client.release());
  }

  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_client_id', req.clientId]);

    // Expose tenant-scoped query method (optional — routes can use this or pool.query)
    req.tenantDb = {
      query: (...args) => client.query(...args),
    };

    // Release on response completion
    res.on('finish', () => releaseClient('commit'));
    res.on('close', () => releaseClient('rollback'));

    next();
  } catch (err) {
    if (client) releaseClient('rollback');
    logger.error({ msg: 'tenantScope connection failed', err: err.message });
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'DB_UNAVAILABLE' });
  }
}

module.exports = tenantScope;
