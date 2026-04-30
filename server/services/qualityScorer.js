'use strict';

/**
 * Quality Scorer — Phase B of Research Beaver redesign.
 *
 * Pure-function scoring engine. Given a lead and a tenant's config,
 * returns a composite quality_score (0-100) and a per-dimension
 * breakdown that explains WHY the lead got that score.
 *
 * Four dimensions, each scored 0-100 then weighted-summed:
 *   1. SIGNAL          — buying-signal strength × time-decay × tenant relevance
 *   2. TITLE           — decision-power match against tenant's ICP titles
 *   3. REACHABILITY    — email + LinkedIn presence (and email verified status)
 *   4. SEGMENT HISTORY — past pass-through rate for similar leads (placeholder
 *                        in Phase B, real lookup added in Phase D)
 *
 * Final score: weighted sum × 100.
 * Weights come from tenantConfig.quality_weights (default 0.40/0.25/0.20/0.15).
 *
 * No side effects, no DB calls, no external IO. Easy to test, easy to
 * reason about, idempotent.
 */

const SIGNAL_DECAY_MAX_DAYS = 30; // Signals older than this get 0 weight
const SEGMENT_HISTORY_PLACEHOLDER = 50; // Neutral until Phase D wires real lookup

/* ─── Dimension 1: SIGNAL ─────────────────────────────────────────── */

/**
 * Score the buying-signal strength on a lead.
 *
 * Looks at lead.metadata.signal_type + signal_strength + signal_recency_days
 * and matches against the tenant's signal_preferences map.
 *
 * Returns 0-100 where:
 *   100 = strongest signal type for this tenant, fresh (< 2 days old)
 *   0   = no recognized signal OR signal older than SIGNAL_DECAY_MAX_DAYS
 */
function scoreSignal(lead, signalPreferences) {
  const meta = lead.metadata || {};
  const signalType = meta.signal_type || meta.angle_type || null;
  const signalStrength = Number(meta.signal_strength) || null; // 0-1 if provided by Research Beaver
  const recencyDays = Number(meta.signal_recency_days);

  if (!signalType) {
    return { raw: 0, reason: 'no_signal' };
  }

  // Tenant-specific weight for this signal type. Falls back to 0.5 (neutral)
  // if the signal type isn't in the tenant's preferences map.
  const tenantWeight = (signalPreferences && signalPreferences[signalType] !== undefined)
    ? Number(signalPreferences[signalType])
    : 0.5;

  // Time decay: linear from full weight at day 0 to zero at SIGNAL_DECAY_MAX_DAYS
  let decay = 1.0;
  if (Number.isFinite(recencyDays) && recencyDays >= 0) {
    decay = Math.max(0, 1 - (recencyDays / SIGNAL_DECAY_MAX_DAYS));
  }

  // Optional Research-Beaver-supplied strength multiplier (0-1)
  const strengthMult = Number.isFinite(signalStrength) ? Math.max(0, Math.min(1, signalStrength)) : 1.0;

  const raw = Math.round(tenantWeight * decay * strengthMult * 100);
  return {
    raw,
    signal_type: signalType,
    tenant_weight: tenantWeight,
    decay: Number(decay.toFixed(2)),
    strength_mult: strengthMult,
  };
}

/* ─── Dimension 2: TITLE ──────────────────────────────────────────── */

/**
 * Score the lead's title against the tenant's ICP title brackets.
 *
 *   senior_standalone   → 100 (full match — Founder, CEO, owner, etc.)
 *   senior_leader       → 80  (VP, Head of, Director-level)
 *   junior_ic_regex     → 0   (would normally be ICP-rejected, but if it slipped through)
 *   no match            → 40  (off-brand title, partial credit)
 */
function scoreTitle(lead, icpConfig) {
  const title = (lead.title || '').trim();
  if (!title) return { raw: 0, reason: 'no_title' };
  const lower = title.toLowerCase();

  const titles = icpConfig?.titles || {};
  const seniorStandalone = (titles.senior_standalone || []).map(t => t.toLowerCase());
  const seniorLeader = (titles.senior_leader || []).map(t => t.toLowerCase());
  const juniorRegex = titles.junior_ic_regex
    ? new RegExp(titles.junior_ic_regex, 'i')
    : null;

  // Most senior match wins. Check standalone first, then leader, then junior.
  if (seniorStandalone.some(t => lower.includes(t.toLowerCase()))) {
    return { raw: 100, bracket: 'senior_standalone', match: lower };
  }
  if (seniorLeader.some(t => lower.includes(t.toLowerCase()))) {
    return { raw: 80, bracket: 'senior_leader', match: lower };
  }
  if (juniorRegex && juniorRegex.test(lower)) {
    return { raw: 0, bracket: 'junior_ic', match: lower };
  }
  return { raw: 40, bracket: 'unmatched', match: lower };
}

/* ─── Dimension 3: REACHABILITY ───────────────────────────────────── */

/**
 * Score the lead's reachability — can we contact them, and via what channel?
 *
 *   verified email + linkedin_url   → 100
 *   verified email only              → 80
 *   unverified email + linkedin_url  → 60
 *   unverified email only            → 40
 *   linkedin_url only (no email)     → 50  (LinkedIn-channel possible)
 *   nothing                          → 0
 *
 * The pattern-guessed-email-but-no-LinkedIn case scores 40 — risky to send
 * to without verification. Phase C's threshold gate decides what to do.
 */
function scoreReachability(lead) {
  const hasEmail = !!(lead.email && lead.email.includes('@'));
  const emailVerified = !!lead.email_verified;
  const hasLinkedin = !!(lead.linkedin_url && /^https?:\/\//i.test(lead.linkedin_url));

  if (emailVerified && hasLinkedin) return { raw: 100, has_verified_email: true, has_linkedin: true };
  if (emailVerified)                return { raw: 80,  has_verified_email: true, has_linkedin: false };
  if (hasEmail && hasLinkedin)      return { raw: 60,  has_verified_email: false, has_linkedin: true, has_unverified_email: true };
  if (hasEmail)                     return { raw: 40,  has_verified_email: false, has_linkedin: false, has_unverified_email: true };
  if (hasLinkedin)                  return { raw: 50,  has_verified_email: false, has_linkedin: true, has_unverified_email: false };
  return { raw: 0, reason: 'unreachable' };
}

/* ─── Dimension 4: SEGMENT HISTORY (Phase B placeholder) ──────────── */

/**
 * Score based on how leads in the same segment (vertical × geo × seniority
 * bracket × signal type) have historically performed. Performance = pass-through
 * rate from sourcing to a real send.
 *
 * Phase B returns NEUTRAL (50). Phase D wires in actual segment lookup
 * from agent_memory or a new segment_outcomes table.
 */
function scoreSegmentHistory(lead, segmentLookup) {
  // Phase D will inject segmentLookup with real data.
  // For now, neutral placeholder.
  if (typeof segmentLookup === 'function') {
    try {
      const r = segmentLookup(lead);
      if (Number.isFinite(r) && r >= 0 && r <= 100) {
        return { raw: r, source: 'lookup' };
      }
    } catch { /* fall through to placeholder */ }
  }
  return { raw: SEGMENT_HISTORY_PLACEHOLDER, source: 'placeholder_phase_b' };
}

/* ─── Composite scorer ────────────────────────────────────────────── */

/**
 * scoreLead — the public entry point.
 *
 * @param {object} lead — a lead row (from leads table or candidate object)
 * @param {object} tenantConfig — output of tenantConfig.getTenantConfig
 * @param {object} [options] — { segmentLookup: fn } for Phase D
 * @returns {{ score: number (0-100), breakdown: object }}
 */
function scoreLead(lead, tenantConfig, options = {}) {
  if (!lead || !tenantConfig) {
    throw new Error('scoreLead requires (lead, tenantConfig)');
  }

  const weights = tenantConfig.quality_weights || {
    signal: 0.40, title: 0.25, reachability: 0.20, segment_history: 0.15,
  };

  // Validate weights sum ~= 1.0; if not, normalise so we don't return >100
  const sum = (weights.signal || 0) + (weights.title || 0) + (weights.reachability || 0) + (weights.segment_history || 0);
  const norm = (sum > 0.001) ? sum : 1.0;
  const w = {
    signal:          (weights.signal || 0) / norm,
    title:           (weights.title || 0) / norm,
    reachability:    (weights.reachability || 0) / norm,
    segment_history: (weights.segment_history || 0) / norm,
  };

  const sig = scoreSignal(lead, tenantConfig.signal_preferences);
  const tit = scoreTitle(lead, tenantConfig.icp_config);
  const rch = scoreReachability(lead);
  const seg = scoreSegmentHistory(lead, options.segmentLookup);

  const composite = Math.round(
    sig.raw * w.signal +
    tit.raw * w.title +
    rch.raw * w.reachability +
    seg.raw * w.segment_history
  );

  // Final score is bounded 0-100.
  const score = Math.max(0, Math.min(100, composite));

  return {
    score,
    breakdown: {
      signal:          { ...sig, weight: Number(w.signal.toFixed(3)),          contribution: Number((sig.raw * w.signal).toFixed(2)) },
      title:           { ...tit, weight: Number(w.title.toFixed(3)),           contribution: Number((tit.raw * w.title).toFixed(2)) },
      reachability:    { ...rch, weight: Number(w.reachability.toFixed(3)),    contribution: Number((rch.raw * w.reachability).toFixed(2)) },
      segment_history: { ...seg, weight: Number(w.segment_history.toFixed(3)), contribution: Number((seg.raw * w.segment_history).toFixed(2)) },
      sum: score,
    },
  };
}

/* ─── DB helpers ──────────────────────────────────────────────────── */

const pool = require('../db/pool');

/** Persist quality_score + breakdown to the leads row. */
async function persistScore(leadId, score, breakdown) {
  await pool.query(
    `UPDATE leads
     SET quality_score = $1,
         quality_score_breakdown = $2,
         quality_scored_at = NOW(),
         updated_at = NOW()
     WHERE id = $3`,
    [score, breakdown, leadId]
  );
}

/**
 * Score a lead and persist in one shot. Convenience for Research Beaver
 * sourcing flow (Phase C wires this in).
 */
async function scoreAndPersist(lead, tenantConfig, options = {}) {
  const result = scoreLead(lead, tenantConfig, options);
  if (lead.id) {
    await persistScore(lead.id, result.score, result.breakdown);
  }
  return result;
}

module.exports = {
  scoreLead,
  scoreAndPersist,
  persistScore,
  // Sub-scorers exposed for unit testing / debugging
  scoreSignal,
  scoreTitle,
  scoreReachability,
  scoreSegmentHistory,
  // Constants
  SIGNAL_DECAY_MAX_DAYS,
  SEGMENT_HISTORY_PLACEHOLDER,
};
