'use strict';

/**
 * Per-beaver KPI scorecard (Phase 3, 2026-05-29).
 *
 * Pure, dependency-free, deterministic so it is unit-testable without a DB or
 * the captainOrchestrator dependency tree. collectTeamKPIs already computes the
 * per-beaver metrics from source tables; this module adds the accountability
 * layer: compare each beaver's MYT-business-day metrics against a target and
 * emit hit / miss + a recommended corrective action.
 *
 * Research target is the tenant's configured daily_quality_lead_floor; the rest
 * derive from the 50/day operational contract.
 *
 * IMPORTANT: recommended_action only NAMES the fix. Executing it (enrichment,
 * kickoff, recalibration) stays gated behind the autonomy flags (Phase 4). The
 * scorecard decides + surfaces; it never spends.
 *
 * `hit === null` means "not enough activity to judge" (e.g. 0 drafts → Enforcer
 * coverage is n/a, not a miss). all_hit treats null as non-blocking.
 */

const BEAVER_TARGETS = {
  sales_drafts: 50,
  sales_first_pass_pct: 60,
  enforcer_approve_band: { min: 25, max: 90 }, // outside this band = quality drift
  captain_kickoffs: 1,
};

function scPct(n, d) {
  return d > 0 ? Math.round((n / d) * 100) : null;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') return value;
  }
  return null;
}

function signalIdForEvent(event = {}) {
  const meta = event.metadata || {};
  const pkg = meta.signal_package || event.signal_package || {};
  return firstNonEmpty(
    event.signal_id,
    event.signal,
    event.signal_type,
    pkg.signal_id,
    meta.signal_id,
    meta.signal,
    meta.signal_type
  ) || 'unknown_signal';
}

function signalFamilyForEvent(event = {}) {
  const meta = event.metadata || {};
  const pkg = meta.signal_package || event.signal_package || {};
  return firstNonEmpty(event.signal_family, pkg.signal_family, meta.signal_family) || null;
}

function sourceChannelForEvent(event = {}) {
  const meta = event.metadata || {};
  const pkg = meta.signal_package || event.signal_package || {};
  return firstNonEmpty(event.source_channel, event.sourceChannel, pkg.source_channel, meta.source_channel) || null;
}

function ensureSignalScore(out, event = {}) {
  const signalId = signalIdForEvent(event);
  if (!out[signalId]) {
    out[signalId] = {
      signal_id: signalId,
      signal_family: signalFamilyForEvent(event),
      attempted: 0,
      source_channels: [],
      raw_candidates: 0,
      icp_pass: 0,
      decision_maker_found: 0,
      contact_found: 0,
      saved_leads: 0,
      drafted: 0,
      approved: 0,
      sent: 0,
      cost_spend: 0,
      blocker_reasons: {},
    };
  }
  const score = out[signalId];
  if (!score.signal_family) score.signal_family = signalFamilyForEvent(event);
  const sourceChannel = sourceChannelForEvent(event);
  if (sourceChannel && !score.source_channels.includes(sourceChannel)) {
    score.source_channels.push(sourceChannel);
  }
  return score;
}

function addBlocker(score, reason, count = 1) {
  if (!reason) return;
  const key = String(reason).trim();
  if (!key) return;
  score.blocker_reasons[key] = (score.blocker_reasons[key] || 0) + Math.max(1, asNumber(count));
}

function addStageCount(score, stage, count) {
  if (!stage) return;
  if (stage === 'icp_passed') score.icp_pass += count;
  if (stage === 'decision_maker_found') score.decision_maker_found += count;
  if (stage === 'contact_found' || stage === 'readiness_passed') score.contact_found += count;
  if (stage === 'enrolled' || stage === 'saved' || stage === 'saved_lead') score.saved_leads += count;
  if (stage === 'drafted') score.drafted += count;
  if (stage === 'approved') score.approved += count;
  if (stage === 'sent') score.sent += count;
}

/**
 * Build Captain's per-signal scoreboard from already-collected trace/log rows.
 * Pure by design: tests and collectors can pass pipeline_traces, Research
 * blocker logs, or summarized rows without pulling in Captain dependencies.
 */
function buildSignalScorecard(events = []) {
  const out = {};
  for (const event of Array.isArray(events) ? events : []) {
    const score = ensureSignalScore(out, event || {});
    const count = Math.max(1, asNumber(event.cnt || event.count || 1));
    const explicitAttempted = event.attempted !== undefined && event.attempted !== null;

    score.attempted += explicitAttempted
      ? asNumber(event.attempted)
      : (firstNonEmpty(event.blocker_reason, event.blocker, event.reason) ? count : 0);
    score.raw_candidates += asNumber(firstNonEmpty(event.raw_candidates, event.raw_candidates_total, event.raw_results_total));
    score.icp_pass += asNumber(firstNonEmpty(event.icp_pass, event.icp_passed));
    score.decision_maker_found += asNumber(firstNonEmpty(event.decision_maker_found, event.decision_makers_found));
    score.contact_found += asNumber(firstNonEmpty(event.contact_found, event.contacts_found));
    score.saved_leads += asNumber(firstNonEmpty(event.saved_leads, event.saved));
    score.drafted += asNumber(event.drafted);
    score.approved += asNumber(event.approved);
    score.sent += asNumber(event.sent);
    score.cost_spend += asNumber(firstNonEmpty(event.cost_spend, event.spend, event.cost_usd));

    addStageCount(score, event.stage, count);
    addBlocker(score, firstNonEmpty(event.blocker_reason, event.blocker, event.reason, event.reject_reason), count);
  }
  return out;
}

/**
 * @param {object} sc  MYT-today counts: research_sourced_today,
 *   research_verified_email_today, sales_drafted_today, sales_first_pass_today,
 *   sales_first_attempt_today, enforcer_reviewed_today, enforcer_approved_today,
 *   captain_kickoffs_today
 * @param {object} ctx { researchFloor, poolSize }
 */
function buildBeaverScorecard(sc = {}, ctx = {}) {
  const researchFloor = Number(ctx.researchFloor) || 40;
  const poolSize = Number(ctx.poolSize) || 0;

  const researchSourced = Number(sc.research_sourced_today) || 0;
  const verifiedEmailToday = Number(sc.research_verified_email_today) || 0;
  const drafts = Number(sc.sales_drafted_today) || 0;
  const firstPass = Number(sc.sales_first_pass_today) || 0;
  const firstAttempt = Number(sc.sales_first_attempt_today) || 0;
  const reviewed = Number(sc.enforcer_reviewed_today) || 0;
  const approved = Number(sc.enforcer_approved_today) || 0;
  const kickoffs = Number(sc.captain_kickoffs_today) || 0;

  const firstPassPct = scPct(firstPass, firstAttempt);
  const approveRatePct = scPct(approved, reviewed);

  // Research hits if it met the floor OR the pool is already healthy (idle by design).
  const researchHit = researchSourced >= researchFloor || poolSize >= 100;
  const research = {
    sourced_today: researchSourced, verified_email_today: verifiedEmailToday,
    target: researchFloor, pool_size: poolSize, hit: researchHit,
    recommended_action: researchHit ? null : (poolSize > 0 ? 'run_pool_email_enrichment' : 'run_signal_hunt'),
  };

  const draftHit = drafts >= BEAVER_TARGETS.sales_drafts;
  const qualityHit = firstPassPct === null ? null : firstPassPct >= BEAVER_TARGETS.sales_first_pass_pct;
  const sales = {
    drafts_today: drafts, target: BEAVER_TARGETS.sales_drafts,
    first_pass_rate_pct: firstPassPct, first_pass_target_pct: BEAVER_TARGETS.sales_first_pass_pct,
    draft_hit: draftHit, quality_hit: qualityHit,
    hit: draftHit && qualityHit !== false,
    recommended_action: !draftHit ? 'fire_kickoff' : (qualityHit === false ? 'enforcer_teach' : null),
  };

  // Coverage: Enforcer should review at least as many as Sales drafted today.
  const coverageHit = drafts === 0 ? null : reviewed >= drafts;
  const bandOk = approveRatePct === null ? null
    : (approveRatePct >= BEAVER_TARGETS.enforcer_approve_band.min && approveRatePct <= BEAVER_TARGETS.enforcer_approve_band.max);
  const enforcer = {
    reviewed_today: reviewed, approved_today: approved, approve_rate_pct: approveRatePct,
    healthy_band: BEAVER_TARGETS.enforcer_approve_band,
    coverage_hit: coverageHit, band_ok: bandOk,
    hit: coverageHit !== false && bandOk !== false,
    recommended_action: bandOk === false ? 'enforcer_recalibrate' : (coverageHit === false ? 'enforcer_clear_backlog' : null),
  };

  const captainHit = kickoffs >= BEAVER_TARGETS.captain_kickoffs;
  const captain = {
    kickoffs_today: kickoffs, target: BEAVER_TARGETS.captain_kickoffs, hit: captainHit,
    recommended_action: captainHit ? null : 'verify_kickoff_armed',
  };

  const all_hit = [research.hit, sales.hit, enforcer.hit, captain.hit].every(h => h === true || h === null);
  return { research, sales, enforcer, captain, all_hit };
}

module.exports = { BEAVER_TARGETS, scPct, buildBeaverScorecard, buildSignalScorecard };
