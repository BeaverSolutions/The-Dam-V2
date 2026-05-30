'use strict';

const pool = require('../db/pool');

const BEAVER_SOLUTIONS_CLIENT_ID = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';

/**
 * Super admin middleware — only Beaver Solutions admins can pass.
 * Checks: role = 'admin' AND canonical Beaver client id/slug.
 * Applied on all /api/admin routes that need cross-client visibility.
 */
async function superAdminOnly(req, res, next) {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Super admin access required', code: 'FORBIDDEN' });
    }

    if (req.user?.clientId === BEAVER_SOLUTIONS_CLIENT_ID) {
      return next();
    }

    const result = await pool.ownerQuery(
      `SELECT id, slug FROM clients WHERE id = $1 LIMIT 1`,
      [req.user.clientId]
    );

    const row = result.rows[0];
    const isCanonicalBeaverClient = row?.slug === 'beaver-solutions';

    if (!isCanonicalBeaverClient) {
      return res.status(403).json({ error: 'Super admin access required', code: 'FORBIDDEN' });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = superAdminOnly;
