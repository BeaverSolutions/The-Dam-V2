'use strict';

const logsService = require('./logs');
const secrets = require('./secrets');

let google;
try {
  google = require('googleapis').google;
} catch {
  // googleapis not installed — all sends will simulate
}

/* ─── OAuth client ───────────────────────────────────────── */

function getOAuthClient() {
  if (!google) return null;
  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/integrations/gmail/callback'
  );
}

function getAuthUrl(clientId) {
  const client = getOAuthClient();
  if (!client) return null;
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state: Buffer.from(JSON.stringify({ clientId })).toString('base64'),
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
}

/* ─── Token storage (via secrets service) ────────────────── */

async function storeTokens(clientId, tokens) {
  await secrets.setClientSecret(clientId, 'system', 'gmail_tokens', tokens);
}

async function getTokens(clientId) {
  return secrets.getClientSecret(clientId, 'system', 'gmail_tokens');
}

async function isConnected(clientId) {
  const tokens = await getTokens(clientId);
  return !!tokens;
}

/**
 * Return the email address associated with connected Gmail account.
 */
async function getConnectedEmail(clientId) {
  if (!google) return null;
  const tokens = await getTokens(clientId);
  if (!tokens) return null;
  try {
    const client = getOAuthClient();
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const info = await oauth2.userinfo.get();
    return info.data.email || null;
  } catch {
    return null;
  }
}

async function disconnect(clientId) {
  await secrets.deleteClientSecret(clientId, 'system', 'gmail_tokens');
}

/* ─── Exchange auth code ─────────────────────────────────── */

async function exchangeCode(clientId, code) {
  const client = getOAuthClient();
  if (!client) throw new Error('Gmail OAuth not configured');
  const { tokens } = await client.getToken(code);
  await storeTokens(clientId, tokens);
  return tokens;
}

/* ─── Send email ─────────────────────────────────────────── */

function buildRawEmail({ to, subject, body, fromEmail }) {
  const from = fromEmail ? `me <${fromEmail}>` : 'me';
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject || '(no subject)'}`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  return Buffer.from(lines.join('\r\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail(clientId, { to, subject, body }) {
  if (!google) {
    console.warn('[gmail] googleapis not installed — simulating send');
    return { status: 'simulated', reason: 'googleapis_not_installed', messageId: null, threadId: null };
  }

  const tokens = await getTokens(clientId);
  if (!tokens) {
    console.warn('[gmail] No Gmail tokens for client — simulating send');
    return { status: 'simulated', reason: 'not_connected', messageId: null, threadId: null };
  }

  try {
    const client = getOAuthClient();
    client.setCredentials(tokens);

    // Auto-refresh if expired
    client.on('tokens', async (newTokens) => {
      await storeTokens(clientId, { ...tokens, ...newTokens });
    });

    const gmail = google.gmail({ version: 'v1', auth: client });
    const raw = buildRawEmail({ to, subject, body });

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    const messageId = result.data.id || null;
    const threadId = result.data.threadId || null;

    return { status: 'sent', messageId, threadId };
  } catch (err) {
    console.warn('[gmail] Send failed:', err.message);
    return { status: 'simulated', reason: err.message, messageId: null, threadId: null };
  }
}

/**
 * Fetch a Gmail thread and return its messages.
 */
async function getThread(clientId, threadId) {
  if (!google) return null;
  const tokens = await getTokens(clientId);
  if (!tokens) return null;
  try {
    const client = getOAuthClient();
    client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'metadata' });
    return res.data;
  } catch (err) {
    console.warn('[gmail] getThread failed:', err.message);
    return null;
  }
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getTokens,
  isConnected,
  getConnectedEmail,
  disconnect,
  sendEmail,
  storeTokens,
  getThread,
};
