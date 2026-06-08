'use strict';

const pool = require('../db/pool');

let AgentMailClient;
try {
  AgentMailClient = require('agentmail').AgentMailClient;
} catch {
  console.warn('[agentmail] agentmail SDK not installed');
}

/* ─── Client factory ─────────────────────────────────────── */

function getClient() {
  if (!AgentMailClient) throw new Error('agentmail SDK not installed');
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new Error('AGENTMAIL_API_KEY not set in environment');
  return new AgentMailClient({ apiKey });
}

function isConnected() {
  return !!process.env.AGENTMAIL_API_KEY && !!AgentMailClient;
}

/* ─── Inbox management (per client) ─────────────────────── */

function normalizeInboxContent(content) {
  if (!content) return null;
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;
  return parsed?.inbox_id ? parsed : null;
}

async function getStoredInbox(clientId) {
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'sales_beaver' AND key = 'agentmail_inbox'
     LIMIT 1`,
    [clientId]
  );

  return normalizeInboxContent(rows[0]?.content);
}

async function hasInbox(clientId) {
  return !!(await getStoredInbox(clientId));
}

async function getOrCreateInbox(clientId, clientSlug) {
  const existingInbox = await getStoredInbox(clientId);
  if (existingInbox) return existingInbox;

  // Create a new inbox via SDK
  const client = getClient();
  const username = `${(clientSlug || 'beaver')}-sales`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30);

  let inbox;
  try {
    inbox = await client.inboxes.create({
      username,
      displayName: 'Sales Beaver',
    });
  } catch (createErr) {
    if (createErr.statusCode === 403 || createErr.name === 'IsTakenError' || /taken|exists|already/i.test(createErr.message)) {
      const listResult = await client.inboxes.list();
      const inboxes = listResult.inboxes || listResult.data || listResult;
      inbox = (Array.isArray(inboxes) ? inboxes : []).find(i => i.username === username);
      if (!inbox) throw new Error(`Inbox username '${username}' is taken but not found via list`);
      console.log(`[agentmail] Recovered existing inbox for username '${username}'`);
    } else {
      throw createErr;
    }
  }

  const inboxData = {
    inbox_id: inbox.inboxId || inbox.inbox_id,
    email: inbox.email,
    username,
  };

  // Persist inbox in agent_memory
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, memory_type, content)
     VALUES ($1, 'sales_beaver', 'agentmail_inbox', 'config', $2)
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, JSON.stringify(inboxData)]
  );

  console.log(`[agentmail] Created inbox for client ${clientId}: ${inbox.email}`);
  return inboxData;
}

async function getInboxEmail(clientId, clientSlug) {
  const inboxData = await getOrCreateInbox(clientId, clientSlug || 'beaver');
  return inboxData.email;
}

/* ─── Send email ─────────────────────────────────────────── */

async function sendEmail(clientId, { to, subject, body, clientSlug }) {
  if (!isConnected()) {
    return { status: 'simulated', reason: 'not_configured', messageId: null, threadId: null };
  }

  try {
    const inboxData = await getStoredInbox(clientId);
    if (!inboxData) {
      return { status: 'simulated', reason: 'agentmail_inbox_not_provisioned', messageId: null, threadId: null };
    }
    const client = getClient();

    const result = await client.inboxes.messages.send(inboxData.inbox_id, {
      to,
      subject: subject || '(no subject)',
      text: body,
    });

    return {
      status: 'sent',
      messageId: result.messageId,
      threadId: result.threadId,
    };
  } catch (err) {
    console.warn('[agentmail] Send failed:', err.message);
    return { status: 'simulated', reason: err.message, messageId: null, threadId: null };
  }
}

/* ─── Webhook registration ───────────────────────────────── */

async function registerWebhook(url) {
  const client = getClient();
  const webhook = await client.webhooks.create({
    url,
    eventTypes: ['message.received'],
  });
  return webhook;
}

/* ─── Reply detection (polling fallback) ────────────────── */

async function getThread(clientId, threadId) {
  if (!isConnected()) return null;
  try {
    const inboxData = await getStoredInbox(clientId).catch(() => null);
    if (!inboxData) return null;
    const client = getClient();
    const thread = await client.inboxes.threads.get(inboxData.inbox_id, threadId);
    return thread;
  } catch (err) {
    console.warn('[agentmail] getThread failed:', err.message);
    return null;
  }
}

/* ─── Disconnect ─────────────────────────────────────────── */

async function disconnect(clientId) {
  await pool.query(
    `DELETE FROM agent_memory WHERE client_id = $1 AND agent = 'sales_beaver' AND key = 'agentmail_inbox'`,
    [clientId]
  );
}

module.exports = {
  isConnected,
  getStoredInbox,
  hasInbox,
  getOrCreateInbox,
  getInboxEmail,
  sendEmail,
  registerWebhook,
  getThread,
  disconnect,
};
