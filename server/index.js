'use strict';
// 2026-05-23 16:34 MYT — force redeploy after RLS env-var change (RLS_ENFORCE_ENABLED=false)
// to clear in-memory bad state. Root cause: Supavisor pooler in transaction mode doesn't
// preserve SET ROLE state. Need session-mode connection OR refactor to SET LOCAL inside
// transactions before re-enabling RLS_ENFORCE_ENABLED=true.
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
const autonomyState = require('./services/autonomyState');
const { minutesSinceMalaysiaMidnight, todayInMalaysia } = require('./utils/businessDay');

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
app.use('/api/billing',      authMiddleware, tenantScope, clientContext, require('./routes/billing'));
app.use('/api/import',       authMiddleware, tenantScope, clientContext, require('./routes/import'));
app.use('/api/exports',      authMiddleware, tenantScope, clientContext, require('./routes/exports'));

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
  const degradedJobs = Object.entries(jobs).filter(([, v]) => v.status === 'degraded').map(([k]) => k);
  const currentAutonomyState = autonomyState.getAutonomyState();

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status: dbOk ? ((staleJobs.length > 0 || degradedJobs.length > 0) ? 'degraded' : 'ok') : 'degraded',
    version: '2.0.0',
    tag: 'Autonomous',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    // /health is unauthenticated — do not expose per-provider key status
    // (environment fingerprinting). Provider config is checked via Railway env.
    env: {
      database: dbOk ? 'ok' : 'unreachable',
      encryption_key: encKeyOk ? 'valid' : 'INVALID',
    },
    autonomy_state: currentAutonomyState,
    jobs,
    stale_jobs: staleJobs,
    degraded_jobs: degradedJobs,
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

    function scheduledAutonomyPaused() {
      return autonomyState.isScheduledAutonomyPaused();
    }

    function markScheduledPause(jobName) {
      autonomyState.markScheduledPause(jobHealth, jobName);
    }

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
      pool.query(`SELECT id FROM clients`).then(({ rows }) => {
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
           WHERE status = 'pending'
             AND scheduled_for <= (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`
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
                   WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved', 'delivered', 'linkedin_requested', 'awaiting_accept')
                   ORDER BY created_at ASC`,
                  [fu.lead_id, client_id]
                );
                const originalChannel = prevMessages[0]?.channel || 'email';

                let draft = await draftFollowUp(fu, fu.touch_number, prevMessages);
                if (draft?.status === 'needs_more_research') {
                  console.warn(`[followup-scheduler] Thin-context guard: lead ${fu.lead_id} touch ${fu.touch_number} — ${draft.reason}`);
                  await pool.query(`UPDATE followup_queue SET status = 'skipped' WHERE id = $1`, [fu.id]);
                  continue;
                }
                if (!draft?.body) { console.warn(`[followup-scheduler] No draft for lead ${fu.lead_id} touch ${fu.touch_number}`); continue; }

                let cleanBody = draft.body.replace(/\s*—\s*/g, ', ').replace(/—/g, ' ');

                // Server-side hard gates - relaxed for follow-ups (touch >= 2)
                const wordCap = fu.touch_number >= 2 ? 120 : 80;
                const questionCap = fu.touch_number >= 2 ? 2 : 1;

                const gateStats = (body) => {
                  const bt = body.replace(/^Hi\s+\w+,?\s*/i, '').replace(/\s*Regards,?\s*.*/is, '');
                  return { words: bt.trim().split(/\s+/).length, questions: (body.match(/\?/g) || []).length };
                };
                let { words: wordCount, questions: questionCount } = gateStats(cleanBody);

                // 2026-05-06 fix: retry once with a tighter constraint before skipping.
                // Historical: 174 follow-ups silently skipped on first-pass overflow.
                // One regeneration attempt before falling back to skip.
                const overCap = (originalChannel === 'email' && wordCount > wordCap) || questionCount > questionCap;
                if (overCap) {
                  console.warn(`[followup-scheduler] first-pass over-cap: touch=${fu.touch_number} lead=${fu.lead_id} words=${wordCount}/${wordCap} questions=${questionCount}/${questionCap} - retrying`);
                  const retryDraft = await draftFollowUp(
                    { ...fu, _retry_constraint: { wordCap: Math.max(40, wordCap - 30), questionCap: 1 } },
                    fu.touch_number,
                    prevMessages
                  ).catch(() => null);
                  if (retryDraft?.body) {
                    draft = retryDraft;
                    cleanBody = draft.body.replace(/\s*—\s*/g, ', ').replace(/—/g, ' ');
                    ({ words: wordCount, questions: questionCount } = gateStats(cleanBody));
                  }
                  const stillOverCap = (originalChannel === 'email' && wordCount > wordCap) || questionCount > questionCap;
                  if (stillOverCap) {
                    console.warn(`[followup-scheduler] retry also over-cap, skipping: touch=${fu.touch_number} lead=${fu.lead_id} words=${wordCount}/${wordCap} questions=${questionCount}/${questionCap}`);
                    await pool.query(`UPDATE followup_queue SET status = 'skipped' WHERE id = $1`, [fu.id]);
                    continue;
                  }
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
                    lead_context: {
                      touch_number: fu.touch_number, is_followup: true, name: fu.name, channel: originalChannel,
                      company: fu.company, title: fu.title, signal: fu.metadata?.signal, angle: fu.metadata?.angle, why_now: fu.metadata?.why_now,
                    },
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
                    if (originalChannel === 'email') {
                      await pool.query(`UPDATE messages SET status = 'pending_send', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
                      await pool.query(
                        `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at) VALUES ($1, $2, 'auto_approval', 'approved', NOW())`,
                        [client_id, savedMsg.id]
                      );
                      await enqueueMessage(client_id, savedMsg.id).catch(() => {});
                    } else {
                      await pool.query(`UPDATE messages SET status = 'linkedin_requested', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
                      await pool.query(
                        `INSERT INTO approvals (client_id, message_id, requested_by, status, notes) VALUES ($1, $2, 'auto_approval', 'pending', 'linkedin_requested')`,
                        [client_id, savedMsg.id]
                      );
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

    // DISABLED 2026-05-11 — moved to Captain-led daily planning.
    // Captain plans follow-ups at 09:00 MYT in captainOrchestrator.planFollowUps(),
    // posts brief to Telegram for MJ approval, then executes via tool calls.
    // No 30-min auto-fire — every follow-up requires Captain's per-lead angle directive
    // and MJ approval. See projects/beavrdam-rebuild/FOLLOWUP-ARCHITECTURE.md.
    //
    // setInterval(() => { processFollowUps().catch(() => {}); }, 30 * 60 * 1000);
    // setTimeout(() => { processFollowUps().catch(() => {}); }, 2 * 60 * 1000);
    jobHealth.markSkipped('follow_up_scheduler', 'FOLLOW_UP_SCHEDULER_DISABLED; Captain-led daily planning owns follow-ups', {
      disabled: true,
      owner: 'captain_led_daily_planning',
    });
    logger.info({ msg: 'Follow-up scheduler DISABLED — Captain-led daily planning replaces 30-min cron' });

    const { recoverMissedAutoApprovals } = require('./services/autoApprovalRecovery');
    let _autoApprovalRecoveryRunning = false;

    async function runAutoApprovalRecovery() {
      if (_autoApprovalRecoveryRunning) return;
      if (scheduledAutonomyPaused()) {
        markScheduledPause('auto_approval_recovery');
        return;
      }
      _autoApprovalRecoveryRunning = true;
      try {
        if (process.env.AUTO_APPROVAL_RECOVERY_ENABLED !== 'true') {
          jobHealth.markSkipped('auto_approval_recovery', 'AUTO_APPROVAL_RECOVERY_ENABLED not true; manual approval required', {
            disabled: true,
          });
          return;
        }

        const { rows: clients } = await pool.query(
          `SELECT id, auto_approve_threshold, created_at
             FROM clients
            WHERE is_active = true
              AND onboarding_completed = true`
        );
        let recovered = 0;
        let skipped = 0;
        let scanned = 0;
        for (const client of clients) {
          const result = await runWithClientContext(client.id, () =>
            recoverMissedAutoApprovals(client.id, {
              limit: 25,
              maxAgeDays: 7,
              autoApproveThreshold: client.auto_approve_threshold,
              clientCreatedAt: client.created_at,
            })
          ).catch(err => {
            console.warn('[auto-approval-recovery] client failed:', err.message);
            jobHealth.markError('auto_approval_recovery', err.message);
            return null;
          });
          recovered += Number(result?.recovered || 0);
          skipped += Number(result?.skipped || 0);
          scanned += Number(result?.scanned || 0);
        }
        jobHealth.markRun('auto_approval_recovery', { recovered, skipped, scanned, clients: clients.length });
      } catch (err) {
        console.warn('[auto-approval-recovery] sweep failed:', err.message);
        jobHealth.markError('auto_approval_recovery', err.message);
      } finally {
        _autoApprovalRecoveryRunning = false;
      }
    }

    setTimeout(() => { runAutoApprovalRecovery().catch(() => {}); }, 90 * 1000);
    setInterval(() => { runAutoApprovalRecovery().catch(() => {}); }, 15 * 60 * 1000);
    logger.info({ msg: 'Auto-approval recovery scheduled but disabled unless AUTO_APPROVAL_RECOVERY_ENABLED=true' });

    // ── Pool email enrichment (Tier-B → Tier-A) — 2026-05-29 supply fix ──────
    // Promotes LinkedIn-only pool leads to verified-email (auto-sendable) supply
    // via researchEnrichment.runPoolEmailEnrichment → emailEnrichment.findEmail.
    // This is the Tier-B graduation worker contactGate.js documented but that
    // never existed. SPENDS Brave (1 query/lead) + MillionVerifier (<=3/lead,
    // spend-guarded), so it stays OFF behind POOL_EMAIL_ENRICHMENT_ENABLED until
    // the money-approved proof. Fires once/day at 08:45-08:55 MYT (00:45-00:55
    // UTC) — after signal enrichment + DB builder, before the 09:30 kickoff —
    // so freshly-promoted email leads are draftable in the same cycle.
    let _poolEmailEnrichmentRunning = false;
    async function runPoolEmailEnrichmentCron() {
      if (_poolEmailEnrichmentRunning) return;
      if (scheduledAutonomyPaused()) {
        markScheduledPause('pool_email_enrichment');
        return;
      }
      if (process.env.POOL_EMAIL_ENRICHMENT_ENABLED !== 'true') {
        jobHealth.markSkipped('pool_email_enrichment', 'POOL_EMAIL_ENRICHMENT_ENABLED not true; no enrichment, no spend', { disabled: true });
        return;
      }
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin = now.getUTCMinutes();
      if (utcHour !== 0 || utcMin < 45 || utcMin > 55) return; // 08:45-08:55 MYT
      _poolEmailEnrichmentRunning = true;
      try {
        const dedupeKey = `pool_email_enrichment_fired_${now.toISOString().slice(0, 10)}`;
        const { rows: clients } = await pool.query(
          `SELECT id FROM clients WHERE is_active = true AND onboarding_completed = true`
        );
        const { runPoolEmailEnrichment } = require('./services/researchEnrichment');
        const { checkBudget } = require('./services/budget');
        let promoted = 0, processed = 0, firedClients = 0;
        for (const client of clients) {
          const { rows: already } = await pool.query(
            `SELECT 1 FROM agent_memory WHERE client_id = $1 AND agent = 'research_beaver' AND key = $2 LIMIT 1`,
            [client.id, dedupeKey]
          );
          if (already.length > 0) continue;
          const budgetState = await checkBudget(client.id).catch(err => ({
            allowed: false,
            remaining: 0,
            error: err.message,
            period: 'unknown',
          }));
          if (!budgetState.allowed || budgetState.remaining < Number(process.env.POOL_EMAIL_ENRICHMENT_MIN_LLM_REMAINING_USD || 1)) {
            logger.warn({
              msg: '[pool-email-enrich] skipped before provider spend by LLM budget guard',
              clientId: client.id,
              period: budgetState.period,
              remaining: budgetState.remaining,
            });
            continue;
          }
          // Mark fired BEFORE running so a restart mid-pass cannot double-spend.
          await pool.query(
            `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
             VALUES ($1, 'research_beaver', $2, '"fired"'::jsonb, 'config')
             ON CONFLICT (client_id, agent, key) DO NOTHING`,
            [client.id, dedupeKey]
          ).catch(() => {});
          const result = await runWithClientContext(client.id, () =>
            runPoolEmailEnrichment(client.id, { limit: Number(process.env.POOL_EMAIL_ENRICHMENT_LIMIT || 5) })
          ).catch(err => { jobHealth.markError('pool_email_enrichment', err.message); return null; });
          promoted += Number(result?.promoted || 0);
          processed += Number(result?.processed || 0);
          firedClients++;
        }
        jobHealth.markRun('pool_email_enrichment', { promoted, processed, clients: firedClients });
      } catch (err) {
        console.warn('[pool-email-enrich] sweep failed:', err.message);
        jobHealth.markError('pool_email_enrichment', err.message);
      } finally {
        _poolEmailEnrichmentRunning = false;
      }
    }
    setInterval(() => { runPoolEmailEnrichmentCron().catch(() => {}); }, 5 * 60 * 1000);
    logger.info({ msg: 'Pool email enrichment scheduled but disabled unless POOL_EMAIL_ENRICHMENT_ENABLED=true' });

    // DB Builder — Research Beaver maintains lead pool health
    // 2026-05-14: changed from every-15-min to 2x daily (08:30 + 13:00 MYT).
    // Per MJ direction + PER-BEAVER-KPI-ARCHITECTURE.md: Research Beaver fires
    // BEFORE Captain's 09:00 MYT morning brief so the brief reflects fresh
    // sourcing, then 13:00 top-up if morning didn't hit 40-leads target.
    // Quality > volume — burning Brave on every 15-min tick was wasteful.
    const { runDbBuilder } = require('./services/dbBuilder');
    let _dbBuilderRunning = false;
    let _dbBuilderLastFiredKey = null;
    setTimeout(() => {
      setInterval(() => {
        if (scheduledAutonomyPaused()) {
          markScheduledPause('db_builder');
          return;
        }
        const now = new Date();
        const utcHour = now.getUTCHours();
        const utcMin = now.getUTCMinutes();
        // Window 1: 00:30-00:39 UTC = 08:30-08:39 MYT (morning fire, pre-Captain brief)
        // Window 2: 05:00-05:09 UTC = 13:00-13:09 MYT (mid-day top-up)
        const isMorningWindow = (utcHour === 0 && utcMin >= 30 && utcMin < 40);
        const isMidDayWindow = (utcHour === 5 && utcMin >= 0 && utcMin < 10);
        if (!isMorningWindow && !isMidDayWindow) return;

        const windowKey = isMorningWindow
          ? `morning_${now.toISOString().slice(0, 10)}`
          : `midday_${now.toISOString().slice(0, 10)}`;
        if (_dbBuilderLastFiredKey === windowKey) return; // already fired this window
        if (_dbBuilderRunning) {
          logger.warn({ msg: 'DB Builder previous run still in flight, skipping window' });
          return;
        }
        _dbBuilderRunning = true;
        _dbBuilderLastFiredKey = windowKey;

        logger.info({ msg: `DB Builder firing (window=${windowKey})` });
        runDbBuilder()
          .then(() => { jobHealth.markRun('db_builder'); })
          .catch(err => {
            logger.warn({ msg: 'DB Builder error', err: err.message });
            jobHealth.markError('db_builder', err.message);
          })
          .finally(() => { _dbBuilderRunning = false; });
      }, 5 * 60 * 1000); // 5-min poll cadence — catches both windows reliably
      logger.info({ msg: 'DB Builder started (2x daily: 08:30 + 13:00 MYT)' });
    }, 3 * 60 * 1000); // 3min delay after startup

    // ── Captain Beaver cron jobs ─────────────────────────────────────────────
    // Morning brief: daily at 9:00 AM MYT (01:00 UTC). Sent via Telegram.
    // Weekly review: every Sunday at 8:00 PM MYT (12:00 UTC). Full self-review.
    // Dedup: each run checks agent_memory before running to avoid double-send on restart.
    const { generateWeeklyReview, generateWeeklyStrategy } = require('./services/learningEngine');
    const telegramService = require('./services/telegram');

    // Research Beaver pre-enrichment: fires at 00:30–00:40 UTC (08:30–08:40 MYT),
    // BEFORE the morning brief at 01:00 UTC (09:00 MYT). Refreshes lead signals
    // for any follow-ups due today so Captain plans with fresh context.
    async function runResearchEnrichment() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 0 || utcMin < 30 || utcMin > 40) return; // 0:30–0:40 UTC window

      const dedupeKey = `research_enrichment_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'research_beaver' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (rows.length > 0) return; // already ran today

      try {
        const { rows: [clientRow] } = await pool.query(
          `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
          [process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
        );
        if (!clientRow) return;

        const { checkBudget } = require('./services/budget');
        const budgetState = await checkBudget(clientRow.id).catch(err => ({
          allowed: false,
          error: err.message,
          spend: null,
          budget: null,
          period: 'unknown',
        }));
        if (!budgetState.allowed) {
          logger.warn({ msg: 'Research enrichment blocked by budget guard', clientId: clientRow.id, budgetState });
          return { blocked: true, reason: 'budget_guard_preflight', budgetState };
        }

        // Mark before paid work. This cron only supports the morning pre-plan
        // enrichment window; retry loops here can drain Brave before kickoff.
        await pool.query(
          `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
           VALUES ($1, 'research_beaver', $2, $3::jsonb, 'config')
           ON CONFLICT (client_id, agent, key) DO NOTHING`,
          [clientRow.id, dedupeKey, JSON.stringify({ started_at: now.toISOString(), reason: 'daily_pre_followup_enrichment' })]
        ).catch(() => {});

        const { runDailyEnrichmentPass } = require('./services/researchEnrichment');
        const result = await runWithClientContext(clientRow.id, () => runDailyEnrichmentPass(clientRow.id));
        logger.info({ msg: 'Research enrichment pass complete', ...result });
        return result;
      } catch (err) {
        logger.warn({ msg: 'Research enrichment pass failed', err: err.message });
        return { error: err.message };
      }
    }

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
      if (!chatId) {
        // A4-11: never exit silently — a missing chat ID suppresses a scheduled
        // Captain brief while jobHealth still reports the job 'ok'.
        console.warn('[captain] TELEGRAM_CHAT_ID not set — a scheduled brief was suppressed; no Telegram message will reach MJ');
        return;
      }

      try {
        const { rows: [clientRow] } = await pool.query(
          `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
          [process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
        );
        if (!clientRow) return;

        // Captain orchestrator owns the morning brief. If the full snapshot
        // fails, send a Captain-shaped incident brief instead of legacy totals.
        let text;
        try {
          const captain = require('./services/captainOrchestrator');
          const brief = await captain.runMorningBrief(clientRow.id);
          text = brief?.summary || null;
          if (text) {
            logger.info({ msg: 'Morning brief generated by Captain' });
          }
        } catch (captainErr) {
          logger.warn({ msg: 'Captain brief failed, sending emergency brief', err: captainErr.message });
          try {
            const captain = require('./services/captainOrchestrator');
            const emergency = await captain.generateEmergencyMorningBrief(clientRow.id, captainErr);
            text = emergency?.summary || null;
          } catch (emergencyErr) {
            logger.warn({ msg: 'Captain emergency brief failed', err: emergencyErr.message });
          }
        }
        if (!text) {
          text = `<b>SYSTEM HEALTH</b>
dam amber. Captain morning brief failed before operational snapshot.

<b>PIPELINE STATUS</b>
not available in Telegram; use the app until Captain telemetry is restored.

<b>OUTREACH STATUS</b>
not available in Telegram.

<b>TODAY'S PLAN</b>
do not run paid sourcing from this alert.

<b>IMPEDIMENTS</b>
Captain report generation failed.

<b>NEED YOUR CALL</b>
none from this broken report; check app truth before approving batches.`;
        }
        await telegramService.sendMessage(chatId, `<b>Morning brief</b>\n\n${text}`);
        logger.info({ msg: 'Morning brief sent via Telegram' });

        // Captain's follow-up planning runs after the morning brief.
        // Generates per-lead angle directives + Telegram brief for MJ approval.
        // No auto-execution — MJ approves via Telegram chat ("approve all" or per-item).
        // See projects/beavrdam-rebuild/FOLLOWUP-ARCHITECTURE.md
        try {
          const captain = require('./services/captainOrchestrator');
          const plan = await captain.runFollowUpPlanning(clientRow.id);
          logger.info({ msg: 'Follow-up plan generated', planned: plan.planned, skipped: plan.skipped, total: plan.total_due });
        } catch (planErr) {
          logger.warn({ msg: 'Follow-up planning failed', err: planErr.message });
        }
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
      if (!chatId) {
        // A4-11: never exit silently — a missing chat ID suppresses a scheduled
        // Captain brief while jobHealth still reports the job 'ok'.
        console.warn('[captain] TELEGRAM_CHAT_ID not set — a scheduled brief was suppressed; no Telegram message will reach MJ');
        return;
      }

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

        // Phase 5.5 (2026-05-06): Weekly Learnings + Plan of the Week.
        // Runs after strategy synthesis on Sunday so all week data is captured.
        // Writes to weekly_learnings table + agent_memory (Monday brief reads it).
        // Sends Telegram summary of the plan so MJ can review before Monday.
        try {
          const captainOrch = require('./services/captainOrchestrator');
          const learnings = await captainOrch.runWeeklyLearnings(clientRow.id);
          if (learnings?.planOfWeek?.summary) {
            await telegramService.sendMessage(chatId, `<b>📋 Plan of the Week</b>\n\n${learnings.planOfWeek.summary}`);
            logger.info({ msg: 'Weekly learnings + plan sent via Telegram', week: learnings.weekStart });
          }
        } catch (learnErr) {
          logger.warn({ msg: 'Weekly learnings failed (non-fatal)', err: learnErr.message });
        }
      } catch (err) {
        logger.warn({ msg: 'Weekly review failed', err: err.message });
      }
    }

    function dayOfWeekFromDateKey(dateKey) {
      const [year, month, day] = String(dateKey).slice(0, 10).split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    }

    async function runCaptainPeriodReports() {
      const now = new Date();
      const todayKey = todayInMalaysia(now);
      const klMinutes = minutesSinceMalaysiaMidnight(now);
      const windowStart = 8 * 60 + 20;
      const windowEnd = 8 * 60 + 30;
      if (klMinutes < windowStart || klMinutes > windowEnd) {
        return { idle: true, reason: 'outside 08:20-08:30 MYT Captain report window' };
      }

      const dueReports = [];
      if (dayOfWeekFromDateKey(todayKey) === 1) dueReports.push('weekly');
      if (todayKey.endsWith('-01')) dueReports.push('monthly');
      if (dueReports.length === 0) return { idle: true, reason: 'no Captain period report due today' };

      const { rows: [clientRow] } = await pool.query(
        `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
        [process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions']
      );
      if (!clientRow) return { skipped: true, reason: 'telegram client not found' };

      const { generateCaptainPeriodReport } = require('./services/kpi');
      const chatId = process.env.TELEGRAM_CHAT_ID;
      let generated = 0;
      let sent = 0;
      let deduped = 0;
      const artifacts = [];

      for (const reportType of dueReports) {
        if (reportType === 'weekly') {
          logger.debug({ msg: 'Captain weekly report due', todayKey });
        } else if (reportType === 'monthly') {
          logger.debug({ msg: 'Captain monthly report due', todayKey });
        }
        const dedupeKey = `captain_${reportType}_report_sent_${todayKey}`;
        const { rows } = await pool.query(
          `SELECT 1 FROM agent_memory WHERE client_id = $1 AND agent = 'captain' AND key = $2 LIMIT 1`,
          [clientRow.id, dedupeKey]
        );
        if (rows.length > 0) {
          deduped++;
          continue;
        }

        await pool.query(
          `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
           VALUES ($1, 'captain', $2, $3::jsonb, 'kpi')
           ON CONFLICT (client_id, agent, key) DO NOTHING`,
          [clientRow.id, dedupeKey, JSON.stringify({ report_type: reportType, scheduled_for: todayKey })]
        ).catch(() => {});

        const generatedReport = await generateCaptainPeriodReport(clientRow.id, { reportType, now });
        generated++;
        artifacts.push(generatedReport.artifactKey);

        if (chatId) {
          await telegramService.sendMessage(chatId, `<b>Captain ${reportType} report</b>\n\n${generatedReport.text}`);
          sent++;
        } else {
          console.warn('[captain] TELEGRAM_CHAT_ID not set — Captain period report artifact saved but Telegram delivery was suppressed');
        }
      }

      return { generated, sent, deduped, artifacts, report_types: dueReports };
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

    function dailyKickoffHasWorkProof(proof) {
      return !!proof?.daily_kickoff_work_log || Number(proof?.trace_count || 0) > 0;
    }

    async function getDailyKickoffProof(clientId, today) {
      const { rows: [proof] } = await pool.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM agent_memory am
              WHERE am.client_id = $1
                AND am.agent = 'captain'
                AND am.key = 'daily_kickoff_' || $2::text
           )
           OR EXISTS (
             SELECT 1 FROM logs l
              WHERE l.client_id = $1
                AND l.action = 'autonomous_kickoff'
                AND (l.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
           ) AS daily_kickoff_started,
           EXISTS (
             SELECT 1 FROM logs l
              WHERE l.client_id = $1
                AND (l.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
                AND l.action IN (
                  'db_pool_draw',
                  'db_pool_zero_output_stop',
                  'pool_audit_rejected',
                  'pool_dry_for_channel_target',
                  'generic_sourcing_disabled_skip',
                  'daily_web_linkedin_topup_failed',
                  'daily_web_linkedin_topup_empty',
                  'daily_web_linkedin_topup_success',
                  'daily_web_linkedin_topup_deduped',
                  'research_pool_exhausted',
                  'kickoff_zero_output',
                  'daily_kickoff_low_yield_blocker',
                  'captain_kickoff_blocker_required',
                  'signal_pipeline_executing',
                  'signal_first_started',
                  'signal_first_failed',
                  'campaign_target_unfulfilled',
                  'paid_signal_disabled_stop',
                  'campaign_target_fulfilled'
                )
           ) AS daily_kickoff_work_log,
           (SELECT COUNT(*)::int
              FROM pipeline_traces pt
             WHERE pt.client_id = $1
               AND pt.pipeline_path IN ('kickoff_pipeline', 'signal_pipeline')
               AND (pt.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS trace_count`,
        [clientId, today]
      );
      return proof || { daily_kickoff_started: false, daily_kickoff_work_log: false, trace_count: 0 };
    }

    async function recordUnverifiedDailyKickoff(clientId, today, now, source, proof = {}) {
      const key = `daily_kickoff_unverified_output_${today}_${source}`;
      const content = {
        blocked_at: now.toISOString(),
        source,
        reason: 'daily kickoff start marker has no output proof',
        trace_count: Number(proof.trace_count) || 0,
      };
      const inserted = await pool.query(
        `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
         VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
         ON CONFLICT (client_id, agent, key) DO NOTHING
         RETURNING id`,
        [clientId, key, JSON.stringify(content)]
      ).catch(() => ({ rows: [] }));
      if (!inserted.rows?.length) return;
      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, metadata)
         VALUES ($1, 'captain_orchestrator', 'daily_kickoff_unverified_output_blocker', 'system', $2::jsonb)`,
        [clientId, JSON.stringify(content)]
      ).catch(() => {});
    }

    async function runDailyKickoff() {
      if (process.env.CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true') {
        return { disabled: true, reason: 'CAPTAIN_DAILY_KICKOFF_ENABLED disabled' };
      }
      const { checkBudget } = require('./services/budget');

      const now = new Date();
      const klMinutes = minutesSinceMalaysiaMidnight(now);
      const windowStart = 9 * 60 + 30;
      const windowEnd = 9 * 60 + 40;

      const enabledSlugs = (process.env.AUTONOMOUS_ENABLED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (enabledSlugs.length === 0) {
        return { disabled: true, reason: 'AUTONOMOUS_ENABLED_CLIENTS empty' };
      }

      const dedupeKey = `daily_kickoff_${todayInMalaysia(now)}`;

      // Defensive: only kickoff active+onboarded tenants. Inactive ones (no ICP
      // / no API keys configured) get explicitly disabled via clients.is_active.
      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE slug = ANY($1) AND is_active = true AND onboarding_completed = true`,
        [enabledSlugs]
      );
      if (clients.length === 0) {
        return { skipped: true, reason: 'no active onboarded clients matched AUTONOMOUS_ENABLED_CLIENTS', enabledSlugs };
      }

      if (klMinutes < windowStart) {
        return { waiting: true, reason: 'before 09:30 MYT daily kickoff window', clients: clients.map(client => client.slug) };
      }

      if (klMinutes > windowEnd) {
        const { rows: firedRows } = await pool.query(
          `SELECT client_id FROM agent_memory WHERE agent = 'captain' AND key = $1 AND client_id = ANY($2)`,
          [dedupeKey, clients.map(client => client.id)]
        );
        if (firedRows.length >= clients.length) {
          const unverified = [];
          for (const client of clients) {
            const proof = await getDailyKickoffProof(client.id, todayInMalaysia(now));
            if (proof.daily_kickoff_started && !dailyKickoffHasWorkProof(proof)) {
              unverified.push({ client_id: client.id, slug: client.slug, trace_count: Number(proof.trace_count) || 0 });
              await recordUnverifiedDailyKickoff(client.id, todayInMalaysia(now), now, 'daily_scheduler_after_window', proof);
            }
          }
          if (unverified.length > 0) {
            return {
              blocked: true,
              reason: 'daily kickoff dedupe rows present but no output proof',
              fired: 0,
              deduped: firedRows.length,
              unverified,
              clients: clients.map(client => client.slug),
            };
          }
          return { alreadyDone: true, reason: 'daily kickoff dedupe rows present', fired: 0, deduped: firedRows.length, clients: clients.map(client => client.slug) };
        }
        return {
          missed: true,
          reason: 'daily kickoff window passed without all tenant dedupe rows',
          fired: 0,
          deduped: firedRows.length,
          expected: clients.length,
          clients: clients.map(client => client.slug),
        };
      }

      // Notification policy (set 2026-05-03): user only gets Morning brief, EOD
      // brief, and Captain-decided impromptu (escalateToMJ via stuck-state monitor).
      // Daily kickoff fires the pipeline silently — no Telegram noise on start
      // or per-client failure. Failures still hit server logs for ops visibility.
      //
      // A4-26: dedupe is per-tenant. The old code checked one global row and
      // wrote rows for every tenant up front — so a restart after the write but
      // before tenant B fired left B's row present, and B silently missed its
      // kickoff for the day. Each tenant now checks + marks its own row, and the
      // mark happens BEFORE the kickoff so a crash can't cause a double-fire.
      const result = {
        fired: 0,
        deduped: 0,
        budgetBlocked: 0,
        unverified: 0,
        blocked: 0,
        blockers: [],
        clients: clients.map(client => client.slug),
      };
      for (const client of clients) {
        const { rows: already } = await pool.query(
          `SELECT 1 FROM agent_memory WHERE client_id = $1 AND agent = 'captain' AND key = $2 LIMIT 1`,
          [client.id, dedupeKey]
        );
        if (already.length > 0) {
          const proof = await getDailyKickoffProof(client.id, todayInMalaysia(now));
          if (proof.daily_kickoff_started && !dailyKickoffHasWorkProof(proof)) {
            result.unverified++;
            result.blocked++;
            result.blockers.push({
              client_id: client.id,
              slug: client.slug,
              reason: 'daily kickoff start marker has no output proof',
              trace_count: Number(proof.trace_count) || 0,
            });
            await recordUnverifiedDailyKickoff(client.id, todayInMalaysia(now), now, 'daily_scheduler_window', proof);
          } else {
            result.deduped++;
          }
          continue;
        }

        const budgetState = await checkBudget(client.id).catch(err => ({
          allowed: false,
          error: err.message,
          spend: null,
          budget: null,
          period: 'unknown',
        }));
        if (!budgetState.allowed) {
          result.budgetBlocked++;
          await pool.query(
            `INSERT INTO logs (client_id, agent, action, target_type, metadata)
             VALUES ($1, 'director', 'daily_kickoff_blocked_budget', 'system', $2)`,
            [client.id, JSON.stringify({
              reason: 'budget_guard_preflight',
              spend: budgetState.spend,
              budget: budgetState.budget,
              period: budgetState.period,
              error: budgetState.error || null,
            })]
          ).catch(() => {});
          logger.warn({ msg: `[daily-kickoff] Budget guard blocked ${client.slug}`, budgetState });
          continue;
        }

        await pool.query(
          `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
           VALUES ($1, 'captain', $2, '"sent"'::jsonb, 'config')
           ON CONFLICT (client_id, agent, key) DO NOTHING`,
          [client.id, dedupeKey]
        ).catch(() => {});

        logger.info({ msg: `[daily-kickoff] Starting for ${client.slug}` });
        const kickoffResult = await runWithClientContext(client.id, () =>
          runAutonomousKickoff(client.id).catch(err => {
            logger.error({ msg: `[daily-kickoff] Failed for ${client.slug}`, err: err.message });
            throw err;
          })
        );
        const kickoffBlocker = jobHealth.degradedReasonFromResult(kickoffResult);
        const proof = await getDailyKickoffProof(client.id, todayInMalaysia(now));
        if (kickoffBlocker) {
          result.blocked++;
          result.blockers.push({
            client_id: client.id,
            slug: client.slug,
            reason: kickoffBlocker,
            kickoff_result: kickoffResult,
          });
        }
        if (proof.daily_kickoff_started && !dailyKickoffHasWorkProof(proof)) {
          result.unverified++;
          if (!kickoffBlocker) {
            result.blocked++;
            result.blockers.push({
              client_id: client.id,
              slug: client.slug,
              reason: 'daily kickoff start marker has no output proof',
              trace_count: Number(proof.trace_count) || 0,
            });
          }
          await recordUnverifiedDailyKickoff(client.id, todayInMalaysia(now), now, 'daily_scheduler_after_run', proof);
        } else if (!kickoffBlocker) {
          result.fired++;
        }
      }
      return result.blocked > 0
        ? { ...result, blocked: true, reason: result.blockers[0]?.reason || 'daily kickoff blocked by autonomous output blocker' }
        : result.fired > 0
          ? { fired: true, ...result }
        : result.unverified > 0
          ? { ...result, blocked: true, reason: 'daily kickoff start marker has no output proof' }
        : result.budgetBlocked > 0
          ? { ...result, blocked: true, reason: 'daily kickoff blocked by budget guard' }
        : { alreadyDone: true, reason: 'all clients already had daily kickoff dedupe rows', ...result };
    }

    // ── Captain EOD brief (19:20 MYT = 11:20 UTC) ────────────────────────────
    // A4-7: fires AFTER the 11:00-11:10 daily agent reflections window, not in
    // it. The EOD brief summarises the day from agent reflections; running in
    // the same poll tick as runDailyAgentReflections risked reading them before
    // they were written. The 11:20-11:30 window gives reflections a clear lead.
    async function runCaptainEodBrief() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 11 || utcMin < 20 || utcMin > 30) return; // 11:20-11:30 UTC = 19:20-19:30 MYT

      const dedupeKey = `eod_brief_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain_orchestrator' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (rows.length > 0) return;

      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!chatId) {
        // A4-11: never exit silently — a missing chat ID suppresses a scheduled
        // Captain brief while jobHealth still reports the job 'ok'.
        console.warn('[captain] TELEGRAM_CHAT_ID not set — a scheduled brief was suppressed; no Telegram message will reach MJ');
        return;
      }
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

      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE is_active = true AND onboarding_completed = true`
      );
      if (clients.length === 0) return;

      const captain = require('./services/captainOrchestrator');
      const chatId = process.env.TELEGRAM_CHAT_ID;

      for (const client of clients) {
        try {
          // A4-12: dedupe is per-tenant and marked BEFORE the work. The old code
          // checked one global row and marked per-tenant AFTER firing tactical
          // actions — a crash mid-loop left the hour unmarked, so a restart
          // re-fired coaching directives. Check + mark this tenant's own row up
          // front; a crash now costs one skipped hourly check, not a double-fire.
          const { rows: already } = await pool.query(
            `SELECT 1 FROM agent_memory
             WHERE client_id = $1 AND agent = 'captain_orchestrator' AND key = $2 LIMIT 1`,
            [client.id, dedupeKey]
          );
          if (already.length > 0) continue;
          await pool.query(
            `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
             VALUES ($1, 'captain_orchestrator', $2, '"checked"'::jsonb, 'config')
             ON CONFLICT (client_id, agent, key) DO NOTHING`,
            [client.id, dedupeKey]
          ).catch(() => {});

          const { issues } = await captain.detectStuckStates(client.id);
          if (issues.length === 0) continue;

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
                // Per-day dedupe: respects MJ's "morning brief / EOD / impromptu only"
                // policy. The "impromptu" channel fires once per day per issue type, not
                // every hour the condition holds.
                const today = todayInMalaysia();
                const dedupeKey = `escalation_${issue.type}_${today}`;
                const { rows: alreadyFired } = await pool.query(
                  `SELECT 1 FROM agent_memory
                   WHERE client_id = $1 AND agent = 'captain_orchestrator' AND key = $2 LIMIT 1`,
                  [client.id, dedupeKey]
                );
                if (alreadyFired.length === 0) {
                  await telegramService.sendMessage(chatId,
                    `<b>Captain alert — ${client.slug}</b>\n\n[${issue.severity}] ${issue.type}\n${issue.detail}`
                  ).catch(() => {});
                  await pool.query(
                    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
                     VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
                     ON CONFLICT (client_id, agent, key) DO NOTHING`,
                    [client.id, dedupeKey, JSON.stringify({ type: issue.type, fired_at: new Date().toISOString(), detail: issue.detail })]
                  ).catch(() => {});
                }
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

    // ── Enforcer weekly teaching note (Sunday 18:00 MYT = Sunday 10:00 UTC) ──
    // Fires AFTER quality tuner (Sunday 17:00 MYT) so the teaching note can
    // include any threshold tunes Captain just made. Aggregates 7d of reject
    // patterns + Sales improvement-after-feedback + outcomes by dimension,
    // hands to Sonnet for a 4-6 sentence teaching note. Persists to
    // agent_memory keyed `enforcer_teaching_YYYY-WW` for Captain's Monday
    // brief to quote.
    async function runEnforcerTeachingCron() {
      const now = new Date();
      const isSunday = now.getUTCDay() === 0;
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      // Sunday 10:00-10:10 UTC = Sunday 18:00-18:10 MYT
      if (!isSunday || utcHour !== 10 || utcMin > 10) return;

      const todayKey = `enforcer_teaching_dedupe_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'system' AND key = $1 LIMIT 1`,
        [todayKey]
      );
      if (rows.length > 0) return;

      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE is_active = true AND onboarding_completed = true`
      );
      const { runEnforcerTeaching } = require('./services/enforcerTeaching');
      for (const client of clients) {
        try {
          const result = await runEnforcerTeaching(client.id);
          logger.info({ msg: `[enforcer-teaching] ${client.slug}: ${result.status}` });
        } catch (err) {
          logger.warn({ msg: `[enforcer-teaching] ${client.slug} failed`, err: err.message });
        }
      }

      // Mark dedup
      await pool.query(
        `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
         SELECT id, 'system', $1, '"sent"'::jsonb, 'config' FROM clients LIMIT 1`,
        [todayKey]
      ).catch(() => {});
    }

    // ── Soft-reject TTL purge (daily 03:00 UTC = 11:00 MYT) ──────────────
    // Hard-deletes leads with status LIKE 'rejected_%' AND deleted_at older
    // than 30 days. Stops the leads table from bloating with stale soft-
    // rejected ICP-v2 audit rows. Keeps recent rejects for analysis (Phase D
    // piece 1 may want to mine reject patterns to refine ICP).
    async function runSoftRejectPurgeCron() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      if (utcHour !== 3 || utcMin > 10) return; // 03:00-03:10 UTC daily

      const todayKey = `soft_reject_purge_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'system' AND key = $1 LIMIT 1`,
        [todayKey]
      );
      if (rows.length > 0) return;

      try {
        const { rowCount } = await pool.query(
          `DELETE FROM leads
            WHERE status LIKE 'rejected_%'
              AND deleted_at IS NOT NULL
              AND deleted_at < NOW() - INTERVAL '30 days'`
        );
        logger.info({ msg: `[soft-reject-purge] removed ${rowCount} stale soft-rejected leads (>30d)` });

        await pool.query(
          `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
           SELECT id, 'system', $1, $2::jsonb, 'config' FROM clients LIMIT 1`,
          [todayKey, JSON.stringify({ purged: rowCount, ran_at: now.toISOString() })]
        ).catch(() => {});
      } catch (err) {
        logger.warn({ msg: '[soft-reject-purge] failed', err: err.message });
      }
    }

    // ── Phase D piece 3 — Quality threshold auto-tuner (Sunday 17:00 MYT) ──
    // Reads agent_outcomes from the last 14 days, computes pass-through rate
    // at each candidate threshold, picks the lowest one clearing 5% reply
    // rate AND with statistically meaningful volume, writes new threshold to
    // clients.vp_threshold_score. Logs decision via Captain action.
    //
    // Insufficient data → no-op + persist the analysis. Cron tolerates this
    // for the first weeks while reply data accumulates.
    async function runQualityTunerCron() {
      const now = new Date();
      const isSunday = now.getUTCDay() === 0;
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      // Sunday 09:00-09:10 UTC = Sunday 17:00-17:10 MYT
      if (!isSunday || utcHour !== 9 || utcMin > 10) return;

      const todayKey = `quality_tune_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain_orchestrator' AND key = $1 LIMIT 1`,
        [todayKey]
      );
      if (rows.length > 0) return;

      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE is_active = true AND onboarding_completed = true`
      );
      const { runQualityTune } = require('./services/qualityTuner');
      for (const client of clients) {
        try {
          const result = await runQualityTune(client.id);
          if (result.tuned) {
            logger.info({ msg: `[quality-tuner] ${client.slug}: ${result.from} → ${result.to}` });
          } else {
            logger.info({ msg: `[quality-tuner] ${client.slug}: no change`, reason: result.reason });
          }
        } catch (err) {
          logger.warn({ msg: `[quality-tuner] ${client.slug} failed`, err: err.message });
        }
      }
    }

    // ── Phase E — Market Sensing (08:30 MYT = 00:30 UTC) ──────────────
    // Per-tenant scan of MY-only news sources for buying signals. Cheap
    // (Haiku + ~21 Brave queries), high-leverage (feeds Research Beaver
    // and Captain's brief). Self-guards on time + dedupes via agent_memory.
    async function runMarketSensingCron() {
      if (process.env.MARKET_SENSING_ENABLED !== 'true') {
        return { disabled: true, reason: 'MARKET_SENSING_ENABLED disabled' };
      }
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcMin  = now.getUTCMinutes();
      const utcMinutes = utcHour * 60 + utcMin;
      const windowStart = 0 * 60 + 30;
      const windowEnd = 0 * 60 + 40;
      const todayKey = `market_signals_${now.toISOString().slice(0, 10)}`;
      const { rows } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'market_sensor' AND key = $1 LIMIT 1`,
        [todayKey]
      );
      if (rows.length > 0) {
        return { alreadyDone: true, reason: 'already ran today' };
      }
      if (utcMinutes < windowStart) {
        return { waiting: true, reason: 'before 08:30 MYT market-sensing window' };
      }
      if (utcMinutes > windowEnd) {
        return { missed: true, reason: 'market-sensing window passed without run' };
      } // 00:30-00:40 UTC = 08:30-08:40 MYT

      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE is_active = true AND onboarding_completed = true`
      );
      const { runMarketSensing } = require('./services/marketSensing');
      const result = { fired: 0, opportunities: 0, rawResults: 0, clients: clients.map(client => client.slug) };
      for (const client of clients) {
        try {
          const clientResult = await runMarketSensing(client.id);
          result.fired++;
          result.opportunities += clientResult.opportunities.length;
          result.rawResults += clientResult.raw_results_count;
          logger.info({ msg: `[market-sensing] ${client.slug}: ${clientResult.opportunities.length} opps from ${clientResult.raw_results_count} raw` });
        } catch (err) {
          logger.warn({ msg: `[market-sensing] ${client.slug} failed`, err: err.message });
        }
      }
      return result.fired > 0 ? { fired: true, ...result } : { skipped: true, reason: 'no active onboarded clients' };
    }

    // ── Captain KPI gap kickoff (hourly during working hours) ──────────────
    // Captain checks if daily send target is met. If not, and no kickoff is
    // already running, and cooldown has passed, fires another kickoff.
    // Guards: max 6 kickoffs/day, 25-min cooldown, working hours only.
    async function runKpiGapKickoff() {
      if (process.env.CAPTAIN_KPI_GAP_KICKOFF_ENABLED !== 'true') {
        return { disabled: true, reason: 'CAPTAIN_KPI_GAP_KICKOFF_ENABLED disabled' };
      }
      if (process.env.CAPTAIN_DAILY_KICKOFF_ENABLED !== 'true') {
        return { disabled: true, reason: 'CAPTAIN_DAILY_KICKOFF_ENABLED disabled; refusing KPI-gap kickoff' };
      }

      const now = new Date();
      const utcHour = now.getUTCHours();
      // 02:00-09:59 UTC = 10:00-17:59 MYT. Starts at 02:00 (not 01:00) so it
      // never overlaps the 01:30 daily kickoff window — A4-6: at 01:30 the daily
      // kickoff has fired but sent is still 0, so kpi-gap would see an unmet KPI
      // and fire a SECOND kickoff before the first registers a cooldown log.
      if (utcHour < 2 || utcHour >= 10) return { waiting: true, reason: 'outside 10:00-17:59 MYT KPI-gap window' };

      // 2026-05-12: relaxed minute window 0-9 → 0-29. With 10-min poll cadence,
      // the old window only landed if poll happened to align with :00-:09 of an
      // hour. Empirically today only 1 of 9 hourly slots fired. Wider window
      // ensures every hourly poll has a chance to fire (still gated by hourly
      // dedupe so we never fire more than once per hour).
      const m = now.getUTCMinutes();
      if (m >= 30) return { waiting: true, reason: 'outside first 30 minutes of hourly KPI-gap window' };

      // Hourly dedupe
      const dedupeKey = `kpi_gap_kickoff_${now.toISOString().slice(0, 13)}`;
      const { rows: already } = await pool.query(
        `SELECT 1 FROM agent_memory WHERE agent = 'captain_orchestrator' AND key = $1 LIMIT 1`,
        [dedupeKey]
      );
      if (already.length > 0) {
        logger.debug({ msg: `[kpi-gap] hourly dedupe hit for ${dedupeKey}` });
        return { alreadyDone: true, reason: 'hourly KPI-gap dedupe row present' };
      }

      const enabledSlugs = (process.env.AUTONOMOUS_ENABLED_CLIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (enabledSlugs.length === 0) {
        logger.warn({ msg: '[kpi-gap] AUTONOMOUS_ENABLED_CLIENTS is empty — cron is no-op' });
        return { disabled: true, reason: 'AUTONOMOUS_ENABLED_CLIENTS empty' };
      }

      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE slug = ANY($1) AND is_active = true AND onboarding_completed = true`,
        [enabledSlugs]
      );

      const result = { fired: 0, blocked: 0, blockers: [] };
      for (const client of clients) {
        try {
          const today = todayInMalaysia(now);

          const kickoffBlockerKey = `captain_kickoff_blocker_${today}`;
          const { rows: kickoffBlockerRows } = await pool.query(
            `SELECT content FROM agent_memory
             WHERE client_id = $1
               AND agent = 'captain_orchestrator'
               AND key = $2
             LIMIT 1`,
            [client.id, kickoffBlockerKey]
          );
          if (kickoffBlockerRows.length > 0) {
            const blocker = kickoffBlockerRows[0].content || {};
            const blockerLogKey = `kpi_gap_blocked_by_kickoff_blocker_${today}_${now.toISOString().slice(11, 13)}`;
            await pool.query(
              `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
               VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
               ON CONFLICT (client_id, agent, key) DO NOTHING`,
              [client.id, blockerLogKey, JSON.stringify({
                blocked_at: now.toISOString(),
                blocker_key: kickoffBlockerKey,
                blocker,
              })]
            ).catch(() => {});
            await pool.query(
              `INSERT INTO logs (client_id, agent, action, target_type, metadata)
               VALUES ($1, 'captain_orchestrator', 'kpi_gap_blocked_by_kickoff_blocker', 'system', $2::jsonb)`,
              [client.id, JSON.stringify({
                blocker_key: kickoffBlockerKey,
                blocker,
                reason: 'daily kickoff zero/low-yield blocker is active; refusing follow-on autonomous kickoff',
              })]
            ).catch(() => {});
            logger.warn({ msg: `[kpi-gap] ${client.slug}: kickoff blocker active (${blocker.blocker || 'unknown'}), refusing follow-on kickoff` });
            result.blocked++;
            result.blockers.push({
              client_id: client.id,
              slug: client.slug,
              reason: jobHealth.degradedReasonFromResult(blocker) || blocker.blocker || 'daily kickoff zero/low-yield blocker is active',
              blocker,
            });
            continue;
          }

          const { rows: [dailyKickoffProof] } = await pool.query(
            `SELECT
               EXISTS (
                 SELECT 1 FROM agent_memory am
                  WHERE am.client_id = $1
                    AND am.agent = 'captain'
                    AND am.key = 'daily_kickoff_' || $2::text
               )
               OR EXISTS (
                 SELECT 1 FROM logs l
                  WHERE l.client_id = $1
                    AND l.action = 'autonomous_kickoff'
                    AND (l.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
               ) AS daily_kickoff_started,
               EXISTS (
                 SELECT 1 FROM logs l
                  WHERE l.client_id = $1
                    AND (l.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date
                    AND l.action IN (
                      'db_pool_draw',
                      'db_pool_zero_output_stop',
                      'pool_audit_rejected',
                      'pool_dry_for_channel_target',
                      'generic_sourcing_disabled_skip',
                      'daily_web_linkedin_topup_failed',
                      'daily_web_linkedin_topup_empty',
                      'daily_web_linkedin_topup_success',
                      'daily_web_linkedin_topup_deduped',
                      'research_pool_exhausted',
                      'kickoff_zero_output',
                      'daily_kickoff_low_yield_blocker',
                      'captain_kickoff_blocker_required',
                      'signal_pipeline_executing',
                      'signal_first_started',
                      'signal_first_failed',
                      'campaign_target_unfulfilled',
                      'paid_signal_disabled_stop',
                      'campaign_target_fulfilled'
                    )
               ) AS daily_kickoff_work_log,
               (SELECT COUNT(*)::int
                  FROM pipeline_traces pt
                 WHERE pt.client_id = $1
                   AND pt.pipeline_path IN ('kickoff_pipeline', 'signal_pipeline')
                   AND (pt.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date) AS trace_count`,
            [client.id, today]
          );
          const dailyKickoffWorkProof = !!dailyKickoffProof?.daily_kickoff_work_log || Number(dailyKickoffProof?.trace_count) > 0;
          if (dailyKickoffProof?.daily_kickoff_started && !dailyKickoffWorkProof) {
            const blockerLogKey = `kpi_gap_blocked_by_unverified_daily_kickoff_${today}_${now.toISOString().slice(11, 13)}`;
            const blocker = {
              blocked_at: now.toISOString(),
              reason: 'daily kickoff start marker has no output proof',
              trace_count: Number(dailyKickoffProof.trace_count) || 0,
            };
            await pool.query(
              `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
               VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
               ON CONFLICT (client_id, agent, key) DO NOTHING`,
              [client.id, blockerLogKey, JSON.stringify(blocker)]
            ).catch(() => {});
            await pool.query(
              `INSERT INTO logs (client_id, agent, action, target_type, metadata)
               VALUES ($1, 'captain_orchestrator', 'kpi_gap_blocked_by_unverified_daily_kickoff', 'system', $2::jsonb)`,
              [client.id, JSON.stringify({
                ...blocker,
                reason: 'daily kickoff start marker has no output proof; refusing follow-on autonomous kickoff',
              })]
            ).catch(() => {});
            logger.warn({ msg: `[kpi-gap] ${client.slug}: daily kickoff start marker has no output proof, refusing follow-on kickoff` });
            result.blocked++;
            result.blockers.push({
              client_id: client.id,
              slug: client.slug,
              reason: 'daily kickoff start marker has no output proof',
              trace_count: Number(dailyKickoffProof.trace_count) || 0,
            });
            continue;
          }

          // Email-only KPI gate (2026-05-20): Captain stops when email target is hit.
          // LinkedIn is acceptance-gated and variable — excluded from Captain's stop
          // condition. Captain can only control what it auto-sends (email). LinkedIn
          // drain is MJ/Cowork territory and runs independently.
          const EMAIL_TARGET = 30;
          const { rows: [{ email_sent_today }] } = await pool.query(
            `SELECT COUNT(*)::int AS email_sent_today FROM messages
             WHERE client_id = $1 AND status = 'sent' AND channel = 'email'
               AND sent_at IS NOT NULL
               AND (sent_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $2::date`,
            [client.id, today]
          );
          if (email_sent_today >= EMAIL_TARGET) {
            // Notify MJ once per day when email KPI is first hit
            const kpiHitKey = `kpi_email_hit_${today}`;
            const { rows: alreadyNotified } = await pool.query(
              `SELECT 1 FROM agent_memory WHERE client_id = $1 AND agent = 'captain_orchestrator' AND key = $2 LIMIT 1`,
              [client.id, kpiHitKey]
            );
            if (alreadyNotified.length === 0) {
              await pool.query(
                `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
                 VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
                 ON CONFLICT (client_id, agent, key) DO NOTHING`,
                [client.id, kpiHitKey, JSON.stringify({ email_sent: email_sent_today, hit_at: now.toISOString() })]
              ).catch(() => {});
              const chatId = process.env.TELEGRAM_CHAT_ID;
              if (chatId) {
                telegramService.sendMessage(chatId,
                  `Email KPI hit — ${email_sent_today}/${EMAIL_TARGET} emails sent today. Captain standing down. LinkedIn drain is yours.`
                ).catch(() => {});
              }
            }
            logger.info({ msg: `[kpi-gap] ${client.slug}: email KPI met (${email_sent_today}/${EMAIL_TARGET}), standing down` });
            continue;
          }
          const target = EMAIL_TARGET;
          const sent = email_sent_today;

          // Daily cap: max 6 kpi_gap kickoffs per day. Count this function's OWN
          // dedupe-key writes (1 per Captain decision to fire) — NOT signal_pipeline_executing
          // logs which are emitted PER LEAD inside each kickoff (~15 leads/fire).
          // The old query saw 30 logs after 2 kickoffs (2 fires × 15 leads), false-blocked
          // every subsequent attempt for the rest of the day. Captain never actually fired
          // hourly — bug existed since the gate was written.
          const { rows: [{ cnt: kickoffsToday }] } = await pool.query(
            `SELECT COUNT(*)::int AS cnt FROM agent_memory
             WHERE client_id = $1 AND agent = 'captain_orchestrator'
               AND key LIKE 'kpi_gap_kickoff_' || $2 || 'T%'`,
            [client.id, today]
          );
          if (kickoffsToday >= 6) {
            logger.info({ msg: `[kpi-gap] ${client.slug}: ${kickoffsToday} kickoffs today, daily cap reached` });
            continue;
          }

          // Cooldown: at least 25 min since last kickoff started
          const { rows: lastKickoff } = await pool.query(
            `SELECT created_at FROM logs
             WHERE client_id = $1 AND action = 'signal_pipeline_executing'
             ORDER BY created_at DESC LIMIT 1`,
            [client.id]
          );
          if (lastKickoff.length > 0) {
            const minsSinceLast = (now - new Date(lastKickoff[0].created_at)) / 60000;
            if (minsSinceLast < 25) {
              logger.info({ msg: `[kpi-gap] ${client.slug}: last kickoff ${Math.round(minsSinceLast)}m ago, cooling down` });
              continue;
            }
          }

          // Check if available leads exist in the pool
          const { rows: [{ pool_size }] } = await pool.query(
            `SELECT COUNT(*)::int AS pool_size FROM leads
             WHERE client_id = $1 AND pipeline_stage = 'prospecting' AND status = 'new'
             AND deleted_at IS NULL`,
            [client.id]
          );
          if (pool_size < 5) {
            logger.info({ msg: `[kpi-gap] ${client.slug}: only ${pool_size} leads in pool, skipping` });
            continue;
          }

          // ── ZERO-YIELD CIRCUIT BREAKER (2026-05-23) ──
          // Enforces corrections.md 2026-05-22 PRE-ACTION SPEND GATE on the
          // autonomous Captain. Keyed off the canonical kickoff_zero_output
          // signal already written by routes/autonomous.js:~1996 after any
          // kickoff that produces 0 sent + 0 pending + 0 rejected. If 3+
          // such rows landed in the last 4h, the pipeline is broken — stop
          // burning LLM tokens until the underlying cause is fixed.
          // Self-releases as soon as any kickoff lands non-zero output
          // (the 4h window decays past the zero rows).
          const { rows: [{ zero_count }] } = await pool.query(
            `SELECT COUNT(*)::int AS zero_count FROM logs
             WHERE client_id = $1
               AND action = 'kickoff_zero_output'
               AND created_at > NOW() - INTERVAL '4 hours'`,
            [client.id]
          );
          if (zero_count >= 3) {
            const breakerKey = `captain_breaker_${today}`;
            const { rows: alreadyAlerted } = await pool.query(
              `SELECT 1 FROM agent_memory
               WHERE client_id = $1 AND agent = 'captain_orchestrator' AND key = $2 LIMIT 1`,
              [client.id, breakerKey]
            );
            if (alreadyAlerted.length === 0) {
              await pool.query(
                `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
                 VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
                 ON CONFLICT (client_id, agent, key) DO NOTHING`,
                [client.id, breakerKey, JSON.stringify({
                  tripped_at: now.toISOString(),
                  zero_output_count_4h: zero_count,
                })]
              ).catch(() => {});
              await pool.query(
                `INSERT INTO logs (client_id, agent, action, target_type, metadata)
                 VALUES ($1, 'captain_orchestrator', 'captain_circuit_breaker_tripped', 'system', $2::jsonb)`,
                [client.id, JSON.stringify({
                  reason: 'zero-output kickoffs >= 3 in last 4h',
                  zero_output_count_4h: zero_count,
                })]
              ).catch(() => {});
              const chatId = process.env.TELEGRAM_CHAT_ID;
              if (chatId) {
                telegramService.sendMessage(chatId,
                  `[critical] Captain CIRCUIT BREAKER tripped for ${client.slug}: ${zero_count} zero-output kickoffs in last 4h. Pausing kickoffs to stop LLM burn. Fix the root cause (sourcing / pipeline / Sales Beaver), then breaker auto-releases as the 4h window decays past the zero rows.`
                ).catch(() => {});
              }
            }
            logger.warn({ msg: `[kpi-gap] ${client.slug}: CIRCUIT BREAKER tripped — ${zero_count} zero-output kickoffs in last 4h, skipping` });
            result.blocked++;
            result.blockers.push({
              client_id: client.id,
              slug: client.slug,
              reason: 'zero_outputs',
              zero_output_count_4h: zero_count,
            });
            continue;
          }

          // Mark this slot as checked
          const gap = EMAIL_TARGET - email_sent_today;
          await pool.query(
            `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
             VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
             ON CONFLICT (client_id, agent, key) DO NOTHING`,
            [client.id, dedupeKey, JSON.stringify({ gap, email_sent: email_sent_today, email_target: EMAIL_TARGET, pool_size, kickoffs_today: kickoffsToday })]
          ).catch(() => {});

          // Fire kickoff
          logger.info({ msg: `[kpi-gap] ${client.slug}: email ${email_sent_today}/${EMAIL_TARGET}, gap=${gap}, pool=${pool_size}, kickoff #${kickoffsToday + 1} — firing` });
          await pool.query(
            `INSERT INTO logs (client_id, agent, action, target_type, metadata)
             VALUES ($1, 'captain_orchestrator', 'kpi_gap_kickoff', 'system', $2::jsonb)`,
            [client.id, JSON.stringify({ email_sent: email_sent_today, email_target: EMAIL_TARGET, gap, pool_size, kickoff_number: kickoffsToday + 1 })]
          ).catch(() => {});

          const kickoffResult = await runWithClientContext(client.id, () =>
            runAutonomousKickoff(client.id).catch(err => {
              logger.error({ msg: `[kpi-gap] kickoff failed for ${client.slug}`, err: err.message });
              throw err;
            })
          );
          const kickoffBlocker = jobHealth.degradedReasonFromResult(kickoffResult);
          if (kickoffBlocker) {
            result.blocked++;
            result.blockers.push({
              client_id: client.id,
              slug: client.slug,
              reason: kickoffBlocker,
              kickoff_result: kickoffResult,
            });
          } else {
            result.fired++;
          }
        } catch (err) {
          logger.warn({ msg: `[kpi-gap] check failed for ${client.slug}`, err: err.message });
        }
      }
      if (result.blocked > 0) {
        return { ...result, blocked: true, reason: result.blockers[0]?.reason || 'KPI-gap kickoff blocked by autonomous output blocker' };
      }
      return result.fired > 0 ? { fired: true, ...result } : { skipped: true, reason: 'no KPI-gap kickoff fired' };
    }

    // ── Captain directive sweep (Wave 1, 2026-05-03; cadence fix Wave 3) ───
    // Every 30 min during working hours, Captain reads team KPIs and writes
    // directives to the agent_directives bus. Beavers consume on next run.
    // Cheaper than running every 10 min; KPIs don't move that fast.
    async function runCaptainDirectiveSweep() {
      const now = new Date();
      const utcHour = now.getUTCHours();
      // 01:00-11:59 UTC = 09:00-19:59 MYT working hours
      if (utcHour < 1 || utcHour > 11) return;
      // Half-hour cadence: poll runs every 10 min, fire on the :00-:09 and
      // :30-:39 minute windows. Earlier code only checked < 10 which collapsed
      // to once per hour depending on server-start offset.
      const m = now.getUTCMinutes();
      const inFirstWindow  = m < 10;
      const inSecondWindow = m >= 30 && m < 40;
      if (!inFirstWindow && !inSecondWindow) return;

      const { rows: clients } = await pool.query(
        `SELECT id, slug FROM clients WHERE is_active = true AND onboarding_completed = true`
      );
      if (clients.length === 0) return;
      const captain = require('./services/captainOrchestrator');
      const failures = [];
      const results = [];
      for (const client of clients) {
        try {
          const result = await captain.runDirectiveSweep(client.id);
          results.push({ client_id: client.id, slug: client.slug, result });
          if (result.directives_written > 0) {
            logger.info({ msg: `[directive-sweep] ${client.slug}: ${result.directives_written} directives written` });
          }
          if (result?.snapshot_error) {
            failures.push({ slug: client.slug, reason: 'snapshot_failed', error: result.snapshot_error });
          }
        } catch (err) {
          logger.warn({ msg: `[directive-sweep] failed for ${client.slug}`, err: err.message });
          failures.push({ slug: client.slug, reason: 'sweep_failed', error: err.message });
        }
      }
      if (failures.length > 0) {
        return {
          errors: failures.length,
          reason: 'captain_directive_sweep_snapshot_failed',
          failures,
          clients: clients.length,
        };
      }
      return {
        clients: clients.length,
        snapshot_written: results.filter(r => r.result?.snapshot_written).length,
        directives_written: results.reduce((sum, r) => sum + (Number(r.result?.directives_written) || 0), 0),
      };
    }

    // Poll every 10 minutes — each function self-guards against running outside its window
    setInterval(() => {
      if (scheduledAutonomyPaused()) {
        [
          'research_enrichment',
          'morning_brief',
          'weekly_review',
          'captain_period_report',
          'daily_reflections',
          'daily_kickoff',
          'captain_eod_brief',
          'stuck_state_monitor',
          'market_sensing',
          'quality_tuner',
          'soft_reject_purge',
          'enforcer_teaching',
          'captain_directive_sweep',
          'kpi_gap_kickoff',
        ].forEach(markScheduledPause);
        return;
      }
      runResearchEnrichment()
        .then(result => {
          if (result?.blocked) jobHealth.markSkipped('research_enrichment', result.reason || 'research enrichment blocked', result);
          else if (result?.processed !== undefined || result?.error) jobHealth.markRun('research_enrichment', result);
        })
        .catch(err => { logger.warn({ msg: 'Research enrichment poll error', err: err.message }); jobHealth.markError('research_enrichment', err.message); });
      runMorningBrief()
        .then(() => { jobHealth.markRun('morning_brief'); })
        .catch(err => { logger.warn({ msg: 'Morning brief poll error', err: err.message }); jobHealth.markError('morning_brief', err.message); });
      runWeeklyReview()
        .then(() => { jobHealth.markRun('weekly_review'); })
        .catch(err => { logger.warn({ msg: 'Weekly review poll error', err: err.message }); jobHealth.markError('weekly_review', err.message); });
      runCaptainPeriodReports()
        .then(result => {
          if (result?.generated > 0 || result?.sent > 0) jobHealth.markRun('captain_period_report', result);
          else if (result?.skipped) jobHealth.markSkipped('captain_period_report', result.reason || 'Captain period report skipped', result);
        })
        .catch(err => { logger.warn({ msg: 'Captain period report error', err: err.message }); jobHealth.markError('captain_period_report', err.message); });
      runDailyAgentReflections()
        .then(() => { jobHealth.markRun('daily_reflections'); })
        .catch(err => { logger.warn({ msg: 'Daily reflection poll error', err: err.message }); jobHealth.markError('daily_reflections', err.message); });
      runDailyKickoff()
        .then(result => {
          const degradedReason = jobHealth.degradedReasonFromResult(result);
          if (degradedReason) jobHealth.markDegraded('daily_kickoff', degradedReason, result);
          else if (result?.fired || result?.alreadyDone) jobHealth.markRun('daily_kickoff', result);
          else if (result?.disabled || result?.missed || result?.skipped || result?.blocked) jobHealth.markSkipped('daily_kickoff', result?.reason || 'daily kickoff skipped', result);
        })
        .catch(err => { logger.warn({ msg: 'Daily kickoff poll error', err: err.message }); jobHealth.markError('daily_kickoff', err.message); });
      runCaptainEodBrief()
        .then(() => { jobHealth.markRun('captain_eod_brief'); })
        .catch(err => { logger.warn({ msg: 'Captain EOD brief poll error', err: err.message }); jobHealth.markError('captain_eod_brief', err.message); });
      runStuckStateMonitor()
        .then(() => { jobHealth.markRun('stuck_state_monitor'); })
        .catch(err => { logger.warn({ msg: 'Stuck-state monitor poll error', err: err.message }); jobHealth.markError('stuck_state_monitor', err.message); });
      runMarketSensingCron()
        .then(result => {
          if (result?.fired || result?.alreadyDone) jobHealth.markRun('market_sensing', result);
          else if (result?.disabled || result?.missed || result?.skipped || result?.blocked) jobHealth.markSkipped('market_sensing', result?.reason || 'market sensing skipped', result);
        })
        .catch(err => { logger.warn({ msg: 'Market-sensing poll error', err: err.message }); jobHealth.markError('market_sensing', err.message); });
      runQualityTunerCron()
        .then(() => { jobHealth.markRun('quality_tuner'); })
        .catch(err => { logger.warn({ msg: 'Quality-tuner poll error', err: err.message }); jobHealth.markError('quality_tuner', err.message); });
      runSoftRejectPurgeCron()
        .then(() => { jobHealth.markRun('soft_reject_purge'); })
        .catch(err => { logger.warn({ msg: 'Soft-reject purge poll error', err: err.message }); jobHealth.markError('soft_reject_purge', err.message); });
      runEnforcerTeachingCron()
        .then(() => { jobHealth.markRun('enforcer_teaching'); })
        .catch(err => { logger.warn({ msg: 'Enforcer-teaching poll error', err: err.message }); jobHealth.markError('enforcer_teaching', err.message); });
      runCaptainDirectiveSweep()
        .then(result => {
          if (result?.errors > 0) {
            jobHealth.markError('captain_directive_sweep', result.reason || 'captain_directive_sweep_snapshot_failed');
          } else {
            jobHealth.markRun('captain_directive_sweep', result);
          }
        })
        .catch(err => { logger.warn({ msg: 'Captain directive sweep error', err: err.message }); jobHealth.markError('captain_directive_sweep', err.message); });
      runKpiGapKickoff()
        .then(result => {
          const degradedReason = jobHealth.degradedReasonFromResult(result);
          if (degradedReason) jobHealth.markDegraded('kpi_gap_kickoff', degradedReason, result);
          else if (result?.fired || result?.alreadyDone) jobHealth.markRun('kpi_gap_kickoff', result);
          else if (result?.disabled || result?.skipped || result?.waiting) jobHealth.markSkipped('kpi_gap_kickoff', result?.reason || 'KPI-gap kickoff skipped', result);
        })
        .catch(err => { logger.warn({ msg: 'KPI gap kickoff poll error', err: err.message }); jobHealth.markError('kpi_gap_kickoff', err.message); });
    }, 10 * 60 * 1000);
    logger.info({ msg: 'Captain Beaver cron jobs registered (10min poll: 9am brief, 7pm EOD brief, hourly stuck-state monitor 9am-7pm, 7pm daily reflections, Sunday 8pm review, 9:30am kickoff, 30min KPI gap kickoff, all MYT)' });

    // ── LinkedIn stale connection sweep ─────────────────────────────────────
    // Runs every 6 hours. After 3 days in `linkedin_requested`, assume the
    // prospect accepted (users naturally don't come back to click "Connection
    // Accepted" — they reply from LinkedIn). Auto-graduate to `sent` + Day 0,
    // and schedule the Day 2/5/10/18/30 follow-up sequence.
    //
    // Prior behaviour auto-REJECTED after 7 days and routed to email fallback,
    // which silently killed active LinkedIn conversations. This inversion is
    // the Option D fix from memory `project_beavrdam_linkedin_blindspot.md`.
    const LINKEDIN_STALE_DAYS = parseInt(process.env.LINKEDIN_STALE_DAYS || '14', 10);
    const LINKEDIN_SWEEP_BATCH = 10;

    async function sweepStaleLinkedInRequests() {
      try {
        const { rows: staleMessages } = await pool.query(
          `SELECT m.id AS message_id, m.lead_id, m.client_id,
                  l.name AS lead_name, l.company AS lead_company, l.email AS lead_email,
                  l.linkedin_url AS lead_linkedin, l.title AS lead_title
           FROM messages m
           JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
           WHERE m.status = 'linkedin_requested'
             AND m.updated_at < NOW() - make_interval(days => $1)
           ORDER BY m.updated_at ASC
           LIMIT $2`,
          [LINKEDIN_STALE_DAYS, LINKEDIN_SWEEP_BATCH]
        );

        if (staleMessages.length === 0) return;
        logger.info({ msg: `[linkedin-sweep] ${staleMessages.length} stale linkedin_requested (>${LINKEDIN_STALE_DAYS}d) — attempting email escalation` });

        let escalated = 0;
        let removed = 0;

        for (const msg of staleMessages) {
          try {
            const minLlmRemaining = Number(process.env.LINKEDIN_SWEEP_MIN_LLM_REMAINING_USD || 0.25);
            const { checkBudget } = require('./services/budget');
            const budgetState = await checkBudget(msg.client_id).catch(err => ({
              allowed: false,
              remaining: 0,
              error: err.message,
              period: 'unknown',
            }));
            if (!budgetState.allowed || budgetState.remaining < minLlmRemaining) {
              logger.warn({
                msg: '[linkedin-sweep] skipped before enrichment by LLM budget guard',
                clientId: msg.client_id,
                lead: msg.lead_name,
                period: budgetState.period,
                remaining: budgetState.remaining,
                min_required: minLlmRemaining,
              });
              continue;
            }

            let foundEmail = msg.lead_email;

            if (!foundEmail) {
              try {
                const emailEnrichment = require('./services/emailEnrichment');
                const result = await emailEnrichment.enrichEmail(msg.client_id, {
                  name: msg.lead_name,
                  company: msg.lead_company,
                });
                if (result?.email) {
                  foundEmail = result.email;
                  await pool.query(
                    `UPDATE leads SET email = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
                    [foundEmail, msg.lead_id, msg.client_id]
                  );
                  logger.info({ msg: `[linkedin-sweep] Found email for ${msg.lead_name}: ${foundEmail}` });
                }
              } catch (err) {
                logger.warn({ msg: `[linkedin-sweep] Email enrichment failed for ${msg.lead_name}`, err: err.message });
              }
            }

            await pool.query(
              `UPDATE messages SET status = 'stale_unsent',
                 ranger_notes = $1, updated_at = NOW()
               WHERE id = $2 AND client_id = $3`,
              [foundEmail
                ? `Expired after ${LINKEDIN_STALE_DAYS}d no accept — escalated to email`
                : `Expired after ${LINKEDIN_STALE_DAYS}d no accept — no email found, lead removed`,
               msg.message_id, msg.client_id]
            );

            if (foundEmail) {
              try {
                const { callAgent } = require('./services/claude');
                const draft = await callAgent('sales_beaver',
                  `You are Sales Beaver writing a COLD EMAIL. This is the FIRST email to this person — a prior LinkedIn connection request went unanswered.

LEAD: ${msg.lead_name} - ${msg.lead_title || 'Unknown'} at ${msg.lead_company}

FORMAT (email): Hi ${(msg.lead_name || '').split(' ')[0]}, {body — max 60 words}. Regards, {sender}.
Do NOT mention the LinkedIn request. Treat this as a fresh cold email. One specific observation about their company + one pointed question.

HARD RULES: No em dashes. Max 1 question mark. No bullets. No fabricated details. No "I hope this finds you well."

Return JSON: {"subject":"...","body":"..."}`,
                  { clientId: msg.client_id, channel: 'email', mode: 'linkedin_stale_escalation' }
                );

                if (draft?.body && typeof draft.body === 'string') {
                  const cleanBody = draft.body.replace(/\s*—\s*/g, ', ').replace(/—/g, ' ');
                  const { rows: [savedMsg] } = await pool.query(
                    `INSERT INTO messages (client_id, lead_id, subject, body, status, channel, metadata)
                     VALUES ($1, $2, $3, $4, 'pending_approval', 'email', $5)
                     RETURNING id`,
                    [msg.client_id, msg.lead_id, draft.subject || msg.lead_company,
                     cleanBody, JSON.stringify({ linkedin_stale_escalation: true, original_message_id: msg.message_id })]
                  );

                  await pool.query(
                    `INSERT INTO approvals (client_id, message_id, requested_by, status)
                     VALUES ($1, $2, 'linkedin_stale_escalation', 'pending')`,
                    [msg.client_id, savedMsg.id]
                  );

                  const logsService = require('./services/logs');
                  await logsService.createLog(msg.client_id, {
                    agent: 'system', action: 'linkedin_stale_escalated',
                    target_type: 'lead', target_id: msg.lead_id,
                    metadata: { lead_name: msg.lead_name, email: foundEmail, stale_days: LINKEDIN_STALE_DAYS },
                  });
                  escalated++;
                }
              } catch (err) {
                logger.warn({ msg: `[linkedin-sweep] Email draft failed for ${msg.lead_name}`, err: err.message });
              }
            } else {
              await pool.query(
                `UPDATE leads SET deleted_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND client_id = $2`,
                [msg.lead_id, msg.client_id]
              );

              const logsService = require('./services/logs');
              await logsService.createLog(msg.client_id, {
                agent: 'system', action: 'linkedin_stale_removed',
                target_type: 'lead', target_id: msg.lead_id,
                metadata: { lead_name: msg.lead_name, company: msg.lead_company, stale_days: LINKEDIN_STALE_DAYS },
              });
              removed++;
            }
          } catch (err) {
            logger.warn({ msg: '[linkedin-sweep] Per-message error', message_id: msg.message_id, err: err.message });
          }
        }

        logger.info({ msg: `[linkedin-sweep] Done: ${escalated} escalated to email, ${removed} removed`, total: staleMessages.length });
      } catch (err) {
        logger.warn({ msg: '[linkedin-sweep] Sweep error', err: err.message });
      }
    }

    // Run once daily at 08:10 MYT. This is after the UTC budget reset (08:00
    // MYT) and before Research Beaver's 08:30 run, so stale leads clear first
    // without spending from yesterday's LLM budget window.
    function scheduleLinkedInSweep() {
      if (scheduledAutonomyPaused()) {
        markScheduledPause('linkedin_sweep');
        logger.warn({ msg: 'LinkedIn stale sweep not scheduled because SCHEDULED_AUTONOMY_PAUSED is active' });
        return;
      }
      const now = new Date();
      const myt = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
      const target = new Date(myt);
      target.setHours(8, 10, 0, 0);
      if (myt >= target) target.setDate(target.getDate() + 1);
      const msUntil = target.getTime() - myt.getTime();
      setTimeout(() => {
        sweepStaleLinkedInRequests().then(() => jobHealth.markRun('linkedin_sweep')).catch(err => jobHealth.markError('linkedin_sweep', err.message));
        setInterval(() => sweepStaleLinkedInRequests().then(() => jobHealth.markRun('linkedin_sweep')).catch(err => jobHealth.markError('linkedin_sweep', err.message)), 24 * 60 * 60 * 1000);
      }, msUntil);
      logger.info({ msg: `LinkedIn stale sweep scheduled: first run in ${Math.round(msUntil / 60000)}min (08:10 MYT daily, ${LINKEDIN_STALE_DAYS}-day threshold, batch ${LINKEDIN_SWEEP_BATCH})` });
    }
    scheduleLinkedInSweep();

  } catch (err) {
    logger.error({ msg: 'Failed to start server', err: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
