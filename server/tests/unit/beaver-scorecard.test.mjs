import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  buildBeaverScorecard,
  buildCaptainPeriodReport,
  formatCaptainPeriodReport,
  BEAVER_TARGETS,
} = require('../../services/beaverScorecard');
const captainSource = readFileSync(resolve(__dirname, '../../services/captainOrchestrator.js'), 'utf-8');
const kpiSource = readFileSync(resolve(__dirname, '../../services/kpi.js'), 'utf-8');
const indexSource = readFileSync(resolve(__dirname, '../../index.js'), 'utf-8');

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

describe('Captain weekly/monthly period reports', () => {
  it('renders honest zeros for a zero-output period', () => {
    const report = buildCaptainPeriodReport({
      period: { type: 'weekly', label: '2026-05-25 to 2026-06-01', start_date: '2026-05-25', end_date: '2026-06-01', days: 7 },
      active_industries: ['B2B corporate training', 'small marketing agencies'],
      targets: { outreach_sent: 350 },
    });

    expect(report.headline.sent).toBe(0);
    expect(report.headline.target).toBe(350);
    expect(report.industries.map(row => row.industry)).toEqual(['B2B corporate training', 'small marketing agencies']);
    expect(report.industries[0]).toMatchObject({ queries_run: 0, raw_candidates: 0, saved: 0, sent: 0, replies: 0, meetings: 0 });

    const text = formatCaptainPeriodReport(report);
    expect(text).toContain('HEADLINE VS TARGET');
    expect(text).toContain('0/350 sent');
    expect(text).toContain('B2B corporate training: queries 0, raw 0, saved 0, sent 0, replies 0, meetings 0');
  });

  it('surfaces monthly observations for a human decision without auto-reweighting', () => {
    const report = buildCaptainPeriodReport({
      period: { type: 'monthly', label: 'May 2026', start_date: '2026-05-01', end_date: '2026-06-01', days: 31 },
      active_industries: ['B2B corporate training'],
      targets: { outreach_sent: 1550 },
      industries: [{ industry: 'B2B corporate training', queries_run: 8, raw_candidates: 120, saved: 10, sent: 15, replies: 0, meetings: 0 }],
      blockers: [{ reason: 'raw_candidates_zero', count: 3 }],
    });

    expect(report.observations).toEqual(expect.arrayContaining([
      'B2B corporate training: 0 replies in period',
      'Top blocker: raw_candidates_zero (3)',
    ]));
    expect(JSON.stringify(report)).not.toMatch(/auto.?reweight|auto.?act|recommended_weight/i);
    expect(formatCaptainPeriodReport(report)).toContain('MONTHLY OBSERVATIONS');
  });

  it('wires report collection through kpi.js, scorecard rendering, Telegram, and agent_memory artifacts', () => {
    expect(kpiSource).toContain('async function collectCaptainPeriodReport');
    expect(kpiSource).toContain('buildCaptainPeriodReport');
    expect(kpiSource).toContain('formatCaptainPeriodReport');
    expect(kpiSource).toContain("l.metadata->'signal_package'->'company_icp_fit'->>'vertical_match'");
    expect(kpiSource).toContain("logs.action = 'provider_usage'");
    expect(kpiSource).toContain('FROM llm_usage');
    expect(kpiSource).toContain("profile->'icp'->'active_industries'");
    expect(kpiSource).toContain("INSERT INTO agent_memory (client_id, agent, key, content, memory_type)");
    expect(kpiSource).toContain('captain_weekly_report_');
    expect(kpiSource).toContain('captain_monthly_report_');

    expect(indexSource).toContain('async function runCaptainPeriodReports()');
    expect(indexSource).toContain("reportType === 'weekly'");
    expect(indexSource).toContain("reportType === 'monthly'");
    expect(indexSource).toContain('dayOfWeekFromDateKey(todayKey) === 1');
    expect(indexSource).toContain("todayKey.endsWith('-01')");
    expect(indexSource).toContain("telegramService.sendMessage(chatId, `<b>Captain ${reportType} report</b>");
  });
});
