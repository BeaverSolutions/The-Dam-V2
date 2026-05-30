'use strict';

const crypto = require('crypto');
const logger = require('../utils/logger');
const pool = require('../db/pool');

function recordAdminApiError({ traceId, err, req, statusCode, code }) {
  const message = String(err.message || 'Internal server error').slice(0, 1000);
  const path = String(req.originalUrl || req.url || '').slice(0, 500);
  const method = String(req.method || '').slice(0, 20);
  const clientId = req.clientId || req.user?.clientId || null;
  const userId = req.user?.userId || null;

  pool.connect().then(async client => {
    try {
      await client.query(
        `INSERT INTO admin_api_errors
           (trace_id, method, path, status_code, code, message, client_id, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [traceId, method, path, statusCode, code, message, clientId, userId]
      );
    } catch (recordErr) {
      logger.warn({ msg: 'Failed to record admin API error', err: recordErr.message, traceId });
    } finally {
      client.release();
    }
  }).catch(recordErr => {
    logger.warn({ msg: 'Failed to connect for admin API error record', err: recordErr.message, traceId });
  });
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const isAdminApi = (req.originalUrl || req.url || '').startsWith('/api/admin');
  const traceId = crypto.randomUUID();

  logger.error({
    msg: err.message,
    code,
    traceId,
    statusCode,
    method: req.method,
    url: req.url,
    clientId: req.clientId,
    stack: err.stack,
  });

  if (isAdminApi) {
    recordAdminApiError({ traceId, err, req, statusCode, code });
  }

  const response = {
    error: statusCode === 500 && process.env.NODE_ENV === 'production'
      ? (isAdminApi ? `Admin API failed (${code}; trace ${traceId.slice(0, 8)})` : 'Something went wrong')
      : err.message || 'Internal server error',
    code,
  };

  if (isAdminApi) response.trace_id = traceId;

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
