'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const config = require('../config');
const { AppError } = require('../utils/errors');

function generateToken(user) {
  return jwt.sign(
    { userId: user.id, clientId: user.client_id, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateAccessCode() {
  const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `BEAVER-${segment()}-${segment()}`;
}

async function signup({ email, password, name }) {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const verificationCode = generateVerificationCode();

  const clientResult = await pool.query(
    `INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`,
    [name || email.split('@')[0], email]
  );
  const clientId = clientResult.rows[0].id;

  const userResult = await pool.query(
    `INSERT INTO users (client_id, email, password_hash, role, verification_code)
     VALUES ($1, $2, $3, 'admin', $4) RETURNING id, client_id, role, email`,
    [clientId, email, passwordHash, verificationCode]
  );
  const user = userResult.rows[0];

  const token = generateToken(user);
  return { token, user: { id: user.id, email: user.email, role: user.role, clientId } };
}

async function login({ email, password }) {
  const result = await pool.query(
    `SELECT u.id, u.client_id, u.email, u.password_hash, u.role, u.email_verified, u.display_name,
            c.name as client_name
     FROM users u JOIN clients c ON c.id = u.client_id
     WHERE u.email = $1`,
    [email]
  );
  if (result.rows.length === 0) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  const token = generateToken(user);
  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.display_name || null,
      role: user.role,
      clientId: user.client_id,
      emailVerified: user.email_verified,
      client: { id: user.client_id, name: user.client_name },
    },
  };
}

async function verifyEmail({ email, code }) {
  const result = await pool.query(
    `UPDATE users SET email_verified = true, verification_code = NULL, updated_at = NOW()
     WHERE email = $1 AND verification_code = $2
     RETURNING id`,
    [email, code]
  );
  if (result.rows.length === 0) {
    throw new AppError('Invalid or expired verification code', 400, 'INVALID_CODE');
  }
  return { verified: true };
}

async function verifyAccessCode({ code, deviceFingerprint, userAgent }) {
  const codeResult = await pool.query(
    `SELECT * FROM access_codes WHERE code = $1 AND revoked = false`,
    [code]
  );
  if (codeResult.rows.length === 0) {
    throw new AppError('Invalid or revoked access code', 401, 'INVALID_ACCESS_CODE');
  }
  const accessCode = codeResult.rows[0];

  const existing = await pool.query(
    `SELECT id FROM authorised_devices WHERE code_id = $1 AND device_fingerprint = $2`,
    [accessCode.id, deviceFingerprint]
  );
  if (existing.rows.length > 0) {
    return { alreadyAuthorised: true };
  }

  await pool.query(
    `INSERT INTO authorised_devices (code_id, client_id, device_fingerprint, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [accessCode.id, accessCode.client_id, deviceFingerprint, userAgent]
  );

  await pool.query(
    `UPDATE access_codes SET used = true WHERE id = $1`,
    [accessCode.id]
  );

  return { success: true, clientId: accessCode.client_id };
}

async function getMe(userId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.role, u.email_verified, u.created_at, u.display_name,
            c.id as client_id, c.name as client_name, c.plan, c.onboarding_completed
     FROM users u JOIN clients c ON c.id = u.client_id
     WHERE u.id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    throw new AppError('User not found', 404, 'NOT_FOUND');
  }
  const row = result.rows[0];
  return {
    id: row.id,
    email: row.email,
    name: row.display_name || null,
    role: row.role,
    emailVerified: row.email_verified,
    createdAt: row.created_at,
    client: {
      id: row.client_id,
      name: row.client_name,
      plan: row.plan,
      onboardingCompleted: row.onboarding_completed,
    },
  };
}

async function updateProfile(userId, { display_name }) {
  const result = await pool.query(
    `UPDATE users SET display_name = $1, updated_at = NOW()
     WHERE id = $2 RETURNING id, email, display_name`,
    [display_name?.trim() || null, userId]
  );
  return result.rows[0];
}

module.exports = { signup, login, verifyEmail, verifyAccessCode, getMe, updateProfile, generateToken, generateAccessCode };
