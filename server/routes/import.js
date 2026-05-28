'use strict';

const router = require('express').Router();
const pool = require('../db/pool');
const logger = require('../utils/logger');

const IMPORT_SOURCES = new Set(['csv_import', 'vibe_csv', 'apollo_csv']);

function normalizeImportSource(raw) {
  return IMPORT_SOURCES.has(raw) ? raw : 'csv_import';
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return value || null;
}

function normalizeLinkedIn(url) {
  const value = String(url || '').trim().toLowerCase();
  if (!value) return null;
  return value.split('?')[0].replace(/\/+$/, '');
}

function normalizeNameCompany(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// POST /api/import/leads
// Body: { rows: [...], source?: 'csv_import'|'vibe_csv'|'apollo_csv', mapping: { name, email, company, title, linkedin_url, website, industry, company_size, signal, notes } }
router.post('/leads', async (req, res, next) => {
  try {
    const clientId = req.clientId;
    const { rows, mapping } = req.body;
    const importSource = normalizeImportSource(req.body.source || req.body.sourceType);
    const isVibeCsv = importSource === 'vibe_csv';
    const isApolloCsv = importSource === 'apollo_csv';
    const isTrustedEmailCsv = isVibeCsv || isApolloCsv;

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
      const email   = normalizeEmail(get(row, mapping.email));
      const linkedinUrl = get(row, mapping.linkedin_url);
      const normalizedLinkedIn = normalizeLinkedIn(linkedinUrl);

      // Skip blank rows
      if (name === 'Unknown Contact' && company === 'Unknown Company') {
        skipped++;
        continue;
      }

      // Dedupe by email, LinkedIn URL, then normalized name + company.
      const dedupeParams = [clientId];
      const dedupeConditions = [];
      if (email) {
        dedupeParams.push(email);
        dedupeConditions.push(`LOWER(TRIM(email)) = $${dedupeParams.length}`);
      }
      if (normalizedLinkedIn) {
        dedupeParams.push(normalizedLinkedIn);
        dedupeConditions.push(`LOWER(TRIM(TRAILING '/' FROM SPLIT_PART(linkedin_url, '?', 1))) = $${dedupeParams.length}`);
      }
      const nameKey = normalizeNameCompany(name);
      const companyKey = normalizeNameCompany(company);
      if (nameKey && companyKey && name !== 'Unknown Contact' && company !== 'Unknown Company') {
        dedupeParams.push(nameKey, companyKey);
        dedupeConditions.push(
          `(LOWER(REGEXP_REPLACE(COALESCE(name, ''), '[^a-z0-9]+', '', 'g')) = $${dedupeParams.length - 1}` +
          ` AND LOWER(REGEXP_REPLACE(COALESCE(company, ''), '[^a-z0-9]+', '', 'g')) = $${dedupeParams.length})`
        );
      }
      if (dedupeConditions.length > 0) {
        const dup = await pool.query(
          `SELECT id FROM leads
           WHERE client_id = $1
             AND deleted_at IS NULL
             AND (${dedupeConditions.join(' OR ')})
           LIMIT 1`,
          dedupeParams
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
      meta.source = importSource;
      meta.data_source = importSource;
      meta.verified = true; // user-curated data is trusted by default
      if (isTrustedEmailCsv) {
        meta.email_source = email ? importSource : null;
        meta.import_mode = importSource;
        meta.email_verification = email ? `trusted_from_${importSource}` : 'not_present';
      }

      // Optional signal_tier from CSV — default P2 for imported leads (mid-priority).
      // P1 = active signal, P2 = some signal, P3 = no signal. Captain's gates use this.
      const tierRaw = (get(row, mapping.signal_tier) || '').toUpperCase();
      const signalTier = ['P1', 'P2', 'P3'].includes(tierRaw) ? tierRaw : 'P2';
      const emailVerified = isTrustedEmailCsv && !!email;
      const emailSource = emailVerified ? importSource : null;
      const leadTier = isTrustedEmailCsv
        ? (email ? 'A' : normalizedLinkedIn ? 'B' : null)
        : null;

      try {
        await pool.query(
          `INSERT INTO leads
             (client_id, name, email, company, title, linkedin_url,
              source, pipeline_stage, status, signal_tier,
              email_verified, email_source, lead_tier, tiered_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'prospecting','new',$8,$9,$10,$11,
                   CASE WHEN $11 IS NULL THEN NULL ELSE NOW() END,$12)`,
          [
            clientId,
            name,
            email || null,
            company,
            get(row, mapping.title)        || null,
            linkedinUrl || null,
            importSource,
            signalTier,
            emailVerified,
            emailSource,
            leadTier,
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
      [clientId, JSON.stringify({ imported, skipped, failed, source: importSource })]
    );

    res.json({ data: { imported, skipped, failed, errors } });
  } catch (err) { next(err); }
});

module.exports = router;
