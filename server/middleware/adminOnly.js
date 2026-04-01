'use strict';

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'FORBIDDEN' });
  }
  next();
}

module.exports = adminOnly;
