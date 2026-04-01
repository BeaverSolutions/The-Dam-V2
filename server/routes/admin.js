'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const { generateAccessCode } = require('../services/auth');

// GET /api/admin/users — list users for the authenticated client
router.get('/users', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, role, email_verified, created_at FROM users WHERE client_id = $1 ORDER BY created_at ASC`,
      [req.clientId]
    );
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) { next(err); }
});

// POST /api/admin/invite — invite a new team member
router.post('/invite',
  [
    body('email').isEmail().normalizeEmail(),
    body('role').isIn(['admin', 'user']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { email, role } = req.body;

      // Check if user already exists
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'A user with that email already exists', code: 'EMAIL_TAKEN' });
      }

      // Create user with a temporary password
      const tempPassword = `Dam${Math.random().toString(36).slice(2, 8).toUpperCase()}!`;
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const userRes = await pool.query(
        `INSERT INTO users (client_id, email, password_hash, role, email_verified)
         VALUES ($1, $2, $3, $4, true) RETURNING id, email, role, created_at`,
        [req.clientId, email, passwordHash, role]
      );

      // Generate an access code for them
      const code = generateAccessCode();
      await pool.query(
        `INSERT INTO access_codes (client_id, code) VALUES ($1, $2)`,
        [req.clientId, code]
      );

      res.status(201).json({
        data: {
          user: userRes.rows[0],
          temp_password: tempPassword,
          access_code: code,
          message: 'Share the temporary password and access code with your new team member.',
        },
      });
    } catch (err) { next(err); }
  }
);

// GET /api/admin/clients
router.get('/clients', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT c.*, COUNT(u.id) as user_count
       FROM clients c LEFT JOIN users u ON u.client_id = c.id
       GROUP BY c.id ORDER BY c.created_at DESC`
    );
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) { next(err); }
});

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

// DELETE /api/admin/access-codes/:id
router.delete('/access-codes/:id', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE access_codes SET revoked = true WHERE id = $1`,
      [req.params.id]
    );
    res.json({ data: { revoked: true } });
  } catch (err) { next(err); }
});

// GET /api/admin/devices/:clientId
router.get('/devices/:clientId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ad.*, ac.code FROM authorised_devices ad
       JOIN access_codes ac ON ac.id = ad.code_id
       WHERE ad.client_id = $1 ORDER BY ad.created_at DESC`,
      [req.params.clientId]
    );
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) { next(err); }
});

module.exports = router;
