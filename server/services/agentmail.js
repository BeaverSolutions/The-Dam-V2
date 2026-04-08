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

async function getOrCreateInbox(clientId, clientSlug) {
  // Check if already stored in agent_memory
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'sales_beaver' AND key = 'agentmail_inbox'
     LIMIT 1`,
    [clientId]
  );

  if (rows.length && rows[0].content?.inbox_id) {
    return rows[0].content;
  }

  // Create a new inbox via SDK
  const client = getClient();
  const username = `${(clientSlug || 'beaver')}-sales`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30);

  const inbox = await client.inboxes.create({
    username,
    displayName: 'Sales Beaver',
  });

  const inboxData = {
    inbox_id: inbox.inboxId,
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
    const inboxData = await getOrCreateInbox(clientId, clientSlug || 'beaver');
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
    const inboxData = await getOrCreateInbox(clientId, 'beaver').catch(() => null);
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
  getOrCreateInbox,
  getInboxEmail,
  sendEmail,
  registerWebhook,
  getThread,
  disconnect,
};
