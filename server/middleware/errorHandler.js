'use strict';

const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;

  logger.error({
    msg: err.message,
    code: err.code,
    statusCode,
    method: req.method,
    url: req.url,
    clientId: req.clientId,
    stack: err.stack,
  });

  const response = {
    error: statusCode === 500 && process.env.NODE_ENV === 'production'
      ? 'Something went wrong'
      : err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR',
  };

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
