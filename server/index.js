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
      const { verifyOAuthState } = require('./utils/crypto');
      if (!verifyOAuthState(clientId, sig)) throw new Error('invalid signature');
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

// Google Calendar OAuth callback — public (no auth, clientId from HMAC-signed state param).
// Also handles Gmail OAuth flows (routed here because only the calendar callback URI
// is whitelisted in Google Cloud Console for this OAuth client). state.type selects.
app.get('/api/integrations/calendar/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  // state.type may change the frontend redirect target — default to calendar
  let flowType = 'calendar';
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.redirect(`${frontendUrl}/settings?calendar=error`);
    let clientId;
    try {
      const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
      clientId = decoded?.clientId;
      const sig = decoded?.sig;
      flowType = decoded?.type === 'gmail' ? 'gmail' : 'calendar';
      if (!clientId || typeof clientId !== 'string' || !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('invalid');
      const { verifyOAuthState } = require('./utils/crypto');
      // Signature must match the type that was used when signing. Gmail flows
      // sign with type='gmail'; legacy/calendar flows sign without type.
      const verified = flowType === 'gmail'
        ? verifyOAuthState(clientId, sig, 'gmail')
        : verifyOAuthState(clientId, sig);
      if (!verified) throw new Error('invalid signature');
    } catch {
      return res.redirect(`${frontendUrl}/settings?${flowType}=error`);
    }
    if (flowType === 'gmail') {
      const gmailService = require('./services/gmail');
      await gmailService.exchangeCode(clientId, code);
      res.redirect(`${frontendUrl}/settings?gmail=connected`);
    } else {
      const calendarService = require('./services/googleCalendar');
      await calendarService.exchangeCode(clientId, code);
      res.redirect(`${frontendUrl}/settings?calendar=connected`);
    }
  } catch {
    res.redirect(`${frontendUrl}/settings?${flowType}=error`);
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

// Routes - super admin only (Beaver Solutions)
app.use('/api/admin', authMiddleware, tenantScope, clientContext, superAdminOnly, require('./routes/admin'));

// Health check — probes DB connectivity and returns env diagnostics.
// Returns 503 if DB is unreachable so Railway stops routing traffic to a broken instance.
app.get('/health', async (req, res) => {
  let encKeyOk = false;
  try { require('./services/secrets').testEncKey(); encKeyOk = true; } catch {}

  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch (err) {
    logger.warn({ msg: 'Health check DB probe failed', err: err.message });
  }

  const jobHealth = require('./services/jobHealth');
  const jobs = jobHealth.getStatus();
  const staleJobs = Object.entries(jobs).filter(([, v]) => v.status === 'stale').map(([k]) => k);

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status: dbOk ? (staleJobs.length > 0 ? 'degraded' : 'ok') : 'degraded',
    version: '2.0.0',
    tag: 'Autonomous',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    env: {
      database: dbOk ? 'ok' : 'unreachable',
      encryption_key: encKeyOk ? 'valid' : 'INVALID',
      brave: process.env.BRAVE_API_KEY ? 'set' : 'missing',
      anthropic: process.env.ANTHROPIC_API_KEY ? 'set' : 'missing',
      gmail_oauth: process.env.GMAIL_CLIENT_ID ? 'set' : 'missing',
      vibe_prospecting: process.env.VIBE_PROSPECTING_API_KEY ? 'set' : 'missing',
    },
    jobs,
    stale_jobs: staleJobs,
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

// Process-level safety net — log and exit cleanly so Railway restarts us
// rather than leaving a zombie process with half-initialized background jobs.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ msg: 'UNHANDLED_REJECTION', err: err.message, stack: err.stack });
  // Give logger 500ms to flush, then exit so orchestrator restarts the process
  setTimeout(() => process.exit(1), 500);
});

process.on('uncaughtException', (err) => {
  logger.error({ msg: 'UNCAUGHT_EXCEPTION', err: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 500);
});

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
    require('./services/clientConfig').warmCache().catch(err => {
      logger.warn({ msg: 'Client config cache warm failed', err: err.message });
    });

    // Discord bot
    const { startDiscordBot, notifyDiscordPendingApprovals, postDiscordAlert } = require('./services/discordBot');
    await startDiscordBot().catch(err => {
      logger.error({ msg: 'Discord bot startup failed', err: err.message, stack: err.stack });
      // bot may be partially up on retry — best-effort alert, silently no-ops if client is null
      postDiscordAlert('Discord bot startup', err.message).catch(() => {});
    });

    // Reply detection + Discord approvals notify + calendar sync — poll every 5 minutes
    const { checkAllClients } = require('./services/replyDetector');
    const calendarService = require('./services/googleCalendar');
    const jobHealth = require('./services/jobHealth');
    let _replyDetectorRunning = false;
    setInterval(() => {
      // Skip if previous run hasn't finished — prevents overlap under slow Gmail API
      if (_replyDetectorRunning) {
        logger.warn({ msg: 'Reply detector previous run still in flight, skipping tick' });
        return;
      }
      _replyDetectorRunning = true;
      checkAllClients()
        .then(() => { jobHealth.markRun('reply_detector'); })
        .catch(err => {
          logger.warn({ msg: 'Reply detector error', err: err.message });
          jobHealth.markError('reply_detector', err.message);
          postDiscordAlert('reply polling', err.message).catch(() => {});
        })
        .finally(() => { _replyDetectorRunning = false; });

      notifyDiscordPendingApprovals().catch(err => {
        logger.warn({ msg: 'Discord approvals notify error', err: err.message });
        postDiscordAlert('approvals polling', err.message).catch(() => {});
      });
      // Sync Google Calendar meetings → auto-advance leads to meeting_booked
      pool.query(`SELECT id FROM clients WHERE deleted_at IS NULL`).then(({ rows }) => {
        for (const { id } of rows) {
          calendarService.syncMeetings(id).catch(() => {});
        }
      }).catch(() => {});
    }, 5 * 60 * 1000);
    logger.info({ msg: 'Reply detector + Discord approvals + calendar sync polling started (5 min interval)' });

    // Send queue worker — auto-sends approved messages, retries on failure
    const { processSendQueue } = require('./services/sendQueueWorker');
    setInterval(() => {
      processSendQueue()
        .then(() => { jobHealth.markRun('send_queue'); })
        .catch(err => {
          logger.warn({ msg: 'Send queue worker error', err: err.message });
          jobHealth.markError('send_queue', err.message);
        });
    }, 60 * 1000); // Every 60 seconds
    logger.info({ msg: 'Send queue worker started (60s interval)' });

    // Follow-up scheduler — checks for due follow-ups every 30 minutes
    // Internal scheduler — follow-ups never get missed.
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

                // Server-side hard gates — relaxed for follow-ups (touch >= 2)
                const bodyText = cleanBody.replace(/^Hi\s+\w+,?\s*/i, '').replace(/\s*Regards,?\s*.*/is, '');
                const wordCount = bodyText.trim().split(/\s+/).length;
                const questionCount = (cleanBody.match(/\?/g) || []).length;
                const wordCap = fu.touch_number >= 2 ? 120 : 80;
                const questionCap = fu.touch_number >= 2 ? 2 : 1;
                if ((originalChannel === 'email' && wordCount > wordCap) || questionCount > questionCap) {
                  console.warn(`[followup-scheduler] pre-gate skip: touch=${fu.touch_number} lead=${fu.lead_id} words=${wordCount}/${wordCap} questions=${questionCount}/${questionCap}`);
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
                  const result = await rangerReview(client_id, {
                    message_id: savedMsg.id,
                    message_body: cleanBody,
                    lead_context: { touch_number: fu.touch_number, is_followup: true, name: fu.name, channel: originalChannel },
                  });
                  approved = !!result?.approved;
                  await pool.query(
                    `UPDATE messages SET status = $1, ranger_score = $2, ranger_notes = $3, updated_at = NOW() WHERE id = $4`,
                    [approved ? 'pending_approval' : 'ranger_rejected', result?.score || 0, result?.notes || (approved ? 'Enforcer approved' : `ranger_rejected:score=${result?.score||0}`), savedMsg.id]
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
        jobHealth.markRun('follow_up_scheduler');
      } catch (err) {
        console.error('[followup-scheduler] Failed:', err.message);
        jobHealth.markError('follow_up_scheduler', err.message);
      } finally {
        _followUpRunning = false;
      }
    }

    setInterval(() => { processFollowUps().catch(() => {}); }, 30 * 60 * 1000); // Every 30 minutes
    // Run once on startup after a 2-minute delay (let DB migrations complete first)
    setTimeout(() => { processFollowUps().catch(() => {}); }, 2 * 60 * 1000);
    logger.info({ msg: 'Follow-up scheduler started (30 min interval)' });

    // DB Builder — Research Beaver maintains lead pool health
    const { runDbBuilder } = require('./services/dbBuilder');
    let _dbBuilderRunning = false;
    setTimeout(() => {
      setInterval(() => {
        // Skip if previous run hasn't finished — prevents overlap under slow search APIs
        // or large client loops. dbBuilder.js also has its own internal _running guard;
        // this is defence in depth at the scheduler level.
        if (_dbBuilderRunning) {
          logger.warn({ msg: 'DB Builder previous run still in flight, skipping tick' });
          return;
        }
        _dbBuilderRunning = true;
        runDbBuilder()
          .then(() => { jobHealth.markRun('db_builder'); })
          .catch(err => {
            logger.warn({ msg: 'DB Builder error', err: err.message });
            jobHealth.markError('db_builder', err.message);
          })
          .finally(() => { _dbBuilderRunning = false; });
      }, 15 * 60 * 1000);
      logger.info({ msg: 'DB Builder started (15 min interval)' });
    }, 3 * 60 * 1000); // 3min delay after startup

    // ── Captain Beaver cron jobs ─────────────────────────────────────────────
    // Morning brief: daily at 9:00 AM MYT (01:00 UTC). Sent via Telegram.
    // Weekly review: every Sunday at 8:00 PM MYT (12:00 UTC). Full self-review.
    // Dedup: each run checks agent_memory before running to avoid double-send on restart.
    const { generateWeeklyReview, generateWeeklyStrategy } = require('./services/learningEngine');
    const telegramService = require('./services/telegram');
    const { directorBrief } = require('./services/agents');

    async function runMorningBrief() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 1 || utcMin > 10) return; // only fire in the 1:00–1:10 UTC window

      const dedupeKey = `morning_brief_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (rows.length > 0) return; // already ran today

      // Mark as ran before the API call so a restart can't double-send
      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
         SELECT id, 'captain', $1, '"sent"'::jsonb, 'config' FROM clients WHERE slug = $2`,
        [dedupeKey, process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
      ).catch(() => {});

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!chatId) return;

      try {
        const { rows: [clientRow] } = await pool.query(
          `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
          [process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
        );
        if (!clientRow) return;

        // Captain orchestrator owns the morning brief. Falls back to legacy
        // directorBrief if Captain errors so MJ never gets a silent morning.
        let text;
        try {
          const captain = require('./services/captainOrchestrator');
          const brief = await captain.runMorningBrief(clientRow.id);
          text = brief?.summary || null;
          if (text) {
            logger.info({ msg: 'Morning brief generated by Captain' });
          }
        } catch (captainErr) {
          logger.warn({ msg: 'Captain brief failed, falling back to legacy', err: captainErr.message });
        }
        if (!text) {
          const legacy = await directorBrief(clientRow.id);
          text = legacy?.summary || legacy || 'Morning. Pipeline ready.';
        }
        await telegramService.sendMessage(chatId, `<b>Morning brief</b>\n\n${text}`);
        logger.info({ msg: 'Morning brief sent via Telegram' });
      } catch (err) {
        logger.warn({ msg: 'Morning brief failed', err: err.message });
      }
    }

    async function runWeeklyReview() {
      const now = new Date();
      if (now.getUTCDay() !== 0) return;  // Sunday only
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 12 || utcMin > 10) return; // 12:00–12:10 UTC = 8:00 PM MYT

      const dedupeKey = `weekly_review_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (rows.length > 0) return;

      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
         SELECT id, 'captain', $1, '"sent"'::jsonb, 'config' FROM clients WHERE slug = $2`,
        [dedupeKey, process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
      ).catch(() => {});

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!chatId) return;

      try {
        const { rows: [clientRow] } = await pool.query(
          `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
          [process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
        );
        if (!clientRow) return;

        const brief = await generateWeeklyReview(clientRow.id);
        if (brief) {
          await telegramService.sendMessage(chatId, `<b>Weekly review</b>\n\n${brief}`);
          logger.info({ msg: 'Weekly review sent via Telegram' });
        }

        // Phase 2 strategic synthesis — runs after the Haiku narrative. Data-gated:
        // skips silently if shared memory pool has fewer than STRATEGY_MIN_EVENTS.
        // Uses Sonnet for reasoning, writes to shared/weekly_strategy_<weekLabel>.
        const strategy = await generateWeeklyStrategy(clientRow.id);
        if (strategy?.telegram_brief) {
          await telegramService.sendMessage(chatId, `<b>Weekly strategy</b>\n\n${strategy.telegram_brief}`);
          logger.info({ msg: 'Weekly strategy sent via Telegram', events: strategy.total_events });
        } else if (strategy?.skipped) {
          logger.info({ msg: 'Weekly strategy skipped', reason: strategy.skipped, total_events: strategy.total_events });
        }
      } catch (err) {
        logger.warn({ msg: 'Weekly review failed', err: err.message });
      }
    }

    // Daily agent self-reflection — 11:00 UTC = 7pm MYT, once per day.
    // Runs 1 hour before Sunday's weekly review so Sunday's daily gets captured first.
    // Each agent reflects on its own logs activity. Activity-gated (see learningEngine).
    const DAILY_REFLECTION_AGENTS = ['research_beaver', 'sales_beaver', 'ranger', 'captain_beaver'];

    async function runDailyAgentReflections() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 11 || utcMin > 10) return; // 11:00–11:10 UTC window

      const dedupeKey = `daily_reflections_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (rows.length > 0) return; // already ran today

      // Mark as ran before the loop so a crash mid-run can't cause a double-fire on restart
      const slug = process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions';
      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
         SELECT id, 'captain', $1, '"sent"'::jsonb, 'config' FROM clients WHERE slug = $2`,
        [dedupeKey, slug]
      ).catch(() => {});

      const { rows: [clientRow] } = await pool.query(
        `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      if (!clientRow) return;

      const { generateAgentDailySummary } = require('./services/learningEngine');
      for (const agent of DAILY_REFLECTION_AGENTS) {
        const result = await generateAgentDailySummary(clientRow.id, agent).catch(err => {
          logger.warn({ msg: 'Daily reflection failed', agent, err: err.message });
          return { error: err.message };
        });
        if (result?.reflection) {
          logger.info({ msg: 'Daily reflection captured', agent, activity_count: result.activity_count });
        } else if (result?.skipped) {
          logger.info({ msg: 'Daily reflection skipped', agent, reason: result.skipped });
        }
      }
    }

    // ── Daily kickoff (internal scheduler) ───────────────────────────────────
    // Fires at 9:30 AM MYT (01:30 UTC) for all clients in AUTONOMOUS_ENABLED_CLIENTS.
    const { runAutonomousKickoff } = require('./routes/autonomous');
    // runWithClientContext already imported above for follow-up scheduler

    async function runDailyKickoff() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 1 || utcMin < 30 || utcMin > 40) return;

      const enabledSlugs = (process.env.AUTONOMOUS_ENABLED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (enabledSlugs.length === 0) return;

      const dedupeKey = `daily_kickoff_${now.toISOString().slice(0, 10)}`;
      const { rows: already } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (already.length > 0) return;

      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
         SELECT id, 'captain', $1, '"sent"'::jsonb, 'config' FROM clients WHERE slug = ANY($2)`,
        [dedupeKey, enabledSlugs]
      ).catch(() => {});

      // Defensive: only kickoff active+onboarded tenants. Inactive ones (no ICP
      // / no API keys configured) get explicitly disabled via clients.is_active.
      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE slug = ANY($1) AND is_active = true AND onboarding_completed = true`,
        [enabledSlugs]
      );

      for (const client of clients) {
        logger.info({ msg: `[daily-kickoff] Starting for ${client.slug}` });
        const chatId = process.env.TELEGRAM_CHAT_ID;
        if (chatId) {
          telegramService.sendMessage(chatId,
            `<b>Daily Kickoff Started</b>\n\nClient: <code>${client.slug}</code>\nTime: ${new Date().toLocaleTimeString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' })} MYT\n\nFiring Research → Sales → Ranger → Approval. Watch for completion alert.`
          ).catch(() => {});
        }
        runWithClientContext(client.id, () =>
          runAutonomousKickoff(client.id).catch(err => {
            logger.error({ msg: `[daily-kickoff] Failed for ${client.slug}`, err: err.message });
            if (chatId) {
              telegramService.sendMessage(chatId,
                `<b>Daily Kickoff Failed</b>\n\nClient: ${client.slug}\nError: ${err.message}`
              ).catch(() => {});
            }
          })
        );
      }
    }

    // ── Captain EOD brief (19:00 MYT = 11:00 UTC) ────────────────────────────
    async function runCaptainEodBrief() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 11 || utcMin > 10) return; // 11:00-11:10 UTC = 19:00-19:10 MYT

      const dedupeKey = `eod_brief_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain_orchestrator' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (rows.length > 0) return;

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!chatId) return;
      const { rows: [clientRow] } = await pool.query(
        `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
        [process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
      );
      if (!clientRow) return;

      try {
        const captain = require('./services/captainOrchestrator');
        const brief = await captain.runEodBrief(clientRow.id);
        if (brief?.summary) {
          await telegramService.sendMessage(chatId, `<b>EOD brief</b>\n\n${brief.summary}`);
          logger.info({ msg: 'Captain EOD brief sent via Telegram' });
        }
      } catch (err) {
        logger.warn({ msg: 'Captain EOD brief failed', err: err.message });
      }
    }

    // ── Captain stuck-state monitor (hourly during 09-19 MYT) ────────────────
    // Runs every poll during working hours. Detects KPI slippage, fires Captain's
    // tactical decisions (coaching loop, strategy switch, threshold tune, throttle).
    // Telegram alert on critical issues.
    async function runStuckStateMonitor() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      // 01:00-11:59 UTC = 09:00-19:59 MYT working hours
      if (utcHour < 1 || utcHour > 11) return;
      // Only fire once per hour (10-min poll, self-dedupe via timestamp)
      const dedupeKey = `stuck_check_${now.toISOString().slice(0, 13)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain_orchestrator' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (rows.length > 0) return;

      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE is_active = true AND onboarding_completed = true`
      );
      if (clients.length === 0) return;

      const captain = require('./services/captainOrchestrator');
      const chatId = process.env.TELEGRAM_CHAT_ID;

      for (const client of clients) {
        try {
          const { issues } = await captain.detectStuckStates(client.id);
          if (issues.length === 0) continue;

          // Mark this hour as checked for this tenant
          await pool.query(
            `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
             VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
             ON CONFLICT (client_id, agent, key) DO NOTHING`,
            [client.id, dedupeKey, JSON.stringify({ issues_count: issues.length })]
          ).catch(() => {});

          // Fire tactical responses for each issue
          for (const issue of issues) {
            try {
              if (issue.recommended_action === 'fireCoachingLoop') {
                await captain.fireCoachingLoop(client.id, issue.detail);
              } else if (issue.recommended_action === 'switchResearchStrategy') {
                await captain.switchResearchStrategy(client.id, issue.detail);
              } else if (issue.recommended_action === 'tuneVpThreshold') {
                await captain.tuneVpThreshold(client.id, 5);
              } else if (issue.recommended_action === 'throttleSend') {
                await captain.throttleSend(client.id, 30);
              } else if (issue.recommended_action === 'escalateToMJ' && chatId) {
                // Critical issues hit Telegram immediately
                await telegramService.sendMessage(chatId,
                  `<b>Captain alert — ${client.slug}</b>\n\n[${issue.severity}] ${issue.type}\n${issue.detail}`
                ).catch(() => {});
                await captain.escalateToMJ(client.id, { type: issue.type, detail: issue.detail });
              }
            } catch (actionErr) {
              logger.warn({ msg: `[stuck-monitor] action failed: ${issue.recommended_action}`, err: actionErr.message });
            }
          }
        } catch (err) {
          logger.warn({ msg: `[stuck-monitor] failed for ${client.slug}`, err: err.message });
        }
      }
    }

    // Poll every 10 minutes — each function self-guards against running outside its window
    setInterval(() => {
      runMorningBrief()
        .then(() => { jobHealth.markRun('morning_brief'); })
        .catch(err => { logger.warn({ msg: 'Morning brief poll error', err: err.message }); jobHealth.markError('morning_brief', err.message); });
      runWeeklyReview()
        .then(() => { jobHealth.markRun('weekly_review'); })
        .catch(err => { logger.warn({ msg: 'Weekly review poll error', err: err.message }); jobHealth.markError('weekly_review', err.message); });
      runDailyAgentReflections()
        .then(() => { jobHealth.markRun('daily_reflections'); })
        .catch(err => { logger.warn({ msg: 'Daily reflection poll error', err: err.message }); jobHealth.markError('daily_reflections', err.message); });
      runDailyKickoff()
        .then(() => { jobHealth.markRun('daily_kickoff'); })
        .catch(err => { logger.warn({ msg: 'Daily kickoff poll error', err: err.message }); jobHealth.markError('daily_kickoff', err.message); });
      runCaptainEodBrief()
        .then(() => { jobHealth.markRun('captain_eod_brief'); })
        .catch(err => { logger.warn({ msg: 'Captain EOD brief poll error', err: err.message }); jobHealth.markError('captain_eod_brief', err.message); });
      runStuckStateMonitor()
        .then(() => { jobHealth.markRun('stuck_state_monitor'); })
        .catch(err => { logger.warn({ msg: 'Stuck-state monitor poll error', err: err.message }); jobHealth.markError('stuck_state_monitor', err.message); });
    }, 10 * 60 * 1000);
    logger.info({ msg: 'Captain Beaver cron jobs registered (10min poll: 9am brief, 7pm EOD brief, hourly stuck-state monitor 9am-7pm, 7pm daily reflections, Sunday 8pm review, 9:30am kickoff, all MYT)' });

    // ── LinkedIn stale connection sweep ─────────────────────────────────────
    // Runs every 6 hours. After 3 days in `linkedin_requested`, assume the
    // prospect accepted (users naturally don't come back to click "Connection
    // Accepted" — they reply from LinkedIn). Auto-graduate to `sent` + Day 0,
    // and schedule the Day 2/5/10/18/30 follow-up sequence.
    //
    // Prior behaviour auto-REJECTED after 7 days and routed to email fallback,
    // which silently killed active LinkedIn conversations. This inversion is
    // the Option D fix from memory `project_beavrdam_linkedin_blindspot.md`.
    async function sweepStaleLinkedInRequests() {
      try {
        const { rows: staleMessages } = await pool.query(
          `SELECT m.id AS message_id, m.lead_id, m.client_id, l.name AS lead_name, l.company AS lead_company
           FROM messages m
           JOIN leads l ON l.id = m.lead_id
           WHERE m.status = 'linkedin_requested'
             AND m.updated_at < NOW() - INTERVAL '3 days'
           LIMIT 50`
        );

        if (staleMessages.length === 0) return;
        logger.info({ msg: `LinkedIn sweep: auto-graduating ${staleMessages.length} connections past 3-day window`, count: staleMessages.length });

        const { scheduleFollowUps } = require('./services/followupSequence');

        for (const msg of staleMessages) {
          try {
            // Mark message as sent (Day 0) — presume acceptance
            await pool.query(
              `UPDATE messages SET status = 'sent', sent_at = NOW(), ranger_notes = 'auto-sweep: LinkedIn auto-graduated to sent after 3 days (acceptance presumed)', updated_at = NOW()
               WHERE id = $1 AND client_id = $2`,
              [msg.message_id, msg.client_id]
            );

            // Resolve any pending approvals for this message
            await pool.query(
              `UPDATE approvals SET status = 'approved', notes = 'auto-sweep: LinkedIn auto-graduated', resolved_at = NOW()
               WHERE message_id = $1 AND client_id = $2 AND status = 'pending'`,
              [msg.message_id, msg.client_id]
            ).catch(() => {});

            // Move lead to contacted
            if (msg.lead_id) {
              await pool.query(
                `UPDATE leads SET pipeline_stage = 'contacted', first_contacted_at = COALESCE(first_contacted_at, NOW()), updated_at = NOW()
                 WHERE id = $1 AND client_id = $2`,
                [msg.lead_id, msg.client_id]
              );
            }

            // Schedule the Day 2/5/10/18/30 follow-up sequence
            // Guard: only if no prior sent messages exist (same guard as markConnectionAccepted)
            const { rows: prevSent } = await pool.query(
              `SELECT COUNT(*) AS cnt FROM messages
               WHERE lead_id = $1 AND client_id = $2 AND status = 'sent'`,
              [msg.lead_id, msg.client_id]
            );
            if (parseInt(prevSent[0].cnt) <= 1) {
              await scheduleFollowUps(msg.client_id, msg.lead_id, new Date());
              logger.info({ msg: `[linkedin-sweep] Scheduled follow-ups for auto-graduated lead ${msg.lead_id}` });
            }
          } catch (err) {
            logger.warn({ msg: '[linkedin-sweep] Per-message error', message_id: msg.message_id, err: err.message });
          }
        }

        logger.info({ msg: 'LinkedIn sweep processed', processed: staleMessages.length });
      } catch (err) {
        logger.warn({ msg: 'LinkedIn sweep error', err: err.message });
      }
    }

    // Run every 6 hours (delayed 5 min after startup)
    setTimeout(() => {
      sweepStaleLinkedInRequests().then(() => jobHealth.markRun('linkedin_sweep')).catch(err => jobHealth.markError('linkedin_sweep', err.message));
      setInterval(() => sweepStaleLinkedInRequests().then(() => jobHealth.markRun('linkedin_sweep')).catch(err => jobHealth.markError('linkedin_sweep', err.message)), 6 * 60 * 60 * 1000);
    }, 5 * 60 * 1000);
    logger.info({ msg: 'LinkedIn stale connection sweep registered (every 6h, 7-day threshold)' });

  } catch (err) {
    logger.error({ msg: 'Failed to start server', err: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
