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
const rateLimiter = require('./middleware/rateLimiter');
const adminOnly = require('./middleware/adminOnly');
const superAdminOnly = require('./middleware/superAdminOnly');
const config = require('./config');

const app = express();

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

// Body parsing
app.use(express.json({ limit: '10kb' }));

// Rate limiting on all API routes
app.use('/api', rateLimiter);

// Routes - public (no auth)
app.use('/api/auth', require('./routes/auth'));

// Gmail OAuth callback — public (no auth, clientId from state param)
app.get('/api/integrations/gmail/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.redirect(`${frontendUrl}/settings?gmail=error`);
    const { clientId } = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    if (!clientId) return res.redirect(`${frontendUrl}/settings?gmail=error`);
    const gmailService = require('./services/gmail');
    await gmailService.exchangeCode(clientId, code);
    res.redirect(`${frontendUrl}/settings?gmail=connected`);
  } catch {
    res.redirect(`${frontendUrl}/settings?gmail=error`);
  }
});

// Routes - protected
app.use('/api/leads', authMiddleware, tenantScope, require('./routes/leads'));
app.use('/api/messages', authMiddleware, tenantScope, require('./routes/messages'));
app.use('/api/approvals', authMiddleware, tenantScope, require('./routes/approvals'));
app.use('/api/logs', authMiddleware, tenantScope, require('./routes/logs'));
app.use('/api/calendar', authMiddleware, tenantScope, require('./routes/calendar'));
app.use('/api/agents', authMiddleware, tenantScope, require('./routes/agents'));
app.use('/api/integrations', authMiddleware, tenantScope, require('./routes/integrations'));
app.use('/api/dashboard', authMiddleware, tenantScope, require('./routes/dashboard'));

// Autonomous routes — internal key auth (no JWT required)
app.use('/api/autonomous', require('./routes/autonomous'));

// Routes - super admin only (Beaver Solutions)
app.use('/api/admin', authMiddleware, tenantScope, superAdminOnly, require('./routes/admin'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', tag: 'Autonomous', timestamp: new Date().toISOString() }));

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

    app.listen(config.port, () => {
      logger.info({ msg: `The Dam v2 API running on port ${config.port}`, env: config.nodeEnv });
    });

    // Pre-warm client config cache (reads clients/<slug>/config.md for each client)
    require('./services/clientConfig').warmCache().catch(() => {});

    // Reply detection — poll every 5 minutes
    const { checkAllClients } = require('./services/replyDetector');
    setInterval(() => {
      checkAllClients().catch(err => logger.warn({ msg: 'Reply detector error', err: err.message }));
    }, 5 * 60 * 1000);
    logger.info({ msg: 'Reply detector polling started (5 min interval)' });
  } catch (err) {
    logger.error({ msg: 'Failed to start server', err: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
