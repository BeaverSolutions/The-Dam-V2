'use strict';

const pool = require('../db/pool');

async function createLog(clientId, { agent, action, target_type, target_id, metadata = {} }) {
  try {
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [clientId, agent, action, target_type || null, target_id || null, JSON.stringify(metadata)]
    );
  } catch (err) {
    // Never let logging errors crash the app
    console.error('Log write failed:', err.message);
  }
}

async function getLogs(clientId, filters = {}, pagination = {}) {
  const { agent, action, date_from, date_to, target_type } = filters;
  const { page = 1, perPage = 50 } = pagination;
  const offset = (page - 1) * perPage;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM logs
     WHERE client_id = $1
       AND ($2::text IS NULL OR agent = $2)
       AND ($3::text IS NULL OR action = $3)
       AND ($4::text IS NULL OR target_type = $4)
       AND ($5::timestamptz IS NULL OR created_at >= $5)
       AND ($6::timestamptz IS NULL OR created_at <= $6)`,
    [clientId, agent || null, action || null, target_type || null, date_from || null, date_to || null]
  );

  const result = await pool.query(
    `SELECT * FROM logs
     WHERE client_id = $1
       AND ($2::text IS NULL OR agent = $2)
       AND ($3::text IS NULL OR action = $3)
       AND ($4::text IS NULL OR target_type = $4)
       AND ($5::timestamptz IS NULL OR created_at >= $5)
       AND ($6::timestamptz IS NULL OR created_at <= $6)
     ORDER BY created_at DESC
     LIMIT $7 OFFSET $8`,
    [clientId, agent || null, action || null, target_type || null, date_from || null, date_to || null, perPage, offset]
  );

  return {
    data: result.rows,
    meta: { total: parseInt(countResult.rows[0].count, 10), page, perPage },
  };
}

module.exports = { createLog, getLogs };
