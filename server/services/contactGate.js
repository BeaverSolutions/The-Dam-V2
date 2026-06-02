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
const PHASE3_BLOCKERS = new Set([
  'raw_candidates_zero',
  'icp_zero_after_company_extract',
  'decision_maker_zero',
  'contact_zero',
  'all_candidates_deduped',
  'competitor_offer_disqualified',
  'provider_cap_closed',
]);

// 2026-05-23 P0.5: source-side fake-domain blocklist. Hunter false-positives
// on these as "verified" (May 13 incident — 2x @independent.com leads, both
// guaranteed bounce). Treat any email on these domains as no usable email
// regardless of email_verified flag. Lead can still qualify via LinkedIn
// (Tier B) if it has the URL + score; otherwise it falls to Tier C with a
// research_misses log row for sourcing-strategy tuning.
const FAKE_EMAIL_DOMAINS = new Set([
  'independent.com',
  'example.com',
  'example.org',
  'example.net',
  'test.com',
  'email.com',
  'noemail.com',
  'mailinator.com',
  'tempmail.com',
  'placeholder.com',
  'freelance.com',
  'self-employed.com',
  'stealth.com',
  'confidential.com',
  'unknown.com',
]);

function isFakeDomain(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return FAKE_EMAIL_DOMAINS.has(email.slice(at + 1).toLowerCase().trim());
}

// 2026-05-29 supply fix: a lead with no usable company name is un-actionable.
// The kickoff/signal draft selectors require company NOT NULL + not-junk
// (agents.js DB-first selector), and email enrichment (findEmail) needs a
// company to discover a domain. Leads without one became permanent pool
// corpses: channel-present yet never draftable and never enrichable. Reject
// them at the gate so they never enter the pool as Tier A/B. The junk list
// mirrors the DB-first selector exactly so the gate and the selector agree.
const JUNK_COMPANY_NAMES = new Set([
  'unknown', 'unknown company', 'independent', 'self-employed', 'self employed',
  'stealth', 'confidential',
]);

function hasUsableCompany(company) {
  const c = String(company || '').trim().toLowerCase();
  return c.length > 0 && !JUNK_COMPANY_NAMES.has(c);
}

function phase3BlockerForMissReason(missReason) {
  if (PHASE3_BLOCKERS.has(missReason)) return missReason;
  if (missReason === 'no_usable_company') return 'icp_zero_after_company_extract';
  if (missReason === 'no_channels') return 'contact_zero';
  if (/linkedin_only_below_p1_score/i.test(missReason)) return 'contact_zero';
  if (missReason === 'unverified_email_no_linkedin_fallback') return 'contact_zero';
  if (missReason === 'fake_email_domain_at_source') return 'contact_zero';
  return 'contact_zero';
}

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
    candidate.email !== 'unknown@example.com' &&
    !isFakeDomain(candidate.email);

  // Tier A REQUIRES email_verified=true (SMTP-verified by Hunter or other
  // provider). Pattern-inferred emails (Hunter findEmail with verified=false)
  // bounce ~10% of the time and damage sender reputation — they belong in
  // Tier B until SMTP-verifiable. The 2026-05-05 validation kickoff caught
  // 14 such leads in Tier A producing blocked_no_email; gate tightened.
  const emailVerified = candidate.email_verified === true;

  const hasLinkedin = !!(candidate.linkedin_url && String(candidate.linkedin_url).trim());
  // Research Beaver leads carry `quality_score` (qualityScorer output), never
  // `score` — normaliseLead does not set `score`. Accept either, or a fully
  // quality-scored lead is silently treated as score 0 and fails the Tier B gate.
  const score = Number(candidate.score) || Number(candidate.quality_score) || 0;

  // 2026-05-29 supply fix: usable company is a hard prerequisite for any tier.
  // No company → undraftable (selector completeness gate) AND un-enrichable
  // (findEmail needs a domain). Reject to Tier C instead of polluting the pool.
  const usableCompany = hasUsableCompany(candidate.company);

  // Tier A — SMTP-verified email at sourcing.
  if (hasUsableEmail && emailVerified && usableCompany) {
    return { passed: true, tier: 'A', missReason: null };
  }

  // Tier B — high-fit lead with LinkedIn channel; retry enrichment.
  // Manual override (allowLinkedinOnly) lets through any score.
  if (hasLinkedin && usableCompany && (score >= TIER_B_SCORE_THRESHOLD || allowLinkedinOnly)) {
    return { passed: true, tier: 'B', missReason: null };
  }

  // Tier C — rejected at sourcing.
  let missReason;
  if (!usableCompany) {
    missReason = 'no_usable_company';
  } else if (!hasUsableEmail && !hasLinkedin) {
    missReason = 'no_channels';
  } else if (!hasUsableEmail && hasLinkedin && score < TIER_B_SCORE_THRESHOLD) {
    missReason = `linkedin_only_below_p1_score_${score}`;
  } else if (hasUsableEmail && !emailVerified && !hasLinkedin) {
    missReason = 'unverified_email_no_linkedin_fallback';
  } else if (candidate.email && isFakeDomain(candidate.email)) {
    // Caught for visibility: a fake-domain email was supplied (Hunter false-
    // positive class). Lead may still have passed via Tier B above; if it
    // reached here, it had no LinkedIn fallback either.
    missReason = 'fake_email_domain_at_source';
  } else {
    missReason = 'unclassified';
  }
  const phase3Blocker = options.phase3Blocker && PHASE3_BLOCKERS.has(options.phase3Blocker)
    ? options.phase3Blocker
    : phase3BlockerForMissReason(missReason);

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
      JSON.stringify({ ...(candidate.metadata || {}), score, phase3_blocker: phase3Blocker }),
    ]
  ).catch(err => {
    console.warn('[contactGate] research_miss insert failed:', err.message);
  });

  return { passed: false, tier: null, missReason, blockerReason: phase3Blocker };
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
  isFakeDomain,
  hasUsableCompany,
  phase3BlockerForMissReason,
  FAKE_EMAIL_DOMAINS,
  PHASE3_BLOCKERS,
  JUNK_COMPANY_NAMES,
  TIER_B_SCORE_THRESHOLD,
};
