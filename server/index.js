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

// MyClaw routes — token auth (MYCLAW_HOOK_TOKEN), no JWT required.
// MyClaw acts as director: reads approvals, resolves them, manages memory, manages leads.
app.use('/api/myclaw', require('./routes/myclaw'));

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
      serper: process.env.SERPER_API_KEY ? 'set' : 'missing',
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
  } catch (err) {
    logger.error({ msg: 'Failed to start server', err: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
