'use strict';

// Admin routes — super admin only (Beaver Solutions)
// All cross-client operations live here.

const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const pool = require('../db/pool');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { generateAccessCode, createSignupToken } = require('../services/auth');
const billing = require('../services/billing');

const ADMIN_SQL_ENABLED = process.env.ADMIN_SQL_ENABLED === 'true';

// Super Admin is a cross-tenant control plane. Use ownerQuery here so the
// tenant-scoped RLS pool wrapper does not hide other clients from Beaver admins.
const adminQuery = (...args) => pool.ownerQuery(...args);

function slugBaseFromName(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return (slug || 'client').slice(0, 80);
}

async function uniqueClientSlug(dbClient, name) {
  const base = slugBaseFromName(name);

  for (let i = 0; i < 100; i += 1) {
    const suffix = i === 0 ? '' : `-${i + 1}`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    const existing = await dbClient.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [candidate]);
    if (existing.rows.length === 0) return candidate;
  }

  const err = new Error('Could not generate a unique client slug');
  err.status = 409;
  err.code = 'SLUG_TAKEN';
  throw err;
}

function sendCreateClientDbError(err, res) {
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Client or user already exists', code: 'DUPLICATE_CLIENT' });
  }
  if (err.code === '22001') {
    return res.status(400).json({ error: 'One of the submitted values is too long', code: 'FIELD_TOO_LONG' });
  }
  return null;
}

function sendCreateClientUnknownError(err, res) {
  const code = err.code || 'CLIENT_CREATE_FAILED';
  return res.status(err.status || 500).json({
    error: err.status ? err.message : `Client provisioning failed (${code})`,
    code,
  });
}

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────

// GET /api/admin/clients — all clients with pipeline stats
router.get('/clients', async (req, res, next) => {
  try {
    const result = await adminQuery(`
      SELECT
        c.id, c.name, c.email, c.slug, c.plan, c.onboarding_completed,
        c.trial_length_days, c.trial_started_at, c.trial_ends_at, c.billing_status, c.created_at,
        COALESCE((
          SELECT SUM(bi.total_amount_rm)::int
          FROM billing_intents bi
          WHERE bi.client_id = c.id
            AND bi.status IN ('pending_invoice', 'invoice_sent', 'paid')
        ), 0) AS accumulated_charges_rm,
        COALESCE((
          SELECT SUM(bi.total_amount_rm)::int
          FROM billing_intents bi
          WHERE bi.client_id = c.id
            AND bi.status IN ('pending_invoice', 'invoice_sent')
        ), 0) AS pending_charges_rm,
        (SELECT COUNT(*)::int FROM users u WHERE u.client_id = c.id)                                        AS user_count,
        (SELECT COUNT(*)::int FROM leads l WHERE l.client_id = c.id AND l.deleted_at IS NULL)               AS lead_count,
        (SELECT COUNT(*)::int FROM messages m WHERE m.client_id = c.id)                                     AS message_count,
        (SELECT COUNT(*)::int FROM approvals a WHERE a.client_id = c.id AND a.status = 'pending')           AS pending_approvals,
        (SELECT MAX(lg.created_at) FROM logs lg WHERE lg.client_id = c.id)                                  AS last_activity
      FROM clients c
      ORDER BY c.created_at DESC
    `);
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) {
    res.status(err.status || 500).json({
      error: `Admin client list failed (${err.code || 'ADMIN_CLIENTS_FAILED'})`,
      code: err.code || 'ADMIN_CLIENTS_FAILED',
    });
  }
});

// POST /api/admin/clients — create new client + admin user
router.post('/clients',
  [
    body('name').trim().isLength({ min: 1, max: 200 }),
    body('email').isEmail().normalizeEmail(),
    body('plan').optional().isIn(['starter', 'growth', 'enterprise']),
    body('trial_length_days').optional().custom(value => [14, 30].includes(Number(value))),
    validate,
  ],
  async (req, res, next) => {
    const dbClient = await pool.connect();
    try {
      const { name, email, plan = 'starter', trial_length_days = 30 } = req.body;
      const trial = billing.calculateTrialWindow(Number(trial_length_days));

      await dbClient.query('BEGIN');

      // Check both login and client billing emails before writing anything.
      const existing = await dbClient.query(
        `SELECT 'user' AS kind, id FROM users WHERE email = $1
         UNION ALL
         SELECT 'client' AS kind, id FROM clients WHERE email = $1
         LIMIT 1`,
        [email]
      );
      if (existing.rows.length > 0) {
        await dbClient.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_TAKEN' });
      }

      const slug = await uniqueClientSlug(dbClient, name);

      // Create client
      const clientRes = await dbClient.query(
        `INSERT INTO clients
           (name, email, plan, slug, trial_length_days, trial_started_at, trial_ends_at, billing_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'trial')
         RETURNING id, name, email, slug, plan, trial_length_days, trial_started_at, trial_ends_at, billing_status`,
        [name, email, plan, slug, trial.trial_length_days, trial.trial_started_at, trial.trial_ends_at]
      );
      const client = clientRes.rows[0];

      // Create admin user with temp password
      const tempPassword = `Dam${crypto.randomBytes(8).toString('base64url')}!`;
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const userRes = await dbClient.query(
        `INSERT INTO users (client_id, email, password_hash, role, email_verified)
         VALUES ($1, $2, $3, 'admin', true) RETURNING id, email, role`,
        [client.id, email, passwordHash]
      );

      // Generate access code
      const code = generateAccessCode();
      await dbClient.query(
        `INSERT INTO access_codes (client_id, code) VALUES ($1, $2)`,
        [client.id, code]
      );

      await dbClient.query('COMMIT');

      res.status(201).json({
        data: {
          client,
          user: userRes.rows[0],
          credentials: {
            email,
            temp_password: tempPassword,
            access_code: code,
          },
          message: 'Client created. Share the temp password and access code with your client.',
        },
      });
    } catch (err) {
      await dbClient.query('ROLLBACK').catch(() => {});
      if (sendCreateClientDbError(err, res)) return;
      sendCreateClientUnknownError(err, res);
    } finally {
      dbClient.release();
    }
  }
);

// GET /api/admin/clients/:id — single client with full stats
router.get('/clients/:id',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const [clientRes, statsRes] = await Promise.all([
        adminQuery(`SELECT * FROM clients WHERE id = $1`, [id]),
        adminQuery(`
          SELECT
            COUNT(DISTINCT l.id) FILTER (WHERE l.deleted_at IS NULL)::int AS total_leads,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'new' AND l.deleted_at IS NULL)::int AS new_leads,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'contacted' AND l.deleted_at IS NULL)::int AS contacted,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'replied' AND l.deleted_at IS NULL)::int AS replied,
            COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'meeting_booked' AND l.deleted_at IS NULL)::int AS meetings,
            COUNT(DISTINCT m.id)::int AS total_messages,
            COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'sent')::int AS sent_messages,
            COUNT(DISTINCT m.id) FILTER (WHERE m.status = 'ranger_rejected')::int AS rejected_messages,
            COUNT(DISTINCT a.id) FILTER (WHERE a.status = 'pending')::int AS pending_approvals
          FROM clients c
          LEFT JOIN leads l ON l.client_id = c.id
          LEFT JOIN messages m ON m.client_id = c.id
          LEFT JOIN approvals a ON a.client_id = c.id
          WHERE c.id = $1
        `, [id]),
      ]);

      if (clientRes.rows.length === 0) {
        return res.status(404).json({ error: 'Client not found', code: 'NOT_FOUND' });
      }

      res.json({ data: { ...clientRes.rows[0], stats: statsRes.rows[0] } });
    } catch (err) { next(err); }
  }
);

// PATCH /api/admin/clients/:id — update client details
router.patch('/clients/:id',
  [
    param('id').isUUID(),
    body('name').optional().trim().isLength({ min: 1, max: 200 }),
    body('plan').optional().isIn(['starter', 'growth', 'enterprise']),
    body('onboarding_completed').optional().isBoolean(),
    body('auto_approve_threshold').optional({ nullable: true }).isInt({ min: 50, max: 100 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const fields = [];
      const values = [];
      let idx = 1;

      if (req.body.name !== undefined) { fields.push(`name = $${idx++}`); values.push(req.body.name); }
      if (req.body.plan !== undefined) { fields.push(`plan = $${idx++}`); values.push(req.body.plan); }
      if (req.body.onboarding_completed !== undefined) { fields.push(`onboarding_completed = $${idx++}`); values.push(req.body.onboarding_completed); }
      if (req.body.auto_approve_threshold !== undefined) {
        fields.push(`auto_approve_threshold = $${idx++}`);
        values.push(req.body.auto_approve_threshold); // null explicitly allowed
      }

      if (fields.length === 0) return res.status(400).json({ error: 'No fields to update', code: 'NO_FIELDS' });

      fields.push(`updated_at = NOW()`);
      values.push(id);

      const result = await adminQuery(
        `UPDATE clients SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );
      res.json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// USERS PER CLIENT
// ─────────────────────────────────────────────

// GET /api/admin/clients/:id/users
router.get('/clients/:id/users',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await adminQuery(
        `SELECT id, email, role, email_verified, created_at FROM users
         WHERE client_id = $1 ORDER BY created_at ASC`,
        [req.params.id]
      );
      res.json({ data: result.rows, meta: { total: result.rows.length } });
    } catch (err) { next(err); }
  }
);

// POST /api/admin/clients/:id/users — create user for a specific client
router.post('/clients/:id/users',
  [
    param('id').isUUID(),
    body('email').isEmail().normalizeEmail(),
    body('role').optional().isIn(['admin', 'user']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { email, role = 'user' } = req.body;

      const existing = await adminQuery('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered', code: 'EMAIL_TAKEN' });
      }

      const tempPassword = `Dam${crypto.randomBytes(8).toString('base64url')}!`;
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      const userRes = await adminQuery(
        `INSERT INTO users (client_id, email, password_hash, role, email_verified)
         VALUES ($1, $2, $3, $4, true) RETURNING id, email, role, created_at`,
        [id, email, passwordHash, role]
      );

      const code = generateAccessCode();
      await adminQuery(`INSERT INTO access_codes (client_id, code) VALUES ($1, $2)`, [id, code]);

      res.status(201).json({
        data: {
          user: userRes.rows[0],
          credentials: { email, temp_password: tempPassword, access_code: code },
        },
      });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// USER MANAGEMENT
// ─────────────────────────────────────────────

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const newPassword = `Dam${crypto.randomBytes(8).toString('base64url')}!`;
      const passwordHash = await bcrypt.hash(newPassword, 12);

      const result = await adminQuery(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email`,
        [passwordHash, req.params.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found', code: 'NOT_FOUND' });
      }

      res.json({ data: { user: result.rows[0], new_password: newPassword } });
    } catch (err) { next(err); }
  }
);

// PATCH /api/admin/users/:id — change role or deactivate
router.patch('/users/:id',
  [
    param('id').isUUID(),
    body('role').optional().isIn(['admin', 'user']),
    body('active').optional().isBoolean(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const fields = [];
      const values = [];
      let idx = 1;

      if (req.body.role !== undefined) { fields.push(`role = $${idx++}`); values.push(req.body.role); }
      // Deactivate/reactivate using proper deactivated_at column
      if (req.body.active === false) { fields.push(`deactivated_at = $${idx++}`); values.push(new Date().toISOString()); }
      if (req.body.active === true) { fields.push(`deactivated_at = $${idx++}`); values.push(null); }

      if (fields.length === 0) return res.status(400).json({ error: 'No fields to update', code: 'NO_FIELDS' });
      fields.push(`updated_at = NOW()`);
      values.push(req.params.id);

      const result = await adminQuery(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, email, role`,
        values
      );
      res.json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// ACTIVITY LOGS PER CLIENT
// ─────────────────────────────────────────────

// GET /api/admin/clients/:id/logs
router.get('/clients/:id/logs',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
      const result = await adminQuery(
        `SELECT id, agent, action, target_type, target_id, metadata, created_at
         FROM logs WHERE client_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [req.params.id, limit]
      );
      res.json({ data: result.rows, meta: { total: result.rows.length } });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// BILLING PER CLIENT
// ─────────────────────────────────────────────

// GET /api/admin/clients/:id/billing — manual-invoice ledger for one client
router.get('/clients/:id/billing',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const data = await billing.getBillingSummary(req.params.id, { query: adminQuery });
      if (!data.client) return res.status(404).json({ error: 'Client not found', code: 'NOT_FOUND' });
      res.json({ data });
    } catch (err) { next(err); }
  }
);

// PATCH /api/admin/billing-intents/:id — mark manual invoice state
router.patch('/billing-intents/:id',
  [
    param('id').isUUID(),
    body('status').isIn(['pending_invoice', 'invoice_sent', 'paid', 'cancelled']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const intent = await billing.updateBillingIntentStatus(req.params.id, req.body.status, { query: adminQuery });
      if (!intent) return res.status(404).json({ error: 'Billing intent not found', code: 'NOT_FOUND' });
      res.json({ data: intent });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// CREDENTIALS STATUS PER CLIENT
// ─────────────────────────────────────────────

// GET /api/admin/clients/:id/credentials — show which API keys are configured (masked)
router.get('/clients/:id/credentials',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const secretKeys = ['apollo_api_key', 'hunter_api_key', 'gmail_tokens'];
      const result = await adminQuery(
        `SELECT key, updated_at FROM agent_memory
          WHERE client_id = $1
            AND agent = 'system'
            AND memory_type = 'secret'
            AND key = ANY($2::text[])`,
        [req.params.id, secretKeys]
      );

      // Return key names + last updated — never expose values
      const configured = {};
      for (const row of result.rows) {
        const publicKey = row.key === 'gmail_tokens' ? 'gmail_refresh_token' : row.key;
        configured[publicKey] = { configured: true, updated_at: row.updated_at };
      }

      const expected = ['apollo_api_key', 'hunter_api_key', 'gmail_refresh_token'];
      for (const k of expected) {
        if (!configured[k]) configured[k] = { configured: false, updated_at: null };
      }

      res.json({ data: configured });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// SIGNUP LINKS
// ─────────────────────────────────────────────

// POST /api/admin/clients/:id/signup-link — generate one-time invite link
router.post('/clients/:id/signup-link',
  [
    param('id').isUUID(),
    body('role').optional().isIn(['admin', 'user']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const token = await createSignupToken(req.params.id, req.user.userId, req.body.role || 'admin');
      const baseUrl = process.env.APP_URL || 'https://dam.beaver.solutions';
      res.json({ data: { url: `${baseUrl}/join?token=${token}` } });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────
// ACCESS CODES
// ─────────────────────────────────────────────

// POST /api/admin/access-codes/generate
router.post('/access-codes/generate',
  [body('client_id').isUUID(), validate],
  async (req, res, next) => {
    try {
      // Verify client exists before generating a code (gives clear 404 instead of
      // a cryptic FK violation error from the INSERT).
      const clientCheck = await adminQuery('SELECT id FROM clients WHERE id = $1', [req.body.client_id]);
      if (clientCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Client not found', code: 'CLIENT_NOT_FOUND' });
      }
      const code = generateAccessCode();
      const result = await adminQuery(
        `INSERT INTO access_codes (client_id, code) VALUES ($1, $2) RETURNING *`,
        [req.body.client_id, code]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

// DELETE /api/admin/access-codes/:id — revoke
router.delete('/access-codes/:id', [param('id').isUUID(), validate], async (req, res, next) => {
  try {
    await adminQuery(`UPDATE access_codes SET revoked = true WHERE id = $1`, [req.params.id]);
    res.json({ data: { revoked: true } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
// LEGACY — keep for backward compat
// ─────────────────────────────────────────────

// GET /api/admin/users — list users for the authenticated client (own team)
router.get('/users', async (req, res, next) => {
  try {
    const result = await adminQuery(
      `SELECT id, email, role, email_verified, created_at FROM users WHERE client_id = $1 ORDER BY created_at ASC`,
      [req.clientId]
    );
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
// LLM USAGE + BUDGET
// ─────────────────────────────────────────────

// GET /api/admin/usage — per-client daily spend + budget headroom
// Query params:
//   days=N (default 1)  → how many days of history to return
//   client_id=UUID      → optional filter to one client
router.get('/usage', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 1, 1), 30);
    const clientFilter = req.query.client_id || null;

    // Today's spend per client + budget + breakdown by agent.
    // Range predicate on created_at lets the planner use the btree index.
    const today = await adminQuery(
      `SELECT
         c.id          AS client_id,
         c.slug,
         c.name,
         c.daily_budget_usd::float                                                            AS budget_usd,
         COALESCE(SUM(u.cost_usd), 0)::float                                                  AS spend_today_usd,
         COALESCE(SUM(u.input_tokens), 0)::int                                                AS input_tokens,
         COALESCE(SUM(u.output_tokens), 0)::int                                               AS output_tokens,
         COALESCE(SUM(u.cache_read_tokens), 0)::int                                           AS cache_read_tokens,
         COALESCE(SUM(u.cache_write_tokens), 0)::int                                          AS cache_write_tokens,
         COUNT(u.id)::int                                                                     AS calls_today,
         CASE WHEN c.daily_budget_usd > 0
              THEN (COALESCE(SUM(u.cost_usd), 0) / c.daily_budget_usd)::float
              ELSE 0 END                                                                      AS pct_used
       FROM clients c
       LEFT JOIN llm_usage u
         ON u.client_id = c.id
        AND u.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
       WHERE ($1::uuid IS NULL OR c.id = $1::uuid)
       GROUP BY c.id, c.slug, c.name, c.daily_budget_usd
       ORDER BY spend_today_usd DESC, c.name ASC`,
      [clientFilter]
    );

    // Per-agent breakdown for today
    const byAgent = await adminQuery(
      `SELECT
         client_id,
         agent,
         model,
         SUM(cost_usd)::float  AS cost_usd,
         SUM(input_tokens)::int  AS input_tokens,
         SUM(output_tokens)::int AS output_tokens,
         COUNT(*)::int AS calls
       FROM llm_usage
       WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
         AND ($1::uuid IS NULL OR client_id = $1::uuid)
       GROUP BY client_id, agent, model
       ORDER BY cost_usd DESC`,
      [clientFilter]
    );

    // Historical daily totals over the requested window.
    // date_trunc on the aggregation is fine in the projection — the
    // IMMUTABLE restriction only applies to index expressions.
    const history = await adminQuery(
      `SELECT
         client_id,
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         SUM(cost_usd)::float  AS cost_usd,
         COUNT(*)::int         AS calls
       FROM llm_usage
       WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') - ($1::int - 1) * INTERVAL '1 day'
         AND ($2::uuid IS NULL OR client_id = $2::uuid)
       GROUP BY client_id, day
       ORDER BY day DESC, cost_usd DESC`,
      [days, clientFilter]
    );

    res.json({
      data: {
        today: today.rows,
        by_agent: byAgent.rows,
        history: history.rows,
      },
      meta: { days, as_of: new Date().toISOString() },
    });
  } catch (err) { next(err); }
});

// PATCH /api/admin/clients/:id/budget — change a client's daily cap
router.patch('/clients/:id/budget', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { daily_budget_usd } = req.body;
    const amount = Number(daily_budget_usd);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000) {
      return res.status(400).json({ error: 'daily_budget_usd must be a number between 0 and 1000', code: 'INVALID_BUDGET' });
    }
    const result = await adminQuery(
      `UPDATE clients SET daily_budget_usd = $1 WHERE id = $2 RETURNING id, slug, name, daily_budget_usd::float`,
      [amount, id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Client not found' });
    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
// TELEGRAM
// ─────────────────────────────────────────────

// POST /api/admin/telegram/unregister-webhook
// One-time call to hand Telegram control to MyClaw.
// After this, The Dam only SENDS via Jarvis (no incoming webhook).
router.post('/telegram/unregister-webhook', async (req, res, next) => {
  try {
    const telegramService = require('../services/telegram');
    const result = await telegramService.deleteWebhook();
    if (result.ok) {
      res.json({ data: { status: 'webhook_deleted', description: result.description } });
    } else {
      res.status(500).json({ error: result.description || 'Failed to delete webhook', code: 'TELEGRAM_ERROR' });
    }
  } catch (err) { next(err); }
});

// GET /api/admin/telegram/webhook-info
// Check current webhook status — useful to confirm state before/after.
router.get('/telegram/webhook-info', async (req, res, next) => {
  try {
    const https = require('https');
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!TOKEN) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });

    const result = await new Promise((resolve, reject) => {
      const req2 = https.get(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`, (r) => {
        let buf = '';
        r.on('data', c => buf += c);
        r.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
      });
      req2.on('error', reject);
    });

    res.json({ data: result });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────
// SQL — execute raw SQL (super admin only, read + write)
// ─────────────────────────────────────────────

router.post('/sql', async (req, res, next) => {
  try {
    if (!ADMIN_SQL_ENABLED) {
      return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    }

    const { query, params = [] } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query required', code: 'MISSING_QUERY' });
    }
    const result = await adminQuery(query, params);
    res.json({
      data: result.rows || [],
      meta: {
        rowCount: result.rowCount,
        command: result.command,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || 'SQL_ERROR' });
  }
});

module.exports = router;
