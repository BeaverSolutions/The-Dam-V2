'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const logger = require('../utils/logger');

// POST /api/import/leads
// Body: { rows: [...], mapping: { name, email, company, title, linkedin_url, website, industry, company_size, signal, notes } }
router.post('/leads', async (req, res, next) => {
  try {
    const clientId = req.clientId;
    const { rows, mapping } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'No rows provided', code: 'NO_ROWS' });
    }
    if (!mapping || (!mapping.name && !mapping.company)) {
      return res.status(400).json({ error: 'Mapping must include at least name or company', code: 'INVALID_MAPPING' });
    }
    if (rows.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 rows per import', code: 'TOO_MANY_ROWS' });
    }

    const get = (row, field) => {
      if (!field || !row[field]) return null;
      const val = String(row[field]).trim();
      return val.length > 1000 ? val.substring(0, 1000) : val;
    };

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    const errors = [];

    for (const row of rows) {
      const name    = get(row, mapping.name)    || get(row, mapping.company) || 'Unknown Contact';
      const company = get(row, mapping.company) || 'Unknown Company';
      const email   = get(row, mapping.email);

      // Skip blank rows
      if (name === 'Unknown Contact' && company === 'Unknown Company') {
        skipped++;
        continue;
      }

      // Dedup by email
      if (email) {
        const dup = await pool.query(
          `SELECT id FROM leads WHERE client_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
          [clientId, email]
        );
        if (dup.rows.length > 0) {
          skipped++;
          continue;
        }
      }

      const meta = {};
      if (get(row, mapping.website))      meta.website      = get(row, mapping.website);
      if (get(row, mapping.industry))     meta.industry     = get(row, mapping.industry);
      if (get(row, mapping.company_size)) meta.company_size = get(row, mapping.company_size);
      if (get(row, mapping.signal))       meta.signal       = get(row, mapping.signal);
      if (get(row, mapping.angle))        meta.angle        = get(row, mapping.angle);
      if (get(row, mapping.why_now))      meta.why_now      = get(row, mapping.why_now);
      if (get(row, mapping.friction))     meta.friction     = get(row, mapping.friction);
      if (get(row, mapping.notes))        meta.notes        = get(row, mapping.notes);
      meta.source = 'csv_import';
      meta.data_source = 'csv_import';
      meta.verified = true; // user-curated data is trusted by default

      // Optional signal_tier from CSV — default P2 for imported leads (mid-priority).
      // P1 = active signal, P2 = some signal, P3 = no signal. Captain's gates use this.
      const tierRaw = (get(row, mapping.signal_tier) || '').toUpperCase();
      const signalTier = ['P1', 'P2', 'P3'].includes(tierRaw) ? tierRaw : 'P2';

      try {
        await pool.query(
          `INSERT INTO leads
             (client_id, name, email, company, title, linkedin_url,
              source, pipeline_stage, status, signal_tier, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,'csv_import','prospecting','new',$7,$8)`,
          [
            clientId,
            name,
            email || null,
            company,
            get(row, mapping.title)        || null,
            get(row, mapping.linkedin_url) || null,
            signalTier,
            JSON.stringify(meta),
          ]
        );
        imported++;
      } catch (err) {
        failed++;
        if (errors.length < 5) errors.push(`Row "${name}": ${err.message}`);
        logger.warn({ msg: 'Import row failed', name, err: err.message });
      }
    }

    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata)
       VALUES ($1, 'director', 'leads_imported', 'leads', $2)`,
      [clientId, JSON.stringify({ imported, skipped, failed, source: 'csv_import' })]
    );

    res.json({ data: { imported, skipped, failed, errors } });
  } catch (err) { next(err); }
});

module.exports = router;
