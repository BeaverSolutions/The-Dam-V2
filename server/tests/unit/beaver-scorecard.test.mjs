import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { buildBeaverScorecard, BEAVER_TARGETS } = require('../../services/beaverScorecard');
const captainSource = readFileSync(resolve(__dirname, '../../services/captainOrchestrator.js'), 'utf-8');

// Fixed inputs → known hit/miss. No DB, no heavy deps.
describe('buildBeaverScorecard (Phase 3 per-beaver accountability)', () => {
  const allHitInput = {
    research_sourced_today: 45, research_verified_email_today: 12,
    sales_drafted_today: 55, sales_first_pass_today: 40, sales_first_attempt_today: 50, // 80%
    enforcer_reviewed_today: 55, enforcer_approved_today: 30, // 55% (in band)
    captain_kickoffs_today: 1,
  };
  const ctx = { researchFloor: 40, poolSize: 30 };

  it('marks every beaver HIT and all_hit when targets are met', () => {
    const s = buildBeaverScorecard(allHitInput, ctx);
    expect(s.research.hit).toBe(true);
    expect(s.sales.hit).toBe(true);
    expect(s.enforcer.hit).toBe(true);
    expect(s.captain.hit).toBe(true);
    expect(s.all_hit).toBe(true);
    expect(s.research.recommended_action).toBeNull();
    expect(s.sales.recommended_action).toBeNull();
    expect(s.captain.recommended_action).toBeNull();
  });

  it('research miss with a non-empty pool recommends pool email enrichment', () => {
    const s = buildBeaverScorecard({ ...allHitInput, research_sourced_today: 0 }, { researchFloor: 40, poolSize: 30 });
    expect(s.research.hit).toBe(false);
    expect(s.research.recommended_action).toBe('run_pool_email_enrichment');
    expect(s.all_hit).toBe(false);
  });

  it('research is idle-by-design (HIT) when the pool is already healthy', () => {
    const s = buildBeaverScorecard({ ...allHitInput, research_sourced_today: 0 }, { researchFloor: 40, poolSize: 120 });
    expect(s.research.hit).toBe(true);
    expect(s.research.recommended_action).toBeNull();
  });

  it('research miss with an empty pool recommends signal hunt', () => {
    const s = buildBeaverScorecard({ ...allHitInput, research_sourced_today: 0 }, { researchFloor: 40, poolSize: 0 });
    expect(s.research.recommended_action).toBe('run_signal_hunt');
  });

  it('sales draft shortfall recommends fire_kickoff', () => {
    const s = buildBeaverScorecard({ ...allHitInput, sales_drafted_today: 10 }, ctx);
    expect(s.sales.draft_hit).toBe(false);
    expect(s.sales.hit).toBe(false);
    expect(s.sales.recommended_action).toBe('fire_kickoff');
  });

  it('sales quality shortfall (low first-pass) recommends enforcer_teach', () => {
    const s = buildBeaverScorecard({ ...allHitInput, sales_first_pass_today: 25, sales_first_attempt_today: 50 }, ctx); // 50% < 60
    expect(s.sales.quality_hit).toBe(false);
    expect(s.sales.recommended_action).toBe('enforcer_teach');
  });

  it('enforcer approve-rate above the healthy band recommends recalibration', () => {
    const s = buildBeaverScorecard({ ...allHitInput, enforcer_reviewed_today: 50, enforcer_approved_today: 48 }, ctx); // 96% > 90
    expect(s.enforcer.band_ok).toBe(false);
    expect(s.enforcer.recommended_action).toBe('enforcer_recalibrate');
  });

  it('treats zero-activity as n/a (null), not a miss', () => {
    const s = buildBeaverScorecard({ captain_kickoffs_today: 1, research_sourced_today: 50 }, { researchFloor: 40, poolSize: 0 });
    expect(s.enforcer.coverage_hit).toBeNull();
    expect(s.enforcer.band_ok).toBeNull();
    expect(s.enforcer.hit).toBe(true); // null is non-blocking
    expect(s.sales.quality_hit).toBeNull();
  });

  it('captain miss (no kickoff fired) recommends verifying the kickoff is armed', () => {
    const s = buildBeaverScorecard({ ...allHitInput, captain_kickoffs_today: 0 }, ctx);
    expect(s.captain.hit).toBe(false);
    expect(s.captain.recommended_action).toBe('verify_kickoff_armed');
  });

  it('targets reflect the 50/day operational contract', () => {
    expect(BEAVER_TARGETS.sales_drafts).toBe(50);
    expect(BEAVER_TARGETS.sales_first_pass_pct).toBeGreaterThan(0);
  });
});

// Source-contract: the scorecard is wired into collectTeamKPIs + the brief.
describe('scorecard wiring in captainOrchestrator (source contract)', () => {
  it('collectTeamKPIs computes an MYT-business-day scorecard query and returns scorecard', () => {
    expect(captainSource).toContain("require('./beaverScorecard')");
    expect(captainSource).toContain('scorecardPromise');
    expect(captainSource).toContain('research_sourced_today');
    expect(captainSource).toContain('scorecard: buildBeaverScorecard(');
    expect(captainSource).toContain('researchFloor: cfg.daily_quality_lead_floor');
  });

  it('renders the per-beaver scorecard block in the morning brief (additive)', () => {
    expect(captainSource).toContain('BEAVER SCORECARD (today, MYT)');
    expect(captainSource).toContain('...scorecardLines');
  });
});
