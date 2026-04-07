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
    const serperOk = !!process.env.SERPER_API_KEY;

    // Check if ENCRYPTION_KEY is valid (needed for Apollo/Hunter/Gmail)
    let encKeyOk = true;
    try {
      secrets.testEncKey();
    } catch {
      encKeyOk = false;
    }

    const [gmailConnected, apolloKey, hunterKey, calendlyRow] = await Promise.all([
      gmailService.isConnected(req.clientId),
      encKeyOk ? apolloService.getApiKey(req.clientId) : Promise.resolve(null),
      encKeyOk ? hunterService.getApiKey(req.clientId) : Promise.resolve(null),
      pool.query(
        `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'system' AND key = 'calendly_url' LIMIT 1`,
        [req.clientId]
      ),
    ]);

    let gmailEmail = null;
    if (gmailConnected) {
      gmailEmail = await gmailService.getConnectedEmail(req.clientId).catch(() => null);
    }

    let agentmailEmail = null;
    if (agentmailOk) {
      agentmailEmail = await agentmailService.getInboxEmail(req.clientId).catch(() => null);
    }

    const calendlyContent = calendlyRow.rows[0]?.content;
    const calendlyUrl = calendlyContent
      ? (typeof calendlyContent === 'string' ? JSON.parse(calendlyContent) : calendlyContent)?.url
      : null;

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
          label: !encKeyOk ? 'Encryption key error' : apolloKey ? 'Connected' : 'Not configured',
        },
        hunter: {
          connected: !!hunterKey,
          label: !encKeyOk ? 'Encryption key error' : hunterKey ? 'Connected' : 'Not configured',
        },
        serper: {
          connected: serperOk,
          label: serperOk ? 'Connected (env var)' : 'SERPER_API_KEY not set',
        },
        calendly: {
          connected: !!calendlyUrl,
          url: calendlyUrl || null,
          label: calendlyUrl ? calendlyUrl.replace('https://calendly.com/', '@') : 'Not connected',
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
  // Use a transaction with FOR UPDATE to prevent duplicate sends under concurrent requests.
  // The atomic status flip from 'approved' → 'sent' ensures only one request can win.
  const db = await pool.connect();
  let message;
  try {
    await db.query('BEGIN');

    const msgRes = await db.query(
      `SELECT m.*, l.email as lead_email, l.name as lead_name
       FROM messages m
       LEFT JOIN leads l ON l.id = m.lead_id
       WHERE m.id = $1 AND m.client_id = $2
       FOR UPDATE OF m`,
      [message_id, clientId]
    );

    if (msgRes.rows.length === 0) {
      await db.query('ROLLBACK');
      db.release();
      const err = new Error('Message not found');
      err.status = 404;
      throw err;
    }

    message = msgRes.rows[0];
    if (message.status === 'sent') {
      await db.query('ROLLBACK');
      db.release();
      const err = new Error('Message already sent');
      err.status = 409;
      throw err;
    }
    if (message.status !== 'approved') {
      await db.query('ROLLBACK');
      db.release();
      const err = new Error('Message must be approved before sending');
      err.status = 400;
      throw err;
    }

    // Block send if no real email — check INSIDE transaction before status flip
    if (!message.lead_email || message.lead_email === 'unknown@example.com') {
      await db.query('ROLLBACK');
      db.release();
      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'email_blocked',
        target_type: 'message',
        target_id: message_id,
        metadata: { lead_name: message.lead_name, reason: 'no_email' },
      });
      const err = new Error('No email address for this lead. Find their email before sending.');
      err.status = 400;
      err.code = 'NO_EMAIL';
      throw err;
    }

    // Reserve the message atomically — prevents a second concurrent request from also sending
    await db.query(
      `UPDATE messages SET status = 'pending_send', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
      [message_id, clientId]
    );

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch {}
    db.release();
    throw err;
  }
  db.release();

  // Pick provider
  let sendResult;
  let usedProvider = provider;

  try {
    if (provider === 'auto') {
      const gmailOk = await gmailService.isConnected(clientId);
      const agentmailOk = agentmailService.isConnected();
      usedProvider = gmailOk ? 'gmail' : agentmailOk ? 'agentmail' : 'none';
    }

    const emailPayload = {
      to: message.lead_email,
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
  } catch (err) {
    // Unexpected send error — revert status so the message can be retried
    await pool.query(
      `UPDATE messages SET status = 'approved', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
      [message_id, clientId]
    );
    throw err;
  }

  // Simulated sends — revert to approved, do NOT advance lead or schedule follow-ups
  if (sendResult.status === 'simulated') {
    await pool.query(
      `UPDATE messages SET status = 'approved', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
      [message_id, clientId]
    );
    await logsService.createLog(clientId, {
      agent: 'system',
      action: 'email_simulated',
      target_type: 'message',
      target_id: message_id,
      metadata: { to: message.lead_email, lead_name: message.lead_name, provider: 'none', reason: sendResult.reason },
    });
    return { status: 'simulated', message_id, provider: 'none', reason: sendResult.reason };
  }

  // Failed sends — revert to approved so user can retry
  if (sendResult.status === 'failed') {
    await pool.query(
      `UPDATE messages SET status = 'approved', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
      [message_id, clientId]
    );
    await logsService.createLog(clientId, {
      agent: 'system',
      action: 'email_failed',
      target_type: 'message',
      target_id: message_id,
      metadata: { to: message.lead_email, lead_name: message.lead_name, provider: usedProvider, reason: sendResult.reason },
    });
    return { status: 'failed', message_id, provider: usedProvider, reason: sendResult.reason };
  }

  // Real send — persist result and advance pipeline
  if (usedProvider === 'agentmail') {
    await pool.query(
      `UPDATE messages
       SET status = 'sent', sent_at = NOW(), updated_at = NOW(),
           agentmail_message_id = $3, agentmail_thread_id = $4
       WHERE id = $1 AND client_id = $2`,
      [message_id, clientId, sendResult.messageId, sendResult.threadId]
    );
  } else {
    await pool.query(
      `UPDATE messages
       SET status = 'sent', sent_at = NOW(), updated_at = NOW(),
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
    action: 'email_sent',
    target_type: 'message',
    target_id: message_id,
    metadata: { to: message.lead_email, lead_name: message.lead_name, provider: usedProvider, send_result: sendResult },
  });

  // Schedule follow-ups if this is the first message sent to this lead
  try {
    const { rows: prevSent } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM messages
       WHERE lead_id = $1 AND status = 'sent'`,
      [message.lead_id]
    );
    if (parseInt(prevSent[0].cnt) === 1) {
      const { scheduleFollowUps } = require('../services/followupSequence');
      await scheduleFollowUps(clientId, message.lead_id, new Date());
    }
  } catch (err) {
    console.warn('[integrations] Follow-up scheduling failed:', err.message);
  }

  return { status: 'sent', message_id, thread_id: sendResult.threadId, provider: usedProvider };
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
    } catch (err) {
      if (err.message?.includes('ENCRYPTION_KEY')) {
        return res.status(500).json({ error: 'Server encryption key is misconfigured. Check ENCRYPTION_KEY env var.', code: 'ENCRYPTION_KEY_INVALID' });
      }
      next(err);
    }
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
    } catch (err) {
      if (err.message?.includes('ENCRYPTION_KEY')) {
        return res.status(500).json({ error: 'Server encryption key is misconfigured. Check ENCRYPTION_KEY env var.', code: 'ENCRYPTION_KEY_INVALID' });
      }
      next(err);
    }
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

/* ─── Calendly ───────────────────────────────────────────── */

router.get('/calendly', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT content FROM agent_memory
       WHERE client_id = $1 AND agent = 'system' AND key = 'calendly_url' LIMIT 1`,
      [req.clientId]
    );
    const row = result.rows[0];
    const url = row ? (typeof row.content === 'string' ? JSON.parse(row.content) : row.content)?.url : null;
    res.json({ data: { connected: !!url, url: url || null } });
  } catch (err) { next(err); }
});

router.post('/calendly',
  [body('url').isURL({ protocols: ['https'], require_protocol: true }), validate],
  async (req, res, next) => {
    try {
      const content = JSON.stringify({ url: req.body.url });
      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
         VALUES ($1, 'system', 'config', 'calendly_url', $2)
         ON CONFLICT (client_id, agent, key)
         DO UPDATE SET content = $2, updated_at = NOW()`,
        [req.clientId, content]
      );
      await logsService.createLog(req.clientId, {
        agent: 'system', action: 'calendly_connected', target_type: 'integration',
        metadata: { url: req.body.url },
      });
      res.json({ data: { connected: true, url: req.body.url } });
    } catch (err) { next(err); }
  }
);

router.delete('/calendly', async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM agent_memory WHERE client_id = $1 AND agent = 'system' AND key = 'calendly_url'`,
      [req.clientId]
    );
    res.json({ data: { connected: false, url: null } });
  } catch (err) { next(err); }
});

/* ─── Calendar (stub) ────────────────────────────────────── */

router.post('/calendar/create-event', (req, res) => {
  res.json({ data: { status: 'not_configured', message: 'Calendar sync coming soon' } });
});

module.exports = router;
