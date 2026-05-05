'use strict';

/**
 * Contact gate — tiered sourcing classification (migration 061, 2026-05-05).
 *
 * Replaces the previous "BOTH email AND linkedin_url required at sourcing"
 * gate, which combined with our SMB ICP and thin Hunter coverage was
 * starving the pool (~95% rejection at sourcing in synthetic testing).
 *
 * The new gate enforces ICP-quality, not channel-presence:
 *
 *   Tier A — drafted-ready
 *     email_verified at sourcing time (Hunter inline returned valid)
 *
 *   Tier B — enrichment queue (held for retry, NOT drafted yet)
 *     no verified email + linkedin_url present + score >= 85 (P1 fit)
 *     The Tier B retry worker (server/index.js cron) will run Hunter
 *     up to 3x over 14 days. Success → promote to A. Exhaustion → demote
 *     to C.
 *
 *   Tier C — rejected at sourcing
 *     no verified email AND (no linkedin_url OR score < 85)
 *     Logged to research_misses for sourcing-strategy tuning.
 *
 * Sourced leads (Research Beaver, Signal Hunt, DB Builder) MUST go through
 * tryPersistSourcedLead(). Manually-created leads (Captain tools, manual
 * import, MJ override) skip the gate by calling createLead directly with
 * lead_tier = 'A'.
 *
 * Caller contract: gate returns { passed, tier, missReason }. If passed,
 * caller proceeds with its own INSERT and writes lead_tier = tier on the
 * row. If not passed, caller skips the lead.
 */

const pool = require('../db/pool');

const TIER_B_SCORE_THRESHOLD = 85;

/**
 * Gate + classify a sourced lead.
 *
 * @param {string} clientId
 * @param {object} candidate — must include name; should include email, email_verified, linkedin_url, company, title, score
 * @param {object} [options]
 * @param {string} [options.sourceStrategy]
 * @param {string} [options.queryUsed]
 * @param {boolean} [options.allowLinkedinOnly=false] — manual override; if true, linkedin-only leads pass into Tier B regardless of score
 * @returns {Promise<{passed: boolean, tier: 'A'|'B'|null, missReason: string|null}>}
 */
async function tryPersistSourcedLead(clientId, candidate, options = {}) {
  const { sourceStrategy = null, queryUsed = null, allowLinkedinOnly = false } = options;

  const hasUsableEmail =
    !!candidate.email &&
    String(candidate.email).trim() !== '' &&
    candidate.email !== 'unknown@example.com';

  // Tier A REQUIRES email_verified=true (SMTP-verified by Hunter or other
  // provider). Pattern-inferred emails (Hunter findEmail with verified=false)
  // bounce ~10% of the time and damage sender reputation — they belong in
  // Tier B until SMTP-verifiable. The 2026-05-05 validation kickoff caught
  // 14 such leads in Tier A producing blocked_no_email; gate tightened.
  const emailVerified = candidate.email_verified === true;

  const hasLinkedin = !!(candidate.linkedin_url && String(candidate.linkedin_url).trim());
  const score = Number(candidate.score) || 0;

  // Tier A — SMTP-verified email at sourcing.
  if (hasUsableEmail && emailVerified) {
    return { passed: true, tier: 'A', missReason: null };
  }

  // Tier B — high-fit lead with LinkedIn channel; retry enrichment.
  // Manual override (allowLinkedinOnly) lets through any score.
  if (hasLinkedin && (score >= TIER_B_SCORE_THRESHOLD || allowLinkedinOnly)) {
    return { passed: true, tier: 'B', missReason: null };
  }

  // Tier C — rejected at sourcing.
  let missReason;
  if (!hasUsableEmail && !hasLinkedin) {
    missReason = 'no_channels';
  } else if (!hasUsableEmail && hasLinkedin && score < TIER_B_SCORE_THRESHOLD) {
    missReason = `linkedin_only_below_p1_score_${score}`;
  } else if (hasUsableEmail && !emailVerified && !hasLinkedin) {
    missReason = 'unverified_email_no_linkedin_fallback';
  } else {
    missReason = 'unclassified';
  }

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
      JSON.stringify({ ...(candidate.metadata || {}), score }),
    ]
  ).catch(err => {
    console.warn('[contactGate] research_miss insert failed:', err.message);
  });

  return { passed: false, tier: null, missReason };
}

/**
 * Bulk variant. Returns { passed: [{candidate, tier}], missed: [{candidate, reason}] }.
 * Caller iterates passed[] and inserts using its own INSERT statement,
 * writing lead_tier = tier on each row.
 */
async function gateBatch(clientId, candidates, options = {}) {
  const passed = [];
  const missed = [];
  for (const c of candidates) {
    const result = await tryPersistSourcedLead(clientId, c, options);
    if (result.passed) {
      passed.push({ candidate: c, tier: result.tier });
    } else {
      missed.push({ candidate: c, reason: result.missReason });
    }
  }
  return { passed, missed };
}

/**
 * "miss rate by strategy/reason over the last N days" — used by Captain
 * when deciding which sourcing strategies to keep or kill.
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

module.exports = {
  tryPersistSourcedLead,
  gateBatch,
  missRateBy,
  TIER_B_SCORE_THRESHOLD,
};
