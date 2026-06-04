'use strict';

const DEFAULT_DAILY_TARGET = 50;
const MAX_SINGLE_KICKOFF_LEADS = 20;

function clampPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.ceil(parsed));
}

function clampSingleKickoffCount(value, fallback = MAX_SINGLE_KICKOFF_LEADS) {
  return Math.min(clampPositiveInt(value, fallback), MAX_SINGLE_KICKOFF_LEADS);
}

function clampDailyTarget(value, fallback = DEFAULT_DAILY_TARGET) {
  return clampPositiveInt(value, fallback);
}

module.exports = {
  DEFAULT_DAILY_TARGET,
  MAX_SINGLE_KICKOFF_LEADS,
  clampSingleKickoffCount,
  clampDailyTarget,
};
