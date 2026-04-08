'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

function authMiddleware(req, res, next) {
  // Accept httpOnly cookie first, fall back to Bearer header (MyClaw compatibility)
  const cookieToken = req.cookies?.dam_token;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = cookieToken || bearerToken;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (!decoded.userId || !decoded.clientId || !decoded.role) {
      return res.status(401).json({ error: 'Malformed token', code: 'AUTH_INVALID' });
    }
    req.user = decoded; // { userId, clientId, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'AUTH_INVALID' });
  }
}

module.exports = authMiddleware;
