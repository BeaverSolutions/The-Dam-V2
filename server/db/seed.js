'use strict';
const bcrypt = require('bcrypt');
const pool = require('./pool');
const logger = require('../utils/logger');

const SEED_PASSWORD = '***REMOVED***';
const SALT_ROUNDS = 12;

// Fixed UUIDs — stable across DB resets so JWTs stay valid
const CLIENTS = [
  {
    id: 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030',
    name: 'Beaver Solutions',
    email: 'admin@beaversolutions.com',
  },
  {
    id: '03dd7c7c-b04e-4c20-a942-2270a57fa440',
    name: 'TRL',
    email: 'admin@trl.com',
  },
  {
    id: '7b4f2c8d-436d-4743-83fa-60963c54c593',
    name: 'GamerExchange',
    email: 'admin@gamerexchange.com',
  },
];

async function runSeed() {
  const existing = await pool.query('SELECT COUNT(*) FROM clients');
  if (parseInt(existing.rows[0].count, 10) > 0) {
    logger.info({ msg: 'Seed data already present, skipping' });
    return;
  }

  logger.info({ msg: 'Running seed data...' });
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, SALT_ROUNDS);

  for (const clientData of CLIENTS) {
    await pool.query(
      `INSERT INTO clients (id, name, email, onboarding_completed)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [clientData.id, clientData.name, clientData.email]
    );

    await pool.query(
      `INSERT INTO users (client_id, email, password_hash, role, email_verified)
       VALUES ($1, $2, $3, 'admin', true)
       ON CONFLICT (email) DO NOTHING`,
      [clientData.id, clientData.email, passwordHash]
    );

    // Sample leads for Beaver Solutions
    if (clientData.name === 'Beaver Solutions') {
      const sampleLeads = [
        { name: 'Sarah Chen',      email: 'sarah@techcorp.io',    company: 'TechCorp',   title: 'VP Engineering',      signal_tier: 'P1', status: 'new',           pipeline_stage: 'prospecting' },
        { name: 'Marcus Webb',     email: 'marcus@growthco.com',  company: 'GrowthCo',   title: 'Head of Sales',       signal_tier: 'P2', status: 'contacted',      pipeline_stage: 'outreach' },
        { name: 'Priya Patel',     email: 'priya@scale.ai',       company: 'Scale AI',   title: 'CTO',                 signal_tier: 'P1', status: 'replied',        pipeline_stage: 'qualifying' },
        { name: "James O'Connor",  email: 'james@startup.io',     company: 'StartupIO',  title: 'CEO',                 signal_tier: 'P3', status: 'meeting_booked', pipeline_stage: 'booked' },
        { name: 'Luna Rodriguez',  email: 'luna@fintech.co',      company: 'FinTech Co', title: 'Director of Growth',  signal_tier: 'P2', status: 'new',            pipeline_stage: 'prospecting' },
      ];

      for (const lead of sampleLeads) {
        await pool.query(
          `INSERT INTO leads (client_id, name, email, company, title, signal_tier, status, pipeline_stage, score, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'apollo')`,
          [
            clientData.id, lead.name, lead.email, lead.company, lead.title,
            lead.signal_tier, lead.status, lead.pipeline_stage,
            lead.signal_tier === 'P1' ? 85 : lead.signal_tier === 'P2' ? 60 : 35,
          ]
        );
      }

      await pool.query(
        `INSERT INTO logs (client_id, agent, action, target_type, metadata)
         VALUES ($1, 'system', 'system_initialized', 'system', $2)`,
        [clientData.id, JSON.stringify({ message: 'The Dam v2 initialized successfully' })]
      );
    }

    logger.info({ msg: `Seeded client: ${clientData.name}` });
  }

  logger.info({ msg: 'Seed complete' });
}

module.exports = { runSeed };
