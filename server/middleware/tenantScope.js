'use strict';

function tenantScope(req, res, next) {
  if (!req.user?.clientId) {
    return res.status(403).json({ error: 'No tenant context', code: 'NO_TENANT' });
  }
  req.clientId = req.user.clientId;
  next();
}

module.exports = tenantScope;
