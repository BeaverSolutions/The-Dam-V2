'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const pool = require('../db/pool');
const logsService = require('../services/logs');
const gmailService = require('../services/gmail');
const apolloService = require('../services/apollo');
const agentmailService = require('../services/agentmail');
const hunterService = require('../services/hunter');
const secrets = require('../services/secrets');

/* ─── Integration status ─────────────────────────────────── */

router.get('/status', async (req, res, next) => {
  try {
    const agentmailOk = agentmailService.isConnected();
    const [gmailConnected, apolloKey, hunterKey] = await Promise.all([
      gmailService.isConnected(req.clientId),
      apolloService.getApiKey(req.clientId),
      hunterService.getApiKey(req.clientId),
    ]);

    let gmailEmail = null;
    if (gmailConnected) {
      gmailEmail = await gmailService.getConnectedEmail(req.clientId).catch(() => null);
    }

    let agentmailEmail = null;
    if (agentmailOk) {
      agentmailEmail = await agentmailService.getInboxEmail(req.clientId).catch(() => null);
    }

    res.json({
      data: {
        gmail: {
          connected: gmailConnected,
          email: gmailEmail,
          label: gmailConnected ? (gmailEmail || 'Connected') : 'Not connected',
        },
        agentmail: {
          connected: agentmailOk,
          email: agentmailEmail,
          label: agentmailOk ? (agentmailEmail || 'Connected') : 'Not connected',
        },
        apollo: {
          connected: !!apolloKey,
          label: apolloKey ? 'Connected' : 'Not configured',
        },
        hunter: {
          connected: !!hunterKey,
          label: hunterKey ? 'Connected' : 'Not configured',
        },
      },
    });
  } catch (err) { next(err); }
});

/* ─── Gmail OAuth ────────────────────────────────────────── */

router.get('/gmail/connect', async (req, res, next) => {
  try {
    const url = gmailService.getAuthUrl(req.clientId);
    if (!url) {
      return res.json({ data: { url: null, message: 'Gmail OAuth not configured — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI' } });
    }
    res.json({ data: { url } });
  } catch (err) { next(err); }
});

router.post('/gmail/disconnect', async (req, res, next) => {
  try {
    await gmailService.disconnect(req.clientId);
    await logsService.createLog(req.clientId, {
      agent: 'system', action: 'gmail_disconnected', target_type: 'integration', metadata: {},
    });
    res.json({ data: { status: 'disconnected' } });
  } catch (err) { next(err); }
});

/* ─── Gmail direct send (kept for direct use) ───────────── */

router.post('/gmail/send',
  [body('message_id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await sendMessageById(req.clientId, req.body.message_id, 'gmail');
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

/* ─── Unified send (auto-picks provider) ────────────────── */

router.post('/send',
  [body('message_id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await sendMessageById(req.clientId, req.body.message_id, 'auto');
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

/* ─── Internal send helper ───────────────────────────────── */

async function sendMessageById(clientId, message_id, provider) {
  const msgRes = await pool.query(
    `SELECT m.*, l.email as lead_email, l.name as lead_name
     FROM messages m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.id = $1 AND m.client_id = $2`,
    [message_id, clientId]
  );

  if (msgRes.rows.length === 0) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }

  const message = msgRes.rows[0];
  if (message.status !== 'approved') {
    const err = new Error('Message must be approved before sending');
    err.status = 400;
    throw err;
  }

  // Pick provider
  let sendResult;
  let usedProvider = provider;

  if (provider === 'auto') {
    const gmailOk = await gmailService.isConnected(clientId);
    const agentmailOk = agentmailService.isConnected();
    usedProvider = gmailOk ? 'gmail' : agentmailOk ? 'agentmail' : 'none';
  }

  const emailPayload = {
    to: message.lead_email || 'unknown@example.com',
    subject: message.subject || '(no subject)',
    body: message.body,
  };

  if (usedProvider === 'gmail') {
    sendResult = await gmailService.sendEmail(clientId, emailPayload);
  } else if (usedProvider === 'agentmail') {
    sendResult = await agentmailService.sendEmail(clientId, emailPayload);
  } else {
    sendResult = { status: 'simulated', reason: 'no_provider', messageId: null, threadId: null };
  }

  // Persist result — store IDs in provider-specific columns
  if (usedProvider === 'agentmail') {
    await pool.query(
      `UPDATE messages
       SET status = 'sent', updated_at = NOW(),
           agentmail_message_id = $3, agentmail_thread_id = $4
       WHERE id = $1 AND client_id = $2`,
      [message_id, clientId, sendResult.messageId, sendResult.threadId]
    );
  } else {
    await pool.query(
      `UPDATE messages
       SET status = 'sent', updated_at = NOW(),
           gmail_message_id = $3, gmail_thread_id = $4
       WHERE id = $1 AND client_id = $2`,
      [message_id, clientId, sendResult.messageId, sendResult.threadId]
    );
  }

  await pool.query(
    `UPDATE leads SET pipeline_stage = 'outreach', status = 'contacted', updated_at = NOW()
     WHERE id = $1 AND client_id = $2`,
    [message.lead_id, clientId]
  );

  await logsService.createLog(clientId, {
    agent: 'system',
    action: sendResult.status === 'sent' ? 'email_sent' : 'email_simulated',
    target_type: 'message',
    target_id: message_id,
    metadata: { to: message.lead_email, lead_name: message.lead_name, provider: usedProvider, send_result: sendResult },
  });

  return { status: sendResult.status, message_id, thread_id: sendResult.threadId, provider: usedProvider };
}

/* ─── AgentMail ──────────────────────────────────────────── */

router.get('/agentmail/inbox', async (req, res, next) => {
  try {
    const connected = agentmailService.isConnected();
    if (!connected) return res.json({ data: { connected: false, email: null } });
    const email = await agentmailService.getInboxEmail(req.clientId).catch(() => null);
    res.json({ data: { connected: true, email } });
  } catch (err) { next(err); }
});

router.post('/agentmail/register-webhook',
  [body('webhook_url').isURL(), validate],
  async (req, res, next) => {
    try {
      if (!agentmailService.isConnected()) {
        return res.status(400).json({ error: 'AGENTMAIL_API_KEY not configured', code: 'NOT_CONFIGURED' });
      }
      const webhook = await agentmailService.registerWebhook(req.body.webhook_url);
      await logsService.createLog(req.clientId, {
        agent: 'system', action: 'agentmail_webhook_registered', target_type: 'integration',
        metadata: { url: req.body.webhook_url },
      });
      res.json({ data: { webhook_id: webhook.id || webhook.webhookId, url: req.body.webhook_url } });
    } catch (err) { next(err); }
  }
);

router.delete('/agentmail/inbox', async (req, res, next) => {
  try {
    await agentmailService.disconnect(req.clientId);
    res.json({ data: { status: 'disconnected' } });
  } catch (err) { next(err); }
});

/* ─── Apollo.io ──────────────────────────────────────────── */

router.post('/apollo/key',
  [body('api_key').isString().trim().notEmpty(), validate],
  async (req, res, next) => {
    try {
      await secrets.setClientSecret(req.clientId, 'system', 'apollo_api_key', { key: req.body.api_key });
      await logsService.createLog(req.clientId, {
        agent: 'system', action: 'apollo_key_saved', target_type: 'integration', metadata: {},
      });
      res.json({ data: { status: 'saved' } });
    } catch (err) { next(err); }
  }
);

router.get('/apollo/status', async (req, res, next) => {
  try {
    const apiKey = await apolloService.getApiKey(req.clientId);
    res.json({ data: { connected: !!apiKey } });
  } catch (err) { next(err); }
});

router.delete('/apollo/key', async (req, res, next) => {
  try {
    await secrets.deleteClientSecret(req.clientId, 'system', 'apollo_api_key');
    res.json({ data: { status: 'removed' } });
  } catch (err) { next(err); }
});

/* ─── Hunter.io ──────────────────────────────────────────── */

router.post('/hunter/key',
  [body('api_key').isString().trim().notEmpty(), validate],
  async (req, res, next) => {
    try {
      await secrets.setClientSecret(req.clientId, 'system', 'hunter_api_key', { key: req.body.api_key });
      await logsService.createLog(req.clientId, {
        agent: 'system', action: 'hunter_key_saved', target_type: 'integration', metadata: {},
      });
      res.json({ data: { status: 'saved' } });
    } catch (err) { next(err); }
  }
);

router.get('/hunter/status', async (req, res, next) => {
  try {
    const apiKey = await hunterService.getApiKey(req.clientId);
    res.json({ data: { connected: !!apiKey } });
  } catch (err) { next(err); }
});

router.delete('/hunter/key', async (req, res, next) => {
  try {
    await secrets.deleteClientSecret(req.clientId, 'system', 'hunter_api_key');
    res.json({ data: { status: 'removed' } });
  } catch (err) { next(err); }
});

/* ─── Calendar (stub) ────────────────────────────────────── */

router.post('/calendar/create-event', (req, res) => {
  res.json({ data: { status: 'not_configured', message: 'Calendar sync coming soon' } });
});

module.exports = router;
