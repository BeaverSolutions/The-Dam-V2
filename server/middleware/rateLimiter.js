'use strict';

const rateLimit = require('express-rate-limit');

const rateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.user?.clientId || req.ip,
  message: { error: 'Rate limit exceeded. Please try again shortly.', code: 'RATE_LIMIT_EXCEEDED' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = rateLimiter;
