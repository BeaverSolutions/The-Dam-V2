'use strict';

const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const pool = require('../db/pool');

const BEAVER_CLIENT_ID = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';

let client = null;
let loginPromise = null;

/* ─── Command handlers ─────────────────────────────────────── */

async function handleApprovals(message) {
  try {
    const { rows, rowCount } = await pool.query(
      `SELECT a.id, l.name AS lead_name, l.company AS lead_company
       FROM approvals a
       JOIN messages m ON m.id = a.message_id
       LEFT JOIN leads l ON l.id = m.lead_id
       WHERE a.client_id = $1 AND a.status = 'pending'
       ORDER BY a.created_at DESC
       LIMIT 10`,
      [BEAVER_CLIENT_ID]
    );

    if (rowCount === 0) {
      await message.reply('Pending approvals: 0');
      return;
    }

    const lines = rows.map((r, i) =>
      `${i + 1}. ${r.lead_name || 'Unknown'} — ${r.lead_company || 'Unknown'}`
    );
    await message.reply(`Pending approvals: ${rowCount}\n${lines.join('\n')}`);
  } catch (err) {
    logger.error({ msg: 'Discord !approvals failed', err: err.message });
    await message.reply('Failed to fetch approvals.').catch(() => {});
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
        if (message.author.bot) return;           // ignore bots
        if (!message.guild) return;                // ignore DMs
        if (message.content === '!ping') {
          await message.reply('pong');
        } else if (message.content === '!approvals') {
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

module.exports = { startDiscordBot, getDiscordClient };
