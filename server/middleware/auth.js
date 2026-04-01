'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  const token = authHeader.replace('Bearer ', '');
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded; // { userId, clientId, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'AUTH_INVALID' });
  }
}

module.exports = authMiddleware;
