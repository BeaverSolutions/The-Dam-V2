'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const authService = require('../services/auth');
const authMiddleware = require('../middleware/auth');

// POST /api/auth/signup
router.post('/signup',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('name').optional().trim().isLength({ max: 200 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await authService.signup(req.body);
      res.status(201).json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/login
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await authService.login(req.body);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/verify-email
router.post('/verify-email',
  [
    body('email').isEmail().normalizeEmail(),
    body('code').isLength({ min: 6, max: 6 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await authService.verifyEmail(req.body);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/verify-access-code
router.post('/verify-access-code',
  [
    body('code').matches(/^BEAVER-[A-Z0-9]{4}-[A-Z0-9]{4}$/),
    body('deviceFingerprint').notEmpty(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await authService.verifyAccessCode({
        ...req.body,
        userAgent: req.headers['user-agent'],
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/refresh-token
router.post('/refresh-token', authMiddleware, async (req, res, next) => {
  try {
    const user = await authService.getMe(req.user.userId);
    const token = authService.generateToken({
      id: req.user.userId,
      client_id: req.user.clientId,
      role: req.user.role,
    });
    res.json({ data: { token, user } });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await authService.getMe(req.user.userId);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/join?token=xxx — validate invite link
router.get('/join', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required', code: 'MISSING_TOKEN' });
    const row = await authService.getSignupTokenInfo(token);
    res.json({ data: { client_name: row.client_name, role: row.role } });
  } catch (err) { next(err); }
});

// POST /api/auth/join — complete signup from invite link
router.post('/join',
  [
    body('token').notEmpty(),
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('display_name').optional().trim().isLength({ max: 100 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await authService.joinWithToken(req.body);
      res.status(201).json({ data: result });
    } catch (err) { next(err); }
  }
);

// PUT /api/auth/profile — update display name
router.put('/profile',
  authMiddleware,
  [body('display_name').optional({ nullable: true }).trim().isLength({ max: 100 }), validate],
  async (req, res, next) => {
    try {
      const result = await authService.updateProfile(req.user.userId, req.body);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/change-password
router.post('/change-password',
  authMiddleware,
  [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 8 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const bcrypt = require('bcrypt');
      const pool = require('../db/pool');
      const { AppError } = require('../utils/errors');
      const { current_password, new_password } = req.body;

      const result = await pool.query(
        `SELECT password_hash FROM users WHERE id = $1`,
        [req.user.userId]
      );
      if (result.rows.length === 0) throw new AppError('User not found', 404);

      const valid = await bcrypt.compare(current_password, result.rows[0].password_hash);
      if (!valid) throw new AppError('Current password is incorrect', 401, 'INVALID_PASSWORD');

      const newHash = await bcrypt.hash(new_password, 12);
      await pool.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [newHash, req.user.userId]
      );

      res.json({ data: { success: true, message: 'Password updated successfully' } });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
