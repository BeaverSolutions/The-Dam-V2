'use strict';

const pool = require('../db/pool');
const logs = require('./logs');

const TRIAL_LENGTHS = [14, 30];
const PLAN_KEYS = ['starter', 'growth', 'enterprise'];

// Commercial terms per MJ's current instruction, restoring the sales-deck
// 6-month option. All three app plans use the same early pricing until the
// packaging split is made explicit.
const BILLING_PLAN_OPTIONS = [
  {
    term: 'monthly',
    label: 'Monthly',
    months: 1,
    monthly_amount_rm: 2500,
    total_amount_rm: 2500,
    currency: 'MYR',
  },
  {
    term: 'six_months',
    label: '6 months',
    months: 6,
    monthly_amount_rm: 2250,
    total_amount_rm: 13500,
    currency: 'MYR',
  },
  {
    term: 'annual',
    label: '1 year',
    months: 12,
    monthly_amount_rm: 1500,
    total_amount_rm: 18000,
    currency: 'MYR',
  },
];

function normalizePlan(plan) {
  const value = String(plan || 'growth').toLowerCase();
  if (!PLAN_KEYS.includes(value)) throw new Error('Unsupported billing plan');
  return value;
}

function normalizeTerm(term) {
  const value = String(term || '').toLowerCase();
  const option = BILLING_PLAN_OPTIONS.find(item => item.term === value);
  if (!option) throw new Error('Unsupported billing term');
  return option;
}

function calculateTrialWindow(lengthDays, startDate = new Date()) {
  const days = Number(lengthDays);
  if (!TRIAL_LENGTHS.includes(days)) throw new Error('Unsupported trial length');

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) throw new Error('Invalid trial start date');

  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    trial_length_days: days,
    trial_started_at: start.toISOString(),
    trial_ends_at: end.toISOString(),
  };
}

function calculateBillingIntent({ plan, term }) {
  const normalizedPlan = normalizePlan(plan);
  const option = normalizeTerm(term);
  return {
    plan: normalizedPlan,
    term: option.term,
    currency: option.currency,
    monthly_amount_rm: option.monthly_amount_rm,
    months: option.months,
    total_amount_rm: option.total_amount_rm,
  };
}

async function getBillingSummary(clientId, { query = (...args) => pool.query(...args) } = {}) {
  const [clientRes, intentsRes] = await Promise.all([
    query(
      `SELECT id, name, plan, trial_length_days, trial_started_at, trial_ends_at, billing_status
       FROM clients
       WHERE id = $1`,
      [clientId]
    ),
    query(
      `SELECT id, client_id, plan, term, currency, monthly_amount_rm::int,
              months, total_amount_rm::int, status, requested_by, confirmed_at,
              invoice_sent_at, paid_at, cancelled_at, notes, created_at, updated_at
       FROM billing_intents
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [clientId]
    ),
  ]);

  const intents = intentsRes.rows;
  const activeStatuses = new Set(['pending_invoice', 'invoice_sent', 'paid']);
  const accumulated = intents
    .filter(intent => activeStatuses.has(intent.status))
    .reduce((sum, intent) => sum + Number(intent.total_amount_rm || 0), 0);

  return {
    client: clientRes.rows[0] || null,
    plan_options: BILLING_PLAN_OPTIONS,
    trial_options: TRIAL_LENGTHS,
    intents,
    accumulated_charges_rm: accumulated,
    pending_charges_rm: intents
      .filter(intent => intent.status === 'pending_invoice' || intent.status === 'invoice_sent')
      .reduce((sum, intent) => sum + Number(intent.total_amount_rm || 0), 0),
  };
}

async function createBillingIntent(clientId, requestedBy, { plan, term, notes }) {
  const calculated = calculateBillingIntent({ plan, term });
  const result = await pool.query(
    `INSERT INTO billing_intents
       (client_id, plan, term, currency, monthly_amount_rm, months, total_amount_rm,
        status, requested_by, confirmed_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_invoice', $8, NOW(), $9)
     RETURNING id, client_id, plan, term, currency, monthly_amount_rm::int,
               months, total_amount_rm::int, status, requested_by, confirmed_at,
               invoice_sent_at, paid_at, cancelled_at, notes, created_at, updated_at`,
    [
      clientId,
      calculated.plan,
      calculated.term,
      calculated.currency,
      calculated.monthly_amount_rm,
      calculated.months,
      calculated.total_amount_rm,
      requestedBy,
      notes || null,
    ]
  );

  const intent = result.rows[0];
  await pool.query(
    `UPDATE clients
        SET plan = $1, billing_status = 'pending_invoice', updated_at = NOW()
      WHERE id = $2`,
    [intent.plan, clientId]
  );

  logs.createLog(clientId, {
    agent: 'billing',
    action: 'upgrade_intent_confirmed',
    target_type: 'billing_intent',
    target_id: intent.id,
    metadata: {
      plan: intent.plan,
      term: intent.term,
      total_amount_rm: intent.total_amount_rm,
      status: intent.status,
    },
  }).catch(() => {});

  notifyUpgradeIntent(clientId, intent).catch(err => {
    console.warn('[billing] upgrade-intent email notification failed:', err.message);
  });

  return intent;
}

async function notifyUpgradeIntent(clientId, intent) {
  const recipient = process.env.BILLING_NOTIFY_EMAIL;
  if (!recipient) return { sent: false, reason: 'BILLING_NOTIFY_EMAIL not set' };

  const notifySlug = process.env.BILLING_NOTIFY_CLIENT_SLUG || 'beaver-solutions';
  const notifyClient = await pool.query(
    `SELECT id FROM clients WHERE slug = $1 OR email = $2 ORDER BY created_at ASC LIMIT 1`,
    [notifySlug, recipient]
  );
  if (notifyClient.rows.length === 0) return { sent: false, reason: 'notification sender client not found' };

  const clientRes = await pool.query(
    `SELECT name, email, slug FROM clients WHERE id = $1`,
    [clientId]
  );
  const client = clientRes.rows[0] || {};

  const gmail = require('./gmail');
  const option = BILLING_PLAN_OPTIONS.find(item => item.term === intent.term);
  return gmail.sendEmail(notifyClient.rows[0].id, {
    to: recipient,
    subject: `BeavrDam upgrade intent: ${client.name || client.slug || clientId}`,
    body: [
      `${client.name || client.slug || clientId} confirmed upgrade intent.`,
      '',
      `Client email: ${client.email || 'unknown'}`,
      `Plan: ${intent.plan}`,
      `Term: ${option?.label || intent.term}`,
      `Amount: RM ${Number(intent.total_amount_rm).toLocaleString()} (${intent.months} month${intent.months === 1 ? '' : 's'} at RM ${Number(intent.monthly_amount_rm).toLocaleString()}/mo)`,
      '',
      'Next step: generate invoice with payment details and send it manually.',
    ].join('\n'),
  });
}

async function updateBillingIntentStatus(intentId, status, { query = (...args) => pool.query(...args) } = {}) {
  const allowed = ['pending_invoice', 'invoice_sent', 'paid', 'cancelled'];
  if (!allowed.includes(status)) throw new Error('Unsupported billing status');

  const statusField = {
    invoice_sent: 'invoice_sent_at',
    paid: 'paid_at',
    cancelled: 'cancelled_at',
  }[status];

  const setTimestamp = statusField ? `, ${statusField} = COALESCE(${statusField}, NOW())` : '';
  const result = await query(
    `UPDATE billing_intents
        SET status = $1,
            updated_at = NOW()
            ${setTimestamp}
      WHERE id = $2
      RETURNING id, client_id, plan, term, currency, monthly_amount_rm::int,
                months, total_amount_rm::int, status, requested_by, confirmed_at,
                invoice_sent_at, paid_at, cancelled_at, notes, created_at, updated_at`,
    [status, intentId]
  );
  if (result.rows.length === 0) return null;

  const intent = result.rows[0];
  const clientBillingStatus = {
    pending_invoice: 'pending_invoice',
    invoice_sent: 'invoice_sent',
    paid: 'active',
    cancelled: 'trial',
  }[status];

  await query(
    `UPDATE clients SET billing_status = $1, updated_at = NOW() WHERE id = $2`,
    [clientBillingStatus, intent.client_id]
  );

  return intent;
}

module.exports = {
  BILLING_PLAN_OPTIONS,
  TRIAL_LENGTHS,
  calculateBillingIntent,
  calculateTrialWindow,
  createBillingIntent,
  getBillingSummary,
  updateBillingIntentStatus,
};
