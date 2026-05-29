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

module.exports = { BEAVER_TARGETS, scPct, buildBeaverScorecard };
