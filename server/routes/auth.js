'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const validate = require('../middleware/validate');
const authService = require('../services/auth');
const authMiddleware = require('../middleware/auth');

// ─── Tight rate limiters for credential endpoints ──────────────
// The global /api rateLimiter keys by (user.clientId || ip) at 100 req/min.
// That is too loose for auth endpoints — an attacker spraying from one IP
// gets 100 attempts per minute at different accounts. These per-endpoint
// limiters are stricter and key by a more specific fingerprint.

// Access code brute-force guard: 5 attempts per 15 minutes per
// (deviceFingerprint + IP). With BEAVER-XXXX-XXXX format (36^8 ~= 2.8e12
// combinations) + 5/15min rate limit, expected time to crack is geological.
const accessCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const fp = req.body?.deviceFingerprint || 'no-fp';
    return `access-code:${fp}:${req.ip}`;
  },
  message: { error: 'Too many access code attempts. Try again in 15 minutes.', code: 'ACCESS_CODE_RATE_LIMIT' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Login brute-force guard: 10 attempts per 15 minutes per (email + IP).
// Tight enough to defeat credential stuffing, loose enough that a legit
// user who forgets their password a few times is not locked out.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const email = (req.body?.email || 'no-email').toLowerCase().trim();
    return `login:${email}:${req.ip}`;
  },
  message: { error: 'Too many login attempts. Try again in 15 minutes.', code: 'LOGIN_RATE_LIMIT' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // successful login doesn't count toward the cap
});

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
  loginLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await authService.login(req.body);
      res.cookie('dam_token', result.token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 86400000, // 24h
      });
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('dam_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
  res.json({ data: { success: true } });
});

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
  accessCodeLimiter,
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
