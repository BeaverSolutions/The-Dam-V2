'use strict';

const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');

let client = null;
let loginPromise = null;

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
