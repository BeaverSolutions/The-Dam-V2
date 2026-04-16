'use strict';

const router = require('express').Router();
const telegram = require('../services/telegram');
const captainBeaver = require('../services/captainBeaver');
const pool = require('../db/pool');
const logger = require('../utils/logger');
const {
  getTelegramHistory,
  saveTelegramHistory,
} = require('../services/learningEngine');

const BOT_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// ─── Periodic cleanup of expired plans (legacy table — kept for safety) ──────
setInterval(() => {
  pool.query(`DELETE FROM telegram_pending_plans WHERE expires_at < NOW()`)
    .catch(err => logger.warn({ msg: 'telegram pending plan cleanup failed', err: err.message }));
}, 60 * 60 * 1000).unref();

// ─── Resolve a Telegram chat ID to a BeavrDam client ID ───────────────────
// Driven by env vars: TELEGRAM_CHAT_ID + TELEGRAM_CLIENT_SLUG
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
    // ── Inline button press ─────────────────────────────────────────────────
    // Legacy plan approve/reject buttons from old flow — answer and dismiss.
    if (update.callback_query) {
      const cq = update.callback_query;
      await telegram.answerCallbackQuery(cq.id);
      await telegram.editMessageText(
        cq.message.chat.id,
        cq.message.message_id,
        `<i>This approval button has expired. Use the BeavrDam app to approve or reject messages.</i>`
      );
      return;
    }

    // ── Incoming text message ───────────────────────────────────────────────
    if (update.message?.text) {
      const msg = update.message;
      const chatId = String(msg.chat.id);
      const text = msg.text.trim();

      if (text === '/start' || text === '/help') {
        await telegram.sendMessage(
          msg.chat.id,
          `<b>BeavrDam — Captain Beaver</b>\n\nI'm your AI sales director. Talk to me like you'd talk to Jarvis.\n\n<b>Examples:</b>\n• Run kickoff for today\n• Find 15 SaaS founders in KL\n• What's pending approval?\n• Show me today's pipeline\n• How many leads do we have?\n• What happened in the last 24 hours?`
        );
        return;
      }

      const clientId = await resolveClient(msg.chat.id);
      if (!clientId) {
        await telegram.sendMessage(
          msg.chat.id,
          'This chat is not linked to a client account. Set <code>TELEGRAM_CHAT_ID</code> and <code>TELEGRAM_CLIENT_SLUG</code> in the server environment.'
        );
        return;
      }

      await telegram.sendChatAction(msg.chat.id, 'typing');

      // Load DB-backed history so Captain remembers the conversation across restarts
      const history = await getTelegramHistory(clientId, chatId);

      // Route to Captain Beaver — same brain as the web chat, full tool access
      const result = await captainBeaver.handleChat(clientId, text, { history });

      const reply = result?.message || 'Done.';

      // Append this turn to history and persist
      const updatedHistory = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: reply },
      ];
      await saveTelegramHistory(clientId, chatId, updatedHistory);

      // Send reply — Telegram HTML parse mode, 4096 char limit per message
      const chunks = splitMessage(reply, 4096);
      for (const chunk of chunks) {
        await telegram.sendMessage(msg.chat.id, chunk);
      }
    }
  } catch (err) {
    logger.error({ msg: 'Telegram webhook error', err: err.message, stack: err.stack });
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
    if (chatId) {
      telegram.sendMessage(chatId, 'Something went wrong. Check BeavrDam logs.').catch(() => {});
    }
  }
});

// ─── Split long messages into Telegram-safe chunks ────────────────────────
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let cutAt = remaining.lastIndexOf('\n', maxLen);
    if (cutAt < maxLen * 0.5) cutAt = maxLen; // No good newline — hard cut
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

// ─── One-time webhook setup ────────────────────────────────────────────────────
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

router.delete('/set-webhook', requireInternalKey, async (req, res, next) => {
  try {
    const result = await telegram.deleteWebhook();
    res.json({ data: result });
  } catch (err) { next(err); }
});

module.exports = router;
