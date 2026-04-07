'use strict';

const { Client, Events, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const pool = require('../db/pool');

const BEAVER_CLIENT_ID = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';

let client = null;
let loginPromise = null;

/* ─── Shared data helpers ──────────────────────────────────── */

/**
 * Fetch recent replies from the DB for BEAVER_CLIENT_ID (last 24 hours).
 * Returns { rowCount, text } where text is the formatted plain-text summary.
 * Throws on DB error.
 */
async function fetchRecentRepliesSummary() {
  logger.info({ msg: 'Discord fetchRecentRepliesSummary querying DB', clientId: BEAVER_CLIENT_ID });

  const result = await pool.query(
    `SELECT m.id, m.reply_snippet, m.reply_detected_at,
            l.name AS lead_name, l.company AS lead_company
     FROM messages m
     LEFT JOIN leads l ON l.id = m.lead_id
     WHERE m.client_id = $1
       AND m.reply_detected_at > NOW() - INTERVAL '24 hours'
     ORDER BY m.reply_detected_at DESC
     LIMIT 10`,
    [BEAVER_CLIENT_ID]
  );

  const rows = result.rows;
  const rowCount = result.rowCount;

  logger.info({ msg: 'Discord fetchRecentRepliesSummary DB result', rowCount });

  if (rowCount === 0) {
    return { rowCount, text: 'Recent replies: 0' };
  }

  const lines = rows.map((r, i) =>
    `${i + 1}. ${r.lead_name || 'Unknown'} — ${r.lead_company || 'Unknown'}`
  );

  return { rowCount, text: `Recent replies: ${rowCount}\n${lines.join('\n')}` };
}

/* ─── Command handlers ─────────────────────────────────────── */

async function handleReplies(message) {
  logger.info({ msg: 'Discord !replies handler entered' });

  try {
    const { text } = await fetchRecentRepliesSummary();
    await message.reply(text);
  } catch (err) {
    logger.error({
      msg: 'Discord !replies failed',
      err: err.message,
      stack: err.stack,
    });
    await message.reply('Failed to fetch replies.').catch(() => {});
  }
}

async function handlePostReplies(message) {
  logger.info({ msg: 'Discord !post-replies handler entered', guildId: message.guildId });

  try {
    const { text } = await fetchRecentRepliesSummary();

    // Force-fetch all channels so the cache is fully populated.
    // Without this, channels the bot hasn't seen since startup won't appear.
    await message.guild.channels.fetch();

    // Log every text channel visible to the bot for diagnostics
    const allTextChannels = message.guild.channels.cache
      .filter((ch) => ch.type === ChannelType.GuildText)
      .map((ch) => ({ name: ch.name, id: ch.id }));
    logger.info({
      msg: 'Discord !post-replies: visible text channels',
      guildId: message.guildId,
      channels: JSON.stringify(allTextChannels),
    });

    // Find the channel named exactly 'replies'
    const repliesChannel = message.guild.channels.cache.find(
      (ch) => ch.name === 'replies' && ch.type === ChannelType.GuildText
    );

    if (!repliesChannel) {
      logger.warn({
        msg: 'Discord !post-replies: #replies channel not found',
        guildId: message.guildId,
      });
      await message.reply('Could not find #replies channel.');
      return;
    }

    logger.info({
      msg: 'Discord !post-replies: target channel resolved',
      channelName: repliesChannel.name,
      channelId: repliesChannel.id,
      guildId: message.guildId,
    });

    logger.info({
      msg: 'Discord !post-replies: sending message',
      content: text,
    });

    // Only mark success after the send actually resolves
    await repliesChannel.send(text);

    logger.info({
      msg: 'Discord !post-replies: send succeeded',
      channelId: repliesChannel.id,
    });

    await message.reply('Posted replies to #replies.');
  } catch (err) {
    logger.error({
      msg: 'Discord !post-replies failed',
      err: err.message,
      stack: err.stack,
    });
    await message.reply('Failed to post replies.').catch(() => {});
  }
}

async function handleApprovals(message) {
  logger.info({ msg: 'Discord !approvals handler entered' });

  try {
    logger.info({ msg: 'Discord !approvals querying DB', clientId: BEAVER_CLIENT_ID });

    const result = await pool.query(
      `SELECT a.id, l.name AS lead_name, l.company AS lead_company
       FROM approvals a
       JOIN messages m ON m.id = a.message_id
       LEFT JOIN leads l ON l.id = m.lead_id
       WHERE a.client_id = $1 AND a.status = 'pending'
       ORDER BY a.created_at DESC
       LIMIT 10`,
      [BEAVER_CLIENT_ID]
    );

    const rows = result.rows;
    const rowCount = result.rowCount;

    logger.info({ msg: 'Discord !approvals DB result', rowCount, rows: JSON.stringify(rows) });

    if (rowCount === 0) {
      await message.reply('Pending approvals: 0');
      return;
    }

    if (!rows || rows.length === 0) {
      await message.reply('Approvals command ran, but no valid data was returned.');
      return;
    }

    const lines = rows.map((r, i) =>
      `${i + 1}. ${r.lead_name || 'Unknown'} — ${r.lead_company || 'Unknown'}`
    );
    await message.reply(`Pending approvals: ${rowCount}\n${lines.join('\n')}`);
  } catch (err) {
    logger.error({
      msg: 'Discord !approvals failed',
      err: err.message,
      stack: err.stack,
    });
    await message.reply('Failed to fetch approvals.').catch(() => {});
  }
}

/**
 * Post the recent replies summary to a named channel in a specific guild.
 * Intended for use by background workflows (e.g. scheduled tasks, replyDetector hooks).
 *
 * @param {string} guildId   - Discord guild (server) ID
 * @param {string} channelName - Target channel name (default: 'replies')
 */
async function postRepliesToChannel(guildId, channelName = 'replies') {
  if (!client) {
    logger.warn({ msg: 'postRepliesToChannel called but Discord client is not ready' });
    return;
  }

  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch(); // populate cache

    const channel = guild.channels.cache.find(
      (ch) => ch.name === channelName && ch.type === ChannelType.GuildText
    );

    if (!channel) {
      logger.warn({ msg: 'postRepliesToChannel: channel not found', guildId, channelName });
      return;
    }

    const { text } = await fetchRecentRepliesSummary();
    await channel.send(text);
    logger.info({ msg: 'postRepliesToChannel: posted', guildId, channelName, channelId: channel.id });
  } catch (err) {
    logger.error({
      msg: 'postRepliesToChannel failed',
      err: err.message,
      stack: err.stack,
    });
  }
}

/**
 * Start the Discord bot.
 * Resolves once the client is ready. No-ops if already running.
 * If DISCORD_BOT_TOKEN is not set, logs a warning and returns.
 */
async function startDiscordBot() {
  if (!config.discord.token) {
    logger.info({ msg: 'Discord bot disabled, DISCORD_BOT_TOKEN not set' });
    return;
  }

  // Reuse existing login if already in progress / complete
  if (loginPromise) return loginPromise;

  try {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    client.on(Events.Error, (err) => {
      logger.error({ msg: 'Discord client error', err: err.message });
    });

    client.on(Events.Warn, (warning) => {
      logger.warn({ msg: 'Discord client warning', warning });
    });

    // ── Message handler ───────────────────────────────────────
    client.on(Events.MessageCreate, async (message) => {
      try {
        if (message.author.bot) return;  // ignore bots
        if (!message.guild) return;       // ignore DMs

        // Log every non-bot guild message
        logger.info({
          msg: 'Discord message received',
          content: message.content,
          channelId: message.channelId,
          guildId: message.guildId,
          author: message.author.tag || message.author.username,
        });

        if (message.content === '!ping') {
          await message.reply('pong');
        } else if (message.content === '!replies') {
          logger.info({ msg: 'Discord replies command received' });
          await handleReplies(message);
        } else if (message.content === '!post-replies') {
          logger.info({ msg: 'Discord post-replies command received' });
          await handlePostReplies(message);
        } else if (message.content === '!approvals') {
          logger.info({ msg: 'Discord approvals command received' });
          await handleApprovals(message);
        } else if (message.content === '!status') {
          const env = process.env.NODE_ENV || 'development';
          const token = config.discord.token ? 'loaded' : 'missing';
          const guild = process.env.DISCORD_GUILD_ID || 'not set';
          await message.reply(
            `Bot: online\nApp: The Dam v2\nEnvironment: ${env}\nDiscord token: ${token}\nGuild ID: ${guild}`
          );
        }
      } catch (err) {
        logger.error({ msg: 'Discord message handler error', err: err.message });
      }
    });

    loginPromise = new Promise((resolve, reject) => {
      client.once(Events.ClientReady, (readyClient) => {
        logger.info({
          msg: 'Discord bot ready',
          botTag: readyClient.user.tag,
          guildId: config.discord.guildId || 'not set',
        });
        resolve();
      });

      client.login(config.discord.token).catch((err) => {
        logger.error({ msg: 'Discord bot login failed', err: err.message });
        reject(err);
      });
    });

    await loginPromise;
  } catch (err) {
    // Reset so a future call can retry
    client = null;
    loginPromise = null;
    throw err;
  }
}

/** Return the live Discord.js Client (or null if not started). */
function getDiscordClient() {
  return client;
}

module.exports = { startDiscordBot, getDiscordClient, postRepliesToChannel };
