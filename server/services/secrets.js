'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');

/* ─── AES-256-GCM helpers ────────────────────────────────── */

function getEncKey() {
  // Trim whitespace and strip surrounding quotes (common Railway copy-paste issue)
  const raw = (process.env.ENCRYPTION_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (raw.length === 64 && /^[0-9a-f]+$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const hint = raw.length === 0
    ? 'ENCRYPTION_KEY is not set'
    : raw.length !== 64
      ? `ENCRYPTION_KEY is ${raw.length} chars (need exactly 64)`
      : 'ENCRYPTION_KEY contains non-hex characters';
  throw new Error(`${hint}. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(data) {
  const buf = Buffer.from(data, 'base64');
  const iv = buf.slice(0, 16);
  const tag = buf.slice(16, 32);
  const encrypted = buf.slice(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/* ─── Public API ─────────────────────────────────────────── */

async function getClientSecret(clientId, agent, key) {
  const res = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = $2 AND key = $3 LIMIT 1`,
    [clientId, agent, key]
  );
  const enc = res.rows[0]?.content?.enc;
  if (!enc) return null;
  try {
    return JSON.parse(decrypt(enc));
  } catch {
    return null;
  }
}

async function setClientSecret(clientId, agent, key, value) {
  const enc = encrypt(JSON.stringify(value));
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, memory_type, content)
     VALUES ($1, $2, $3, 'secret', $4)
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, agent, key, JSON.stringify({ enc })]
  );
}

async function deleteClientSecret(clientId, agent, key) {
  await pool.query(
    `DELETE FROM agent_memory WHERE client_id = $1 AND agent = $2 AND key = $3`,
    [clientId, agent, key]
  );
}

/** Test if ENCRYPTION_KEY is valid — throws if not */
function testEncKey() {
  getEncKey();
}

module.exports = { getClientSecret, setClientSecret, deleteClientSecret, testEncKey };
