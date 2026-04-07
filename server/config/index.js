'use strict';

const config = {
  port: parseInt(process.env.PORT, 10) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',
  database: {
    connectionString: process.env.DATABASE_URL,
    maxConnections: 20,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: '24h',
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY,
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/integrations/gmail/callback',
  },
  discord: {
    token: process.env.DISCORD_BOT_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    enabled: Boolean(process.env.DISCORD_BOT_TOKEN),
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  rateLimit: {
    windowMs: 60 * 1000,
    max: 100,
  },
};

if (!config.jwt.secret) {
  throw new Error('JWT_SECRET environment variable is required. Generate with: openssl rand -base64 48');
}

module.exports = config;
