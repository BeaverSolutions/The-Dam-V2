'use strict';

const router = require('express').Router();
const telegram = require('../services/telegram');
const agentsService = require('../services/agents');
const pool = require('../db/pool');
const logger = require('../utils/logger');

const BOT_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// ─── Pending plan storage (DB-backed) ─────────────────────────
// Previously an in-process Map; lost on every deploy/restart. Now persisted
// in telegram_pending_plans with a 1-hour expiry so "Approve" buttons
// survive Railway redeploys. See migration 018.

async function savePendingPlan(chatId, clientId, plan) {
  await pool.query(
    `INSERT INTO telegram_pending_plans
       (chat_id, client_id, plan_id, command, steps, interpretation, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW() + INTERVAL '1 hour')
     ON CONFLICT (chat_id) DO UPDATE SET
       client_id = EXCLUDED.client_id,
       plan_id = EXCLUDED.plan_id,
       command = EXCLUDED.command,
       steps = EXCLUDED.steps,
       interpretation = EXCLUDED.interpretation,
       created_at = NOW(),
       expires_at = EXCLUDED.expires_at`,
    [chatId, clientId, plan.planId, plan.command, JSON.stringify(plan.steps || []), plan.interpretation || null]
  );
}

async function getPendingPlan(chatId) {
  const { rows } = await pool.query(
    `SELECT plan_id, command, steps, interpretation
       FROM telegram_pending_plans
      WHERE chat_id = $1 AND expires_at > NOW()
      LIMIT 1`,
    [chatId]
  );
  if (rows.length === 0) return null;
  return {
    planId: rows[0].plan_id,
    command: rows[0].command,
    steps: rows[0].steps,
    interpretation: rows[0].interpretation,
  };
}

async function deletePendingPlan(chatId) {
  await pool.query(`DELETE FROM telegram_pending_plans WHERE chat_id = $1`, [chatId]);
}

// Periodic cleanup of expired plans (hourly). Cheap — single DELETE with
// an index on expires_at. Keeps the table bounded.
setInterval(() => {
  pool.query(`DELETE FROM telegram_pending_plans WHERE expires_at < NOW()`)
    .catch(err => logger.warn({ msg: 'telegram pending plan cleanup failed', err: err.message }));
}, 60 * 60 * 1000).unref();

// Resolve a Telegram chat ID to a The Dam client ID
// Mapping is driven by env vars: TELEGRAM_CHAT_ID + TELEGRAM_CLIENT_SLUG
async function resolveClient(chatId) {
  const envChatId = process.env.TELEGRAM_CHAT_ID;
  if (!envChatId || String(chatId) !== String(envChatId)) return null;
  const slug = process.env.TELEGRAM_CLIENT_SLUG || 'beaver-solutions';
  const { rows } = await pool.query(
    `SELECT id FROM clients WHERE slug = $1 LIMIT 1`,
    [slug]
  );
  return rows[0]?.id || null;
}

function formatPlan(plan) {
  const lines = [`<b>Plan ready</b>`, ''];
  if (plan.interpretation && plan.interpretation !== plan.command) {
    lines.push(`<i>${plan.interpretation}</i>`, '');
  }
  if (plan.steps?.length) {
    lines.push('<b>Steps:</b>');
    plan.steps.forEach((s, i) => {
      const agent = s.agent ? `[${s.agent.replace('_', ' ')}] ` : '';
      lines.push(`${i + 1}. ${agent}${s.action}`);
    });
  }
  return lines.join('\n');
}

function formatResult(result) {
  if (!result) return 'Done.';
  const s = result.summary || {};
  const appUrl = process.env.FRONTEND_URL || 'https://app.beaver.solutions';
  const lines = [`<b>Complete.</b>`, ''];

  // List each lead
  const leads = result.leads || [];
  if (leads.length) {
    lines.push(`<b>Leads found (${leads.length}):</b>`);
    leads.forEach((l, i) => {
      const title = l.title ? ` · ${l.title}` : '';
      lines.push(`${i + 1}. <b>${l.name}</b> — ${l.company}${title}`);
    });
    lines.push('');
  }

  if (s.messages_drafted !== undefined) lines.push(`Messages drafted: <b>${s.messages_drafted}</b>`);

  if (s.pending_approvals !== undefined && s.pending_approvals > 0) {
    lines.push(`\n<a href="${appUrl}/approvals">Review ${s.pending_approvals} approval${s.pending_approvals !== 1 ? 's' : ''} →</a>`);
  } else {
    lines.push(`\n<a href="${appUrl}/approvals">Go to approvals →</a>`);
  }

  return lines.join('\n');
}

// ─── Webhook (receives all Telegram updates) ──────────────────────────────────
router.post('/webhook', async (req, res) => {
  // Validate Telegram's secret token header
  const { safeCompare } = require('../utils/crypto');
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!BOT_SECRET || !safeCompare(secret, BOT_SECRET)) {
    return res.sendStatus(403);
  }

  // Acknowledge to Telegram immediately — always 200
  res.sendStatus(200);

  const update = req.body;

  try {
    // ── Inline button press (approve / reject) ──────────────────────────────
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = String(cq.message.chat.id);
      const [action, planId] = (cq.data || '').split(':');

      await telegram.answerCallbackQuery(cq.id);

      const pending = await getPendingPlan(chatId);
      if (!pending || pending.planId !== planId) {
        await telegram.editMessageText(cq.message.chat.id, cq.message.message_id,
          'This plan has expired. Send a new command.');
        return;
      }

      if (action === 'reject') {
        await deletePendingPlan(chatId);
        await telegram.editMessageText(cq.message.chat.id, cq.message.message_id,
          `${formatPlan(pending)}\n\n<b>Rejected.</b>`);
        return;
      }

      // Approve — update message to show executing state
      await telegram.editMessageText(cq.message.chat.id, cq.message.message_id,
        `${formatPlan(pending)}\n\n<i>Running...</i>`);

      await deletePendingPlan(chatId);

      const clientId = await resolveClient(cq.message.chat.id);
      if (!clientId) {
        await telegram.sendMessage(cq.message.chat.id,
          'Could not resolve client. Check TELEGRAM_CHAT_ID env var.');
        return;
      }

      const result = await agentsService.directorExecute(clientId, {
        plan_id: planId,
        command: pending.command,
      });

      await telegram.sendMessage(cq.message.chat.id, formatResult(result));
      return;
    }

    // ── Incoming text message ───────────────────────────────────────────────
    if (update.message?.text) {
      const msg = update.message;
      const chatId = String(msg.chat.id);
      const text = msg.text.trim();

      if (text === '/start' || text === '/help') {
        await telegram.sendMessage(msg.chat.id,
          `<b>BeavrDam — Director</b>\n\nSend me a command and I'll build a plan.\n\n<b>Examples:</b>\n• Find 10 SaaS leads in London\n• Follow up on active conversations\n• Run the morning kickoff\n• Show me today's pipeline`);
        return;
      }

      const clientId = await resolveClient(msg.chat.id);
      if (!clientId) {
        await telegram.sendMessage(msg.chat.id,
          'This chat is not linked to a client account. Set <code>TELEGRAM_CHAT_ID</code> and <code>TELEGRAM_CLIENT_SLUG</code> in the server environment.');
        return;
      }

      await telegram.sendChatAction(msg.chat.id, 'typing');

      const plan = await agentsService.directorPlan(clientId, { command: text });

      if (plan.status === 'out_of_scope' || plan.status === 'clarification_needed') {
        await telegram.sendMessage(msg.chat.id, plan.message || 'Could you clarify?');
        return;
      }

      // Store pending plan for approval (persisted — survives restarts)
      await savePendingPlan(chatId, clientId, {
        planId: plan.plan_id,
        command: text,
        steps: plan.steps,
        interpretation: plan.interpretation,
      });

      await telegram.sendMessage(msg.chat.id, formatPlan(plan), {
        reply_markup: JSON.stringify({
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${plan.plan_id}` },
            { text: '❌ Reject',  callback_data: `reject:${plan.plan_id}` },
          ]],
        }),
      });
    }
  } catch (err) {
    logger.error({ msg: 'Telegram webhook error', err: err.message, stack: err.stack });
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      telegram.sendMessage(chatId, 'Something went wrong. Check BeavrDam logs for details.').catch(() => {});
    }
  }
});

// ─── One-time webhook setup ────────────────────────────────────────────────────
// POST /api/telegram/set-webhook
// Call this once after deploying to register the webhook URL with Telegram.
function requireInternalKey(req, res, next) {
  const { safeCompare } = require('../utils/crypto');
  const key = req.headers['x-internal-key'];
  if (!process.env.INTERNAL_API_KEY || !safeCompare(key, process.env.INTERNAL_API_KEY)) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_KEY' });
  }
  next();
}

router.post('/set-webhook', requireInternalKey, async (req, res, next) => {
  try {
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.SERVER_DOMAIN;
    if (!domain) {
      return res.status(400).json({ error: 'Set RAILWAY_PUBLIC_DOMAIN or SERVER_DOMAIN env var first' });
    }
    const webhookUrl = `https://${domain}/api/telegram/webhook`;
    const result = await telegram.setWebhook(webhookUrl, BOT_SECRET);
    logger.info({ msg: 'Telegram webhook registered', url: webhookUrl, result });
    res.json({ data: { url: webhookUrl, telegram: result } });
  } catch (err) { next(err); }
});

// DELETE /api/telegram/set-webhook — remove webhook (switch back to polling)
router.delete('/set-webhook', requireInternalKey, async (req, res, next) => {
  try {
    const result = await telegram.deleteWebhook();
    res.json({ data: result });
  } catch (err) { next(err); }
});

module.exports = router;
