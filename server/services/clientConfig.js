'use strict';

/**
 * clientConfig.js
 *
 * Reads a client's config.md file from the clients/ folder in the repo.
 * Works exactly like Cowork reading CLAUDE.md — the file is the source of truth.
 *
 * Usage:
 *   const { getClientConfig, buildClientContext } = require('./clientConfig');
 *   const config = await getClientConfig(clientId);
 *   const context = buildClientContext(config);  // inject into agent prompt
 *
 * To update a client's config: edit clients/<slug>/config.md → git push → auto-deploy.
 */

const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

// Cache configs in memory — reloaded on each server restart (i.e. each deploy)
const configCache = new Map();

/**
 * Get the config.md content for a client, by client_id.
 * Falls back gracefully if file not found.
 */
async function getClientConfig(clientId) {
  // Check cache first
  if (configCache.has(clientId)) return configCache.get(clientId);

  // Look up slug from DB
  const { rows } = await pool.query(
    `SELECT slug, name FROM clients WHERE id = $1 LIMIT 1`,
    [clientId]
  );
  const client = rows[0];
  if (!client?.slug) return null;

  const configPath = path.join(__dirname, '..', '..', 'clients', client.slug, 'config.md');

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = { slug: client.slug, name: client.name, raw: content };
    configCache.set(clientId, config);
    console.log(`[clientConfig] Loaded config for ${client.slug}`);
    return config;
  } catch {
    console.warn(`[clientConfig] No config file found for ${client.slug} at ${configPath}`);
    return null;
  }
}

/**
 * Build an agent context string from the client config.
 * This gets prepended to agent prompts — same pattern as persona/ICP injection.
 */
function buildClientContext(config) {
  if (!config?.raw) return '';
  return `\n\nCLIENT PLAYBOOK — read this before executing:\n${config.raw}\n`;
}

/**
 * Clear the cache for a specific client (call after config update in tests).
 */
function clearCache(clientId) {
  configCache.delete(clientId);
}

/**
 * Pre-warm the cache for all clients on server startup.
 */
async function warmCache() {
  try {
    const { rows } = await pool.query(`SELECT id FROM clients WHERE slug IS NOT NULL`);
    for (const row of rows) {
      await getClientConfig(row.id);
    }
    console.log(`[clientConfig] Cache warmed for ${rows.length} clients`);
  } catch (err) {
    console.warn('[clientConfig] Cache warm failed:', err.message);
  }
}

module.exports = { getClientConfig, buildClientContext, clearCache, warmCache };
