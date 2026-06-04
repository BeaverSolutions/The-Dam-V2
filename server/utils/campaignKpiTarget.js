'use strict';

const {
  DEFAULT_DAILY_TARGET,
  MAX_SINGLE_KICKOFF_LEADS,
  clampDailyTarget,
  clampSingleKickoffCount,
} = require('./campaignLimits');

function resolveCampaignTarget({ explicitCount = null, dailyTarget = DEFAULT_DAILY_TARGET, sentToday = 0 } = {}) {
  const boundedDailyTarget = clampDailyTarget(dailyTarget, DEFAULT_DAILY_TARGET);
  const sent = Math.max(0, Math.floor(Number(sentToday) || 0));
  const remainingGap = Math.max(0, boundedDailyTarget - sent);
  const requestedCount = (explicitCount !== null && explicitCount !== undefined && explicitCount !== '')
    ? Math.min(clampSingleKickoffCount(explicitCount), remainingGap || MAX_SINGLE_KICKOFF_LEADS)
    : Math.min(remainingGap, MAX_SINGLE_KICKOFF_LEADS);

  if (explicitCount !== null && explicitCount !== undefined && explicitCount !== '') {
    return {
      requestedCount,
      source: 'explicit_request',
      dailyTarget: boundedDailyTarget,
      sentToday: sent,
      remainingGap,
      remainingAfterRun: Math.max(0, remainingGap - requestedCount),
      singleRunCap: MAX_SINGLE_KICKOFF_LEADS,
    };
  }

  return {
    requestedCount,
    source: 'daily_kpi_gap',
    dailyTarget: boundedDailyTarget,
    sentToday: sent,
    remainingGap,
    remainingAfterRun: Math.max(0, remainingGap - requestedCount),
    singleRunCap: MAX_SINGLE_KICKOFF_LEADS,
  };
}

module.exports = {
  resolveCampaignTarget,
};
