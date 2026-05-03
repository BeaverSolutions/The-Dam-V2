'use strict';

/**
 * Contact gate — enforces "every sourced lead must have BOTH email AND
 * linkedin_url before saving" per MJ direction 2026-05-03.
 *
 * Sourced leads (Research Beaver, Signal Hunt, DB Builder) MUST go through
 * tryPersistSourcedLead(). Manually-created leads (captain tools, manual
 * import, MJ override) skip the gate by calling createLead directly.
 *
 * Failures land in research_misses so we can tune sourcing strategies over
 * time. After 3-4 weeks of data, deprioritize strategies with high no_email
 * rates.
 */

const pool = require('../db/pool');

/**
 * Gate + persist a sourced lead. Returns the inserted lead row or null
 * if the gate rejected. Caller decides what to do with null (usually:
 * just skip and continue).
 *
 * @param {string} clientId
 * @param {object} candidate — must include name; should include email, linkedin_url, company, title
 * @param {object} [options]
 * @param {string} [options.sourceStrategy] — for research_misses attribution
 * @param {string} [options.queryUsed]      — query string that produced this candidate
 * @param {boolean} [options.allowLinkedinOnly=false] — manual override for genuinely valuable LinkedIn-only leads
 * @returns {Promise<{inserted: object|null, missed: boolean, reason: string|null}>}
 */
async function tryPersistSourcedLead(clientId, candidate, options = {}) {
  const { sourceStrategy = null, queryUsed = null, allowLinkedinOnly = false } = options;

  const hasEmail    = !!(candidate.email && String(candidate.email).trim() && candidate.email !== 'unknown@example.com');
  const hasLinkedin = !!(candidate.linkedin_url && String(candidate.linkedin_url).trim());

  let missReason = null;
  if (!hasEmail && !hasLinkedin) missReason = 'neither';
  else if (!hasEmail && !allowLinkedinOnly) missReason = 'no_email';
  else if (!hasLinkedin) missReason = 'no_linkedin';

  if (missReason) {
    await pool.query(
      `INSERT INTO research_misses
         (client_id, candidate_name, candidate_company, candidate_title,
          candidate_linkedin, candidate_email, miss_reason, source_strategy, query_used, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        clientId,
        candidate.name || null,
        candidate.company || null,
        candidate.title || null,
        candidate.linkedin_url || null,
        candidate.email || null,
        missReason,
        sourceStrategy,
        queryUsed,
        JSON.stringify(candidate.metadata || {}),
      ]
    ).catch(err => {
      // Logging the miss is best-effort; don't let failure here block the caller.
      console.warn('[contactGate] research_miss insert failed:', err.message);
    });
    return { inserted: null, missed: true, reason: missReason };
  }

  // Pass — let caller do the actual insert with their existing INSERT statement.
  // tryPersistSourcedLead is a GATE, not the inserter, so each caller keeps
  // its own column list / metadata shape.
  return { inserted: null, missed: false, reason: null };
}

/**
 * Bulk variant. Returns { passed: candidate[], missed: candidate[] }.
 * Caller iterates passed[] and inserts using its own INSERT statement.
 */
async function gateBatch(clientId, candidates, options = {}) {
  const passed = [];
  const missed = [];
  for (const c of candidates) {
    const result = await tryPersistSourcedLead(clientId, c, options);
    if (result.missed) {
      missed.push({ candidate: c, reason: result.reason });
    } else {
      passed.push(c);
    }
  }
  return { passed, missed };
}

/**
 * "miss rate by strategy over the last N days" — used by Captain when
 * deciding which sourcing strategies to keep.
 */
async function missRateBy(clientId, dimension = 'source_strategy', days = 14) {
  const allowed = new Set(['source_strategy', 'miss_reason']);
  if (!allowed.has(dimension)) throw new Error(`Bad dimension: ${dimension}`);
  const { rows } = await pool.query(
    `SELECT ${dimension} AS dim, COUNT(*) AS n
     FROM research_misses
     WHERE client_id = $1 AND created_at > NOW() - ($2 || ' days')::INTERVAL
     GROUP BY ${dimension}
     ORDER BY n DESC`,
    [clientId, String(days)]
  );
  return rows;
}

module.exports = { tryPersistSourcedLead, gateBatch, missRateBy };
