import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCampaignTarget } = require('../../utils/campaignKpiTarget');
const { shouldStopForLowOutput } = require('../../utils/campaignLimits');

describe('campaign KPI target resolver', () => {
  it('uses the daily KPI gap but caps one kickoff run at 20 outputs', () => {
    const target = resolveCampaignTarget({
      explicitCount: null,
      dailyTarget: 50,
      sentToday: 3,
    });

    expect(target).toEqual({
      requestedCount: 20,
      source: 'daily_kpi_gap',
      dailyTarget: 50,
      sentToday: 3,
      remainingGap: 47,
      remainingAfterRun: 27,
      singleRunCap: 20,
    });
  });

  it('keeps explicit lead counts under the single-run cap', () => {
    const target = resolveCampaignTarget({
      explicitCount: 47,
      dailyTarget: 50,
      sentToday: 3,
    });

    expect(target).toEqual({
      requestedCount: 20,
      source: 'explicit_request',
      dailyTarget: 50,
      sentToday: 3,
      remainingGap: 47,
      remainingAfterRun: 27,
      singleRunCap: 20,
    });
  });

  it('returns zero when the daily KPI is already met', () => {
    const target = resolveCampaignTarget({
      explicitCount: null,
      dailyTarget: 50,
      sentToday: 50,
    });

    expect(target.requestedCount).toBe(0);
    expect(target.remainingGap).toBe(0);
    expect(target.remainingAfterRun).toBe(0);
  });

  it('stops runs that produce less than 30% of requested outputs', () => {
    expect(shouldStopForLowOutput({ requested: 20, delivered: 5 })).toBe(true);
    expect(shouldStopForLowOutput({ requested: 20, delivered: 6 })).toBe(false);
    expect(shouldStopForLowOutput({ requested: 50, delivered: 14 })).toBe(true);
    expect(shouldStopForLowOutput({ requested: 50, delivered: 15 })).toBe(false);
    expect(shouldStopForLowOutput({ requested: 5, delivered: 1 })).toBe(true);
    expect(shouldStopForLowOutput({ requested: 5, delivered: 2 })).toBe(false);
  });
});
