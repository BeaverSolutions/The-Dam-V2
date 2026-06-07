'use strict';

const DEFAULT_DAILY_TARGET = 50;
const MAX_SINGLE_KICKOFF_LEADS = 20;
const LOW_OUTPUT_STOP_RATIO = 0.2;
const LOW_OUTPUT_STOP_THRESHOLD = LOW_OUTPUT_STOP_RATIO;

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

function shouldStopForLowOutput({ requested, delivered } = {}) {
  const requestedCount = Number(requested) || 0;
  const deliveredCount = Number(delivered) || 0;
  if (requestedCount <= 0) return false;
  return deliveredCount / requestedCount < LOW_OUTPUT_STOP_RATIO;
}

module.exports = {
  DEFAULT_DAILY_TARGET,
  MAX_SINGLE_KICKOFF_LEADS,
  LOW_OUTPUT_STOP_RATIO,
  LOW_OUTPUT_STOP_THRESHOLD,
  clampSingleKickoffCount,
  clampDailyTarget,
  shouldStopForLowOutput,
};
