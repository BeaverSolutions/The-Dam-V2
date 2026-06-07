import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const indexSource = readFileSync(resolve(root, 'index.js'), 'utf-8').replace(/\r\n/g, '\n');

const { degradedReasonFromResult, isDbBuilderStale } = require('../../services/jobHealth.js');

describe('jobHealth db_builder schedule', () => {
  it('does not mark DB Builder stale during the planned gap between 08:30 and 13:00 MYT', () => {
    const lastRunAt = '2026-05-28T00:32:48.487Z';
    const now = new Date('2026-05-28T03:45:00.000Z').getTime();

    expect(isDbBuilderStale(lastRunAt, now)).toBe(false);
  });

  it('marks DB Builder stale after a scheduled window is missed', () => {
    const lastRunAt = '2026-05-27T05:02:00.000Z';
    const now = new Date('2026-05-28T01:00:00.000Z').getTime();

    expect(isDbBuilderStale(lastRunAt, now)).toBe(true);
  });

  it('does not mark DB Builder stale immediately inside the grace period', () => {
    const lastRunAt = '2026-05-27T05:02:00.000Z';
    const now = new Date('2026-05-28T00:45:00.000Z').getTime();

    expect(isDbBuilderStale(lastRunAt, now)).toBe(false);
  });
});

describe('jobHealth scheduled autonomy blockers', () => {
  it('degrades health for zero-output and tenant-profile blockers inside scheduler results', () => {
    expect(degradedReasonFromResult({
      fired: true,
      summary: {
        blocker: 'raw_candidates_zero',
        diagnostics: { reason: 'signals_zero_after_llm_parse' },
      },
    })).toBe('raw_candidates_zero');

    expect(degradedReasonFromResult({
      blocked: true,
      reason: 'tenant_buying_signals_missing',
      tenant_profile_valid: false,
    })).toBe('tenant_buying_signals_missing');

    expect(degradedReasonFromResult({
      alreadyDone: true,
      reason: 'hourly KPI-gap dedupe row present',
    })).toBe(null);
  });

  it('checks autonomy blocker health before marking daily and KPI-gap kickoffs green', () => {
    const dailyStart = indexSource.lastIndexOf('runDailyKickoff()');
    const dailyBody = indexSource.slice(dailyStart, indexSource.indexOf('runCaptainEodBrief()', dailyStart));
    expect(dailyBody.indexOf('degradedReasonFromResult(result)')).toBeGreaterThan(-1);
    expect(dailyBody.indexOf('degradedReasonFromResult(result)')).toBeLessThan(dailyBody.indexOf("jobHealth.markRun('daily_kickoff'"));

    const kpiStart = indexSource.lastIndexOf('runKpiGapKickoff()');
    const kpiBody = indexSource.slice(kpiStart, indexSource.indexOf('// ── LinkedIn stale connection sweep', kpiStart));
    expect(kpiBody.indexOf('degradedReasonFromResult(result)')).toBeGreaterThan(-1);
    expect(kpiBody.indexOf('degradedReasonFromResult(result)')).toBeLessThan(kpiBody.indexOf("jobHealth.markRun('kpi_gap_kickoff'"));
  });

  it('preserves autonomous kickoff blocker results instead of counting them as healthy fires', () => {
    expect(indexSource).toContain('const kickoffResult = await runWithClientContext(client.id');
    expect(indexSource).toContain('const kickoffBlocker = jobHealth.degradedReasonFromResult(kickoffResult)');
    expect(indexSource).toContain('result.blocked++');
    expect(indexSource).toContain('result.blockers.push');
    expect(indexSource).toContain('await runWithClientContext(client.id, () =>');
  });

  it('bubbles degraded jobs into top-level /health status', () => {
    expect(indexSource).toContain("const degradedJobs = Object.entries(jobs).filter(([, v]) => v.status === 'degraded').map(([k]) => k)");
    expect(indexSource).toContain("status: dbOk ? ((staleJobs.length > 0 || degradedJobs.length > 0) ? 'degraded' : 'ok') : 'degraded'");
    expect(indexSource).toContain('degraded_jobs: degradedJobs');
  });
});
