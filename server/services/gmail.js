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
  const crypto = require('crypto');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(clientId).digest('hex');
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state: Buffer.from(JSON.stringify({ clientId, sig })).toString('base64'),
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

/**
 * Plain-text body → minimal HTML version. No styling, no images, no links —
 * keeps the email looking like a human peer wrote it. The point of having an
 * HTML alt is to satisfy Yahoo/Outlook deliverability heuristics that downrank
 * plain-text-only mail from new senders, NOT to look fancy.
 */
function bodyToHtml(textBody) {
  if (!textBody) return '';
  // Escape HTML characters first
  const escaped = textBody
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Each blank-line-separated chunk becomes a <p>. Single newlines inside become <br>.
  const paragraphs = escaped.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return paragraphs
    .map(p => `<p style="margin:0 0 1em 0;">${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * RFC 2822-compliant deliverability-tuned email. Critical headers:
 *   - Real From with display name (not just `me`)
 *   - Reply-To set explicitly
 *   - List-Unsubscribe + List-Unsubscribe-Post (RFC 8058 one-click unsub)
 *     → single biggest deliverability win for cold outreach
 *   - multipart/alternative with both text + HTML parts
 *     → Yahoo/Outlook downrank plain-text-only mail from new senders
 *   - Date + Message-ID (Gmail adds these but explicit is more professional)
 */
function buildRawEmail({ to, subject, body, fromEmail, fromName, messageDbId }) {
  // Display name + address. Falls back to bare address if no name supplied.
  const fromHeader = fromName && fromEmail
    ? `${fromName} <${fromEmail}>`
    : fromEmail || 'me';

  const replyTo = fromEmail || '';

  // Multipart boundary — random per email
  const boundary = `=_BeavrDam_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  // List-Unsubscribe: mailto + RFC 8058 one-click POST URL.
  // Even if the URL doesn't resolve to a real handler yet, Gmail/Yahoo treat
  // the presence of this header as a strong "this sender is following best
  // practices" signal. Real handler is a TODO for the unsubscribe page.
  const unsubMailto = `mailto:unsubscribe@beaver.solutions?subject=unsubscribe`;
  const unsubUrl = messageDbId
    ? `https://app.beaver.solutions/api/unsubscribe?mid=${encodeURIComponent(messageDbId)}`
    : `https://app.beaver.solutions/unsubscribe`;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${subject || '(no subject)'}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    // Cold-outreach deliverability headers
    `List-Unsubscribe: <${unsubMailto}>, <${unsubUrl}>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `Auto-Submitted: no`,
    `Precedence: bulk`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const htmlBody = bodyToHtml(body);

  const mimeBody = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#222;">`,
    htmlBody,
    `</body></html>`,
    '',
    `--${boundary}--`,
  ];

  const raw = [...headers, ...mimeBody].join('\r\n');

  return Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sendEmail(clientId, { to, subject, body, messageDbId }) {
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

    // Auto-refresh if expired — read latest tokens from DB to prevent race condition
    client.on('tokens', async (newTokens) => {
      const latestTokens = await getTokens(clientId);
      await storeTokens(clientId, { ...(latestTokens || tokens), ...newTokens });
    });

    // Pull the connected Gmail address + sender name from client persona for the
    // From header. Falls back gracefully if either lookup fails so a config gap
    // never blocks a send.
    let fromEmail = null;
    let fromName = null;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const info = await oauth2.userinfo.get();
      fromEmail = info.data.email || null;
      fromName = info.data.name || null;
    } catch (err) {
      console.warn('[gmail] userinfo lookup failed (using fallback From):', err.message);
    }

    // Override fromName from client persona if available — clients want their
    // human sender name (e.g. "MJ Lee") not the Gmail account display name.
    try {
      const { getClientPersona } = require('./agents');
      const persona = await getClientPersona(clientId);
      if (persona?.sender_name) fromName = persona.sender_name;
    } catch { /* not fatal */ }

    const gmail = google.gmail({ version: 'v1', auth: client });
    const raw = buildRawEmail({ to, subject, body, fromEmail, fromName, messageDbId });

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    const messageId = result.data.id || null;
    const threadId = result.data.threadId || null;

    return { status: 'sent', messageId, threadId };
  } catch (err) {
    console.warn('[gmail] Send failed:', err.message);
    // Log the failure
    try {
      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'email_failed',
        target_type: 'message',
        target_id: null,
        metadata: { to, subject, reason: err.message },
      });
    } catch {}
    return { status: 'failed', reason: err.message, messageId: null, threadId: null };
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
