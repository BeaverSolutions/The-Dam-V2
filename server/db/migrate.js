'use strict';
const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const logger = require('../utils/logger');

async function runMigrations() {
  const client = await pool.connect();
  try {
    // Ensure schema_migrations exists (bootstrap)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      const existing = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version]
      );
      if (existing.rows.length > 0) {
        logger.info({ msg: `Migration ${version} already applied, skipping` });
        continue;
      }
      logger.info({ msg: `Applying migration ${file}` });
      const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      );
      logger.info({ msg: `Migration ${file} applied successfully` });
    }
  } finally {
    client.release();
  }
}

module.exports = { runMigrations };
