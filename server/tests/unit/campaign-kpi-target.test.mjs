import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCampaignTarget } = require('../../utils/campaignKpiTarget');

describe('campaign KPI target resolver', () => {
  it('uses the remaining daily KPI gap for bare kickoff commands', () => {
    const target = resolveCampaignTarget({
      explicitCount: null,
      dailyTarget: 50,
      sentToday: 3,
    });

    expect(target).toEqual({
      requestedCount: 47,
      source: 'daily_kpi_gap',
      dailyTarget: 50,
      sentToday: 3,
      remainingGap: 47,
    });
  });

  it('keeps explicit lead counts as bounded manual campaign targets', () => {
    const target = resolveCampaignTarget({
      explicitCount: 5,
      dailyTarget: 50,
      sentToday: 3,
    });

    expect(target).toEqual({
      requestedCount: 5,
      source: 'explicit_request',
      dailyTarget: 50,
      sentToday: 3,
      remainingGap: 47,
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
  });
});
