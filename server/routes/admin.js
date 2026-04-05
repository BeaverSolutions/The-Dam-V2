'use strict';

// Admin routes — super admin only (Beaver Solutions)
// All cross-client operations live here.

const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const { generateAccessCode, createSignupToken } = require('../services/auth');

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────

// GET /api/admin/clients — all clients with pipeline stats
router.get('/clients', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id, c.name, c.email, c.slug, c.plan, c.onboarding_completed, c.created_at,
        (SELECT COUNT(*)::int FROM users u WHERE u.client_id = c.id)                                        AS user_count,
        (SELECT COUNT(*)::int FROM leads l WHERE l.client_id = c.id AND l.deleted_at IS NULL)               AS lead_count,
        (SELECT COUNT(*)::int FROM messages m WHERE m.client_id = c.id)                                     AS message_count,
        (SELECT COUNT(*)::int FROM approvals a WHERE a.client_id = c.id AND a.status = 'pending')           AS pending_approvals,
        (SELECT MAX(lg.created_at) FROM logs lg WHERE lg.client_id = c.id)                                  AS last_activity
      FROM clients c
      ORDER BY c.created_at DESC
    `);
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) { next(err); }
});

// POST /api/admin/clients — create new client + admin user
router.post('/clients',
  [
    body('name').trim().isLength({ min: 1, max: 200 }),
    body('email').isEmail().normalizeEmail(),
    body('plan').optional().isIn(['starter', 'growth', 'enterprise']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { name, email, plan = 'starter' } = req.body;

      // Check email not already taken
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_TAKEN' });
      }

      // Generate slug from name
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      // Create client
      const clientRes = await pool.query(
        `INSERT INTO clients (name, email, plan, slug) VALUES ($1, $2, $3, $4) RETURNING id, name, email, slug, plan`,
        [name, email, plan, slug]
      );
      const client = clientRes.rows[0];

      // Create admin user with temp password
      const tempPassword = `Dam${Math.random().toString(36).slice(2, 8).toUpperCase()}!`;
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const userRes = await pool.query(
        `INSERT INTO users (client_id, email, password_hash, role, email_verified)
         VALUES ($1, $2, $3, 'admin', true) RETURNING id, email, role`,
        [client.id, email, passwordHash]
      );

      // Generate access code
      const code = generateAccessCode();
      await pool.query(
        `INSERT INTO access_codes (client_id, code) VALUES ($1, $2)`,
        [client.id, code]
      );

      res.status(201).json({
        data: {
          client,
          user: userRes.rows[0],
          credentials: {
            email,
            temp_password: tempPassword,
            access_code: code,
          },
          message: 'Client created. Share the temp password and access code with your client.',
        },
      });
    } catch (err) { next(err); }
  }
);

// GET /api/admin/clients/:id — single client with full stats
router.get('/clients/:id',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const [clientRes, statsRes] = await Promise.all([
        pool.query(`SELECT * FROM clients WHERE id = $1`, [id]),
        pool.query(`
          SELECT
            COUNT(DISTINCT l.id) FILTER (WHERE l.deleted_at IS NULL)::int AS total_leads,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'new' AND l.deleted_at IS NULL)::int AS new_leads,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'contacted' AND l.deleted_at IS NULL)::int AS contacted,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'replied' AND l.deleted_at IS NULL)::int AS replied,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'meeting_booked' AND l.deleted_at IS NULL)::int AS meetings,
            COUNT(DISTINCT m.id)::int AS total_messages,
            COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'sent')::int AS sent_messages,
            COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'ranger_rejected')::int AS rejected_messages,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'pending')::int AS pending_approvals
          FROM clients c
          LEFT JOIN leads l ON l.client_id = c.id
          LEFT JOIN messages m ON m.client_id = c.id
          LEFT JOIN approvals a ON a.client_id = c.id
          WHERE c.id = $1
        `, [id]),
      ]);

      if (clientRes.rows.length === 0) {
        return res.status(404).json({ error: 'Client not found', code: 'NOT_FOUND' });
      }

      res.json({ data: { ...clientRes.rows[0], stats: statsRes.rows[0] } });
    } catch (err) { next(err); }
  }
);

// PATCH /api/admin/clients/:id — update client details
router.patch('/clients/:id',
  [
    param('id').isUUID(),
    body('name').optional().trim().isLength({ min: 1, max: 200 }),
    body('plan').optional().isIn(['starter', 'growth', 'enterprise']),
    body('onboarding_completed').optional().isBoolean(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const fields = [];
      const values = [];
      let idx = 1;

      if (req.body.name !== undefined) { fields.push(`name = $${idx++}`); values.push(req.body.name); }
      if (req.body.plan !== undefined) { fields.push(`plan = $${idx++}`); values.push(req.body.plan); }
      if (req.body.onboarding_completed !== undefined) { fields.push(`onboarding_completed = $${idx++}`); values.push(req.body.onboarding_completed); }

      if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

      fields.push(`updated_at = NOW()`);
      values.push(id);

      const result = await pool.query(
        `UPDATE clients SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );
      res.json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// USERS PER CLIENT
// ─────────────────────────────────────────────

// GET /api/admin/clients/:id/users
router.get('/clients/:id/users',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT id, email, role, email_verified, created_at FROM users
         WHERE client_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      );
      res.json({ data: result.rows, meta: { total: result.rows.length } });
    } catch (err) { next(err); }
  }
);

// POST /api/admin/clients/:id/users — create user for a specific client
router.post('/clients/:id/users',
  [
    param('id').isUUID(),
    body('email').isEmail().normalizeEmail(),
    body('role').optional().isIn(['admin', 'user']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { email, role = 'user' } = req.body;

      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_TAKEN' });
      }

      const tempPassword = `Dam${Math.random().toString(36).slice(2, 8).toUpperCase()}!`;
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const userRes = await pool.query(
        `INSERT INTO users (client_id, email, password_hash, role, email_verified)
         VALUES ($1, $2, $3, $4, true) RETURNING id, email, role, created_at`,
        [id, email, passwordHash, role]
      );

      const code = generateAccessCode();
      await pool.query(`INSERT INTO access_codes (client_id, code) VALUES ($1, $2)`, [id, code]);

      res.status(201).json({
        data: {
          user: userRes.rows[0],
          credentials: { email, temp_password: tempPassword, access_code: code },
        },
      });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const newPassword = `Dam${Math.random().toString(36).slice(2, 8).toUpperCase()}!`;
      const passwordHash = await bcrypt.hash(newPassword, 12);

      const result = await pool.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email`,
        [passwordHash, req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
      }

      res.json({ data: { user: result.rows[0], new_password: newPassword } });
    } catch (err) { next(err); }
  }
);

// PATCH /api/admin/users/:id — change role or deactivate
router.patch('/users/:id',
  [
    param('id').isUUID(),
    body('role').optional().isIn(['admin', 'user']),
    body('active').optional().isBoolean(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const fields = [];
      const values = [];
      let idx = 1;

      if (req.body.role !== undefined) { fields.push(`role = $${idx++}`); values.push(req.body.role); }
      // Deactivate = set a very old password hash so login fails but record is preserved
      if (req.body.active === false) { fields.push(`password_hash = $${idx++}`); values.push('DEACTIVATED'); }

      if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });
      fields.push(`updated_at = NOW()`);
      values.push(req.params.id);

      const result = await pool.query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, email, role`,
        values
      );
      res.json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// ACTIVITY LOGS PER CLIENT
// ─────────────────────────────────────────────

// GET /api/admin/clients/:id/logs
router.get('/clients/:id/logs',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
      const result = await pool.query(
        `SELECT id, agent, action, target_type, target_id, metadata, created_at
         FROM logs WHERE client_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [req.params.id, limit]
      );
      res.json({ data: result.rows, meta: { total: result.rows.length } });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// CREDENTIALS STATUS PER CLIENT
// ─────────────────────────────────────────────

// GET /api/admin/clients/:id/credentials — show which API keys are configured (masked)
router.get('/clients/:id/credentials',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT key, updated_at FROM credentials WHERE client_id = $1`,
        [req.params.id]
      );

      // Return key names + last updated — never expose values
      const configured = {};
      for (const row of result.rows) {
        configured[row.key] = { configured: true, updated_at: row.updated_at };
      }

      const expected = ['apollo_api_key', 'hunter_api_key', 'gmail_refresh_token'];
      for (const k of expected) {
        if (!configured[k]) configured[k] = { configured: false, updated_at: null };
      }

      res.json({ data: configured });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// SIGNUP LINKS
// ─────────────────────────────────────────────

// POST /api/admin/clients/:id/signup-link — generate one-time invite link
router.post('/clients/:id/signup-link',
  [
    param('id').isUUID(),
    body('role').optional().isIn(['admin', 'user']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const token = await createSignupToken(req.params.id, req.user.userId, req.body.role || 'admin');
      const baseUrl = process.env.APP_URL || 'https://dam.beaver.solutions';
      res.json({ data: { url: `${baseUrl}/join?token=${token}` } });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// ACCESS CODES
// ─────────────────────────────────────────────

// POST /api/admin/access-codes/generate
router.post('/access-codes/generate',
  [body('client_id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const code = generateAccessCode();
      const result = await pool.query(
        `INSERT INTO access_codes (client_id, code) VALUES ($1, $2) RETURNING *`,
        [req.body.client_id, code]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// DELETE /api/admin/access-codes/:id — revoke
router.delete('/access-codes/:id', async (req, res, next) => {
  try {
    await pool.query(`UPDATE access_codes SET revoked = true WHERE id = $1`, [req.params.id]);
    res.json({ data: { revoked: true } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
// LEGACY — keep for backward compat
// ─────────────────────────────────────────────

// GET /api/admin/users — list users for the authenticated client (own team)
router.get('/users', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, email_verified, created_at FROM users WHERE client_id = $1 ORDER BY created_at ASC`,
      [req.clientId]
    );
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) { next(err); }
});

module.exports = router;
