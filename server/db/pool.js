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
            ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
            : false,
        max: 15,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 30000,
        statement_timeout: 30000,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 5432,
        database: process.env.DB_NAME || 'the_dam',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        max: 15,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 30000,
        statement_timeout: 30000,
      }
);

pool.on('error', (err) => {
  logger.error({ msg: 'Unexpected DB pool error', err: err.message });
});

// Helper: set tenant context and run callback within transaction
async function withTenant(clientId, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL app.current_client_id = $1', [clientId]);
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

module.exports = pool;
module.exports.withTenant = withTenant;
