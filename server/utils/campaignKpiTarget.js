'use strict';

const DEFAULT_DAILY_TARGET = 50;
const MAX_CAMPAIGN_TARGET = 50;

function boundedCount(value, fallback = DEFAULT_DAILY_TARGET) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(MAX_CAMPAIGN_TARGET, Math.ceil(n)));
}

function resolveCampaignTarget({ explicitCount = null, dailyTarget = DEFAULT_DAILY_TARGET, sentToday = 0 } = {}) {
  const boundedDailyTarget = boundedCount(dailyTarget, DEFAULT_DAILY_TARGET);
  const sent = Math.max(0, Math.floor(Number(sentToday) || 0));
  const remainingGap = Math.max(0, boundedDailyTarget - sent);

  if (explicitCount !== null && explicitCount !== undefined && explicitCount !== '') {
    return {
      requestedCount: boundedCount(explicitCount, boundedDailyTarget),
      source: 'explicit_request',
      dailyTarget: boundedDailyTarget,
      sentToday: sent,
      remainingGap,
    };
  }

  return {
    requestedCount: remainingGap,
    source: 'daily_kpi_gap',
    dailyTarget: boundedDailyTarget,
    sentToday: sent,
    remainingGap,
  };
}

module.exports = {
  resolveCampaignTarget,
};
