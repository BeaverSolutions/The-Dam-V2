'use strict';

const pool = require('../db/pool');

/**
 * Super admin middleware — only Beaver Solutions admins can pass.
 * Checks: role = 'admin' AND the user's client slug = 'beaver-solutions'.
 * Applied on all /api/admin routes that need cross-client visibility.
 */
async function superAdminOnly(req, res, next) {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Super admin access required', code: 'FORBIDDEN' });
    }

    const result = await pool.query(
      `SELECT slug FROM clients WHERE id = $1 LIMIT 1`,
      [req.user.clientId]
    );

    if (result.rows[0]?.slug !== 'beaver-solutions') {
      return res.status(403).json({ error: 'Super admin access required', code: 'FORBIDDEN' });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = superAdminOnly;
