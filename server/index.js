'use strict';
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const { runMigrations } = require('./db/migrate');
const { runSeed } = require('./db/seed');
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const authMiddleware = require('./middleware/auth');
const tenantScope = require('./middleware/tenantScope');
const { clientContext } = require('./middleware/clientContext');
const rateLimiter = require('./middleware/rateLimiter');
const pool = require('./db/pool');
const adminOnly = require('./middleware/adminOnly');
const superAdminOnly = require('./middleware/superAdminOnly');
const config = require('./config');

const app = express();

// Trust Railway / Render / Heroku reverse proxy so rate-limiter sees real client IPs
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  // Allow serving the React app's static assets
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
}));

// CORS
const corsOrigins = process.env.NODE_ENV === 'production'
  ? [
      process.env.FRONTEND_URL,
      'https://beaver.solutions',
      'https://www.beaver.solutions',
    ].filter(Boolean)
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:3001'];

app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Webhook routes — registered BEFORE JSON body parser (need raw body)
app.use('/api/webhooks', require('./routes/webhooks'));

// Body parsing + cookies
app.use(express.json({ limit: '10kb' }));
app.use(require('cookie-parser')());

// Rate limiting on all API routes
app.use('/api', rateLimiter);

// Telegram webhook — no JWT, verified by bot secret token
app.use('/api/telegram', require('./routes/telegram'));

// Routes - public (no auth)
app.use('/api/auth', require('./routes/auth'));

// Gmail OAuth callback — public (no auth, clientId from HMAC-signed state param)
app.get('/api/integrations/gmail/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.redirect(`${frontendUrl}/settings?gmail=error`);
    let clientId;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      clientId = decoded?.clientId;
      const sig = decoded?.sig;
      if (!clientId || typeof clientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('invalid');
      // Verify HMAC signature to prevent state tampering
      const crypto = require('crypto');
      const { safeCompare } = require('./utils/crypto');
      const expectedSig = crypto.createHmac('sha256', config.jwt.secret).update(clientId).digest('hex');
      if (!safeCompare(sig, expectedSig)) throw new Error('invalid signature');
    } catch {
      return res.redirect(`${frontendUrl}/settings?gmail=error`);
    }
    const gmailService = require('./services/gmail');
    await gmailService.exchangeCode(clientId, code);
    res.redirect(`${frontendUrl}/settings?gmail=connected`);
  } catch {
    res.redirect(`${frontendUrl}/settings?gmail=error`);
  }
});

// Routes - protected
// clientContext must come AFTER tenantScope so req.clientId is populated;
// it binds an AsyncLocalStorage context so services (e.g. services/claude.js)
// can attribute work to the correct tenant without threading clientId through
// every function call.
app.use('/api/leads',        authMiddleware, tenantScope, clientContext, require('./routes/leads'));
app.use('/api/messages',     authMiddleware, tenantScope, clientContext, require('./routes/messages'));
app.use('/api/approvals',    authMiddleware, tenantScope, clientContext, require('./routes/approvals'));
app.use('/api/logs',         authMiddleware, tenantScope, clientContext, require('./routes/logs'));
app.use('/api/calendar',     authMiddleware, tenantScope, clientContext, require('./routes/calendar'));
app.use('/api/agents',       authMiddleware, tenantScope, clientContext, require('./routes/agents'));
app.use('/api/integrations', authMiddleware, tenantScope, clientContext, require('./routes/integrations'));
app.use('/api/dashboard',    authMiddleware, tenantScope, clientContext, require('./routes/dashboard'));
app.use('/api/import',       authMiddleware, tenantScope, clientContext, require('./routes/import'));

// Autonomous routes — internal key auth (no JWT required).
// Background tasks spawned by this router MUST wrap their work in
// runWithClientContext(clientId, ...) so Claude calls get attributed.
app.use('/api/autonomous', require('./routes/autonomous'));

// Captain Beaver external API — token auth (MYCLAW_HOOK_TOKEN), no JWT required.
// Used by OpenClaw integration for approvals, memory, leads, etc.
const captainRoutes = require('./routes/myclaw');
app.use('/api/captain', captainRoutes);
app.use('/api/myclaw', captainRoutes);  // backward compat

// Routes - super admin only (Beaver Solutions)
app.use('/api/admin', authMiddleware, tenantScope, clientContext, superAdminOnly, require('./routes/admin'));

// Health check — includes env diagnostics so Railway logs show what's misconfigured
app.get('/health', (req, res) => {
  let encKeyOk = false;
  try { require('./services/secrets').testEncKey(); encKeyOk = true; } catch {}
  res.json({
    status: 'ok',
    version: '2.0.0',
    tag: 'Autonomous',
    timestamp: new Date().toISOString(),
    env: {
      encryption_key: encKeyOk ? 'valid' : 'INVALID',
      brave: process.env.BRAVE_API_KEY ? 'set' : 'missing',
      anthropic: process.env.ANTHROPIC_API_KEY ? 'set' : 'missing',
      gmail_oauth: process.env.GMAIL_CLIENT_ID ? 'set' : 'missing',
    },
  });
});

// Serve React frontend in production (must come AFTER all API routes)
if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, '../client/dist');
  app.use(express.static(clientBuildPath));

  // Catch-all: serve React app for any non-API route (client-side routing)
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path === '/api') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
}

// Global error handler (must be last)
app.use(errorHandler);

async function start() {
  try {
    logger.info({ msg: 'Running database migrations...' });
    await runMigrations();
    logger.info({ msg: 'Running seed data...' });
    await runSeed();

    // Validate ENCRYPTION_KEY at startup (non-fatal but logs clearly)
    try {
      require('./services/secrets').testEncKey();
      logger.info({ msg: 'ENCRYPTION_KEY validated OK' });
    } catch (err) {
      logger.error({ msg: `ENCRYPTION_KEY INVALID: ${err.message}` });
      logger.error({ msg: 'Hunter/Apollo/Gmail integrations will NOT work until this is fixed' });
    }

    app.listen(config.port, () => {
      logger.info({ msg: `BeavrDam API running on port ${config.port}`, env: config.nodeEnv });
    });

    // Pre-warm client config cache (reads clients/<slug>/config.md for each client)
    require('./services/clientConfig').warmCache().catch(() => {});

    // Discord bot
    const { startDiscordBot, notifyDiscordPendingApprovals, postDiscordAlert } = require('./services/discordBot');
    await startDiscordBot().catch(err => {
      logger.error({ msg: 'Discord bot startup failed', err: err.message, stack: err.stack });
      // bot may be partially up on retry — best-effort alert, silently no-ops if client is null
      postDiscordAlert('Discord bot startup', err.message).catch(() => {});
    });

    // Reply detection + Discord approvals notify — poll every 5 minutes
    const { checkAllClients } = require('./services/replyDetector');
    setInterval(() => {
      checkAllClients().catch(err => {
        logger.warn({ msg: 'Reply detector error', err: err.message });
        postDiscordAlert('reply polling', err.message).catch(() => {});
      });
      notifyDiscordPendingApprovals().catch(err => {
        logger.warn({ msg: 'Discord approvals notify error', err: err.message });
        postDiscordAlert('approvals polling', err.message).catch(() => {});
      });
    }, 5 * 60 * 1000);
    logger.info({ msg: 'Reply detector + Discord approvals polling started (5 min interval)' });

    // Send queue worker — auto-sends approved messages, retries on failure
    const { processSendQueue } = require('./services/sendQueueWorker');
    setInterval(() => {
      processSendQueue().catch(err => {
        logger.warn({ msg: 'Send queue worker error', err: err.message });
      });
    }, 60 * 1000); // Every 60 seconds
    logger.info({ msg: 'Send queue worker started (60s interval)' });

    // Follow-up scheduler — checks for due follow-ups every 30 minutes
    // Independent of n8n so follow-ups never get missed even if external scheduler is down.
    const { runWithClientContext } = require('./middleware/clientContext');
    const { getDueFollowUps, draftFollowUp } = require('./services/followupSequence');
    const { rangerReview } = require('./services/agents');
    const { enqueueMessage } = require('./services/sendQueueWorker');
    let _followUpRunning = false;

    async function processFollowUps() {
      if (_followUpRunning) return;
      _followUpRunning = true;
      try {
        // Get all clients with due follow-ups
        const { rows: clients } = await pool.query(
          `SELECT DISTINCT client_id FROM followup_queue
           WHERE status = 'pending' AND scheduled_for <= CURRENT_DATE`
        );

        for (const { client_id } of clients) {
          await runWithClientContext(client_id, async () => {
            const dueFollowUps = await getDueFollowUps(client_id);
            if (dueFollowUps.length === 0) return;
            console.log(`[followup-scheduler] ${dueFollowUps.length} due follow-ups for client ${client_id}`);

            for (const fu of dueFollowUps) {
              try {
                // Get previous messages for context
                const { rows: prevMessages } = await pool.query(
                  `SELECT subject, body, metadata, channel FROM messages
                   WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved')
                   ORDER BY created_at ASC`,
                  [fu.lead_id, client_id]
                );
                const originalChannel = prevMessages[0]?.channel || 'email';

                const draft = await draftFollowUp(fu, fu.touch_number, prevMessages);
                if (!draft?.body) { console.warn(`[followup-scheduler] No draft for lead ${fu.lead_id} touch ${fu.touch_number}`); continue; }

                const cleanBody = draft.body.replace(/\s*\u2014\s*/g, ', ').replace(/\u2014/g, ' ');

                // Server-side hard gates
                const bodyText = cleanBody.replace(/^Hi\s+\w+,?\s*/i, '').replace(/\s*Regards,?\s*.*/is, '');
                const wordCount = bodyText.trim().split(/\s+/).length;
                const questionCount = (cleanBody.match(/\?/g) || []).length;
                if ((originalChannel === 'email' && wordCount > 80) || questionCount > 1 || /\u2014/.test(cleanBody)) {
                  await pool.query(`UPDATE followup_queue SET status = 'skipped' WHERE id = $1`, [fu.id]);
                  continue;
                }

                // Insert message + run Enforcer
                const { rows: [savedMsg] } = await pool.query(
                  `INSERT INTO messages (client_id, lead_id, subject, body, status, metadata, channel, follow_up_day)
                   VALUES ($1, $2, $3, $4, 'pending_ranger', $5, $6, $7) RETURNING id`,
                  [client_id, fu.lead_id, draft.subject || null, cleanBody,
                   JSON.stringify({ ...draft, is_followup: true, touch_number: fu.touch_number }),
                   originalChannel,
                   fu.touch_number === 2 ? 2 : fu.touch_number === 3 ? 5 : fu.touch_number === 4 ? 10 : fu.touch_number === 5 ? 18 : 30]
                );

                let approved = false;
                try {
                  const result = await rangerReview(client_id, { message_id: savedMsg.id, message_body: cleanBody });
                  approved = !!result?.approved;
                  await pool.query(
                    `UPDATE messages SET status = $1, ranger_score = $2, ranger_notes = $3, updated_at = NOW() WHERE id = $4`,
                    [approved ? 'pending_approval' : 'ranger_rejected', result?.score || 0, result?.notes || 'Enforcer review', savedMsg.id]
                  );
                } catch (err) {
                  await pool.query(`UPDATE messages SET status = 'ranger_rejected', ranger_notes = 'Enforcer unavailable', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
                }

                if (approved) {
                  // Auto-approve if meets threshold
                  const { rows: [clientRow] } = await pool.query(`SELECT auto_approve_threshold FROM clients WHERE id = $1`, [client_id]);
                  const score = (await pool.query(`SELECT ranger_score FROM messages WHERE id = $1`, [savedMsg.id])).rows[0]?.ranger_score || 0;
                  const threshold = clientRow?.auto_approve_threshold;
                  const autoApproved = threshold != null && score >= threshold;

                  if (autoApproved) {
                    const sendStatus = (originalChannel === 'email') ? 'pending_send' : 'approved';
                    await pool.query(`UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2`, [sendStatus, savedMsg.id]);
                    await pool.query(
                      `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at) VALUES ($1, $2, 'auto_approval', 'approved', NOW())`,
                      [client_id, savedMsg.id]
                    );
                    if (originalChannel === 'email') {
                      await enqueueMessage(client_id, savedMsg.id).catch(() => {});
                    }
                  } else {
                    await pool.query(`INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system')`, [client_id, savedMsg.id]);
                  }
                }

                await pool.query(`UPDATE followup_queue SET status = $1, message_id = $2 WHERE id = $3`, [approved ? 'sent' : 'skipped', savedMsg.id, fu.id]);
                console.log(`[followup-scheduler] Touch ${fu.touch_number} for ${fu.name}: ${approved ? 'approved' : 'rejected'}`);
              } catch (err) {
                console.error(`[followup-scheduler] Error processing follow-up ${fu.id}:`, err.message);
              }
            }
          });
        }
      } catch (err) {
        console.error('[followup-scheduler] Failed:', err.message);
      } finally {
        _followUpRunning = false;
      }
    }

    setInterval(() => { processFollowUps().catch(() => {}); }, 30 * 60 * 1000); // Every 30 minutes
    // Run once on startup after a 2-minute delay (let DB migrations complete first)
    setTimeout(() => { processFollowUps().catch(() => {}); }, 2 * 60 * 1000);
    logger.info({ msg: 'Follow-up scheduler started (30 min interval)' });
  } catch (err) {
    logger.error({ msg: 'Failed to start server', err: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
