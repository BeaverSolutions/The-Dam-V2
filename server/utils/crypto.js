'use strict';

const crypto = require('crypto');
const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string');
  }
  return Buffer.from(key, 'hex');
}

function encrypt(text) {
  if (!text) throw new Error('Cannot encrypt empty value');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedText) {
  if (!encryptedText) throw new Error('Cannot decrypt empty value');
  const parts = encryptedText.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted text format');
  const [ivHex, authTagHex, encrypted] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Timing-safe string comparison for secrets, HMAC signatures, API keys.
 * Returns false if either value is missing.
 */
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Return the secret used to sign OAuth state parameters.
 * Prefers OAUTH_STATE_SECRET (dedicated) and falls back to JWT_SECRET for
 * backward compatibility so existing deployments keep working until the new
 * env var is set. Using a separate secret means a JWT-secret leak does not
 * let an attacker forge OAuth callback state (and vice versa).
 */
function getOAuthStateSecret() {
  return process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET;
}

/**
 * Sign a client_id (and optional type) for inclusion in an OAuth state parameter.
 * Returns hex HMAC. The optional `type` binds the signature to a specific flow
 * (e.g. 'gmail' or 'calendar'), preventing an attacker from reusing a signed
 * state across flows. Callers that don't pass type keep the pre-existing
 * signing behavior for backward compatibility.
 */
function signOAuthState(clientId, type) {
  const payload = type ? `${clientId}|${type}` : String(clientId);
  return crypto.createHmac('sha256', getOAuthStateSecret()).update(payload).digest('hex');
}

/**
 * Verify an OAuth state signature against a clientId (and optional type).
 * Timing-safe. Must be called with the same `type` that was used when signing.
 */
function verifyOAuthState(clientId, sig, type) {
  if (!clientId || !sig) return false;
  const expected = signOAuthState(clientId, type);
  return safeCompare(sig, expected);
}

module.exports = { encrypt, decrypt, safeCompare, signOAuthState, verifyOAuthState };
