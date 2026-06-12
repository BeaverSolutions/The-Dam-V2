'use strict';

/**
 * Background Job Health Tracker
 *
 * Tracks last-run timestamps and error counts for all background jobs.
 * Exposed via /health endpoint for ops visibility.
 * Never throws — all methods are fire-and-forget safe.
 */

const jobs = {};
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// DB Builder is scheduled in server/index.js for two UTC windows:
// 00:30-00:39 UTC (08:30 MYT) and 05:00-05:09 UTC (13:00 MYT).
// Health should only go stale after a scheduled window was missed, not during
// the planned multi-hour gaps between runs.
const DB_BUILDER_WINDOWS_UTC = [
  { hour: 0, minute: 30, durationMinutes: 10 },
  { hour: 5, minute: 0, durationMinutes: 10 },
];
const DB_BUILDER_GRACE_MS = 20 * MINUTE;

const AUTONOMY_DEGRADED_REASONS = new Set([
  'tenant_buying_signals_missing',
  'tenant_profile_invalid',
  'profile_invalid',
  'raw_candidates_zero',
  'signals_zero_after_llm_parse',
  'raw_candidates_zero_after_approved_cap',
  'icp_zero_after_company_extract',
  'decision_maker_zero',
  'contact_zero',
  'zero_outputs',
  'low_yield_outputs',
  'repeated_zero_output_query_set',
  'same_query_set_failed',
  'provider_cap_closed',
  'process_restart_orphan',
]);

const AUTONOMY_DEGRADED_PATTERNS = [
  /tenant[_ -]buying[_ -]signals[_ -]missing/i,
  /tenant[_ -]profile.*invalid/i,
  /profile[_ -]invalid/i,
  /raw[_ -]candidates[_ -]zero/i,
  /signals[_ -]zero[_ -]after[_ -]llm[_ -]parse/i,
  /icp[_ -]zero/i,
  /decision[_ -]maker[_ -]zero/i,
  /contact[_ -]zero/i,
  /zero[_ -]outputs?/i,
  /low[_ -]yield[_ -]outputs?/i,
  /zero[-_ ]output/i,
  /no output proof/i,
  /process[_ -]restart[_ -]orphan/i,
];

function ensureJob(jobName) {
  if (!jobs[jobName]) {
    jobs[jobName] = {
      runs: 0,
      skips: 0,
      errors: 0,
      lastRunAt: null,
      lastSkippedAt: null,
      lastSkipReason: null,
      lastDegradedAt: null,
      lastDegradedReason: null,
      lastErrorAt: null,
      lastError: null,
      lastMeta: null,
    };
  }
  return jobs[jobName];
}

function markRun(jobName, metadata = null) {
  ensureJob(jobName);
  jobs[jobName].runs++;
  jobs[jobName].lastRunAt = new Date().toISOString();
  jobs[jobName].lastMeta = metadata;
}

function markSkipped(jobName, reason, metadata = null) {
  ensureJob(jobName);
  jobs[jobName].skips++;
  jobs[jobName].lastSkippedAt = new Date().toISOString();
  jobs[jobName].lastSkipReason = String(reason || 'skipped').slice(0, 200);
  jobs[jobName].lastMeta = metadata ? { ...metadata, reason: jobs[jobName].lastSkipReason } : { reason: jobs[jobName].lastSkipReason };
}

function markError(jobName, errMsg) {
  ensureJob(jobName);
  jobs[jobName].errors++;
  jobs[jobName].lastErrorAt = new Date().toISOString();
  jobs[jobName].lastError = String(errMsg).slice(0, 200);
}

function markDegraded(jobName, reason, metadata = null) {
  ensureJob(jobName);
  jobs[jobName].lastDegradedAt = new Date().toISOString();
  jobs[jobName].lastDegradedReason = String(reason || 'degraded').slice(0, 200);
  jobs[jobName].lastMeta = metadata ? { ...metadata, reason: jobs[jobName].lastDegradedReason } : { reason: jobs[jobName].lastDegradedReason };
}

function normalizeReason(value) {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason || null;
}

function isAutonomyDegradedReason(value) {
  const reason = normalizeReason(value);
  if (!reason) return false;
  return AUTONOMY_DEGRADED_REASONS.has(reason)
    || AUTONOMY_DEGRADED_PATTERNS.some(pattern => pattern.test(reason));
}

function degradedReasonFromResult(result) {
  const seen = new Set();

  function visit(value, depth = 0) {
    if (!value || depth > 8) return null;
    if (typeof value === 'string') {
      return isAutonomyDegradedReason(value) ? value : null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    for (const key of ['blocker', 'reason', 'code', 'error_code', 'circuit_breaker_tripped', 'status']) {
      const reason = normalizeReason(value[key]);
      if (isAutonomyDegradedReason(reason)) return reason;
    }

    if (value.tenant_profile_valid === false) {
      return 'tenant_profile_invalid';
    }

    if (value.blocked === true && Number(value.total_output) === 0) {
      return 'zero_outputs';
    }

    for (const key of Object.keys(value)) {
      if (['blocker', 'reason', 'code', 'error_code', 'circuit_breaker_tripped', 'status'].includes(key)) continue;
      const found = visit(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  return visit(result);
}

function utcWindowFor(day, window) {
  const start = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    window.hour,
    window.minute,
    0,
    0
  );
  return {
    start,
    end: start + window.durationMinutes * MINUTE,
  };
}

function mostRecentDbBuilderWindow(nowMs) {
  const now = new Date(nowMs);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 24 * HOUR);
  const windows = [];

  for (const day of [today, yesterday]) {
    for (const window of DB_BUILDER_WINDOWS_UTC) {
      windows.push(utcWindowFor(day, window));
    }
  }

  return windows
    .filter(window => nowMs >= window.end + DB_BUILDER_GRACE_MS)
    .sort((a, b) => b.end - a.end)[0] || null;
}

function isDbBuilderStale(lastRunAt, nowMs = Date.now()) {
  if (!lastRunAt) return false;
  const lastRunMs = new Date(lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) return false;

  const recentWindow = mostRecentDbBuilderWindow(nowMs);
  if (!recentWindow) return false;
  return lastRunMs < recentWindow.start;
}

/**
 * Returns health summary for all tracked jobs.
 * A job is "stale" if it hasn't run within 2x its expected interval.
 */
function getStatus() {
  const expectedIntervals = {
    reply_detector: 10 * MINUTE,      // 5min interval, stale after 10min
    send_queue: 3 * MINUTE,           // 60s interval, stale after 3min
    follow_up_scheduler: 65 * MINUTE, // 30min interval, stale after 65min
    daily_kickoff: 25 * HOUR,         // daily, stale after 25h
    morning_brief: 25 * HOUR,
    linkedin_sweep: 13 * HOUR,        // 6h interval, stale after 13h
    auto_approval_recovery: 35 * MINUTE, // 15min interval, stale after 35min
  };

  const now = Date.now();
  const summary = {};

  for (const [name, data] of Object.entries(jobs)) {
    const staleThreshold = expectedIntervals[name];
    const msSinceRun = data.lastRunAt ? now - new Date(data.lastRunAt).getTime() : null;
    const isStale = name === 'db_builder'
      ? isDbBuilderStale(data.lastRunAt, now)
      : staleThreshold && msSinceRun && msSinceRun > staleThreshold;
    const lastRunMs = data.lastRunAt ? new Date(data.lastRunAt).getTime() : 0;
    const lastSkippedMs = data.lastSkippedAt ? new Date(data.lastSkippedAt).getTime() : 0;
    const lastDegradedMs = data.lastDegradedAt ? new Date(data.lastDegradedAt).getTime() : 0;
    const latestEventWasSkip = lastSkippedMs > lastRunMs;
    const latestEventWasDegraded = lastDegradedMs > Math.max(lastRunMs, lastSkippedMs);
    const skippedStatus = latestEventWasSkip
      ? (/disabled/i.test(data.lastSkipReason || '') ? 'disabled' : 'skipped')
      : null;

    summary[name] = {
      status: skippedStatus || (latestEventWasDegraded ? 'degraded' : (isStale ? 'stale' : (data.runs > 0 ? 'ok' : 'waiting'))),
      runs: data.runs,
      skips: data.skips || 0,
      errors: data.errors,
      lastRunAt: data.lastRunAt,
      lastSkippedAt: data.lastSkippedAt,
      lastSkipReason: data.lastSkipReason,
      lastDegradedAt: data.lastDegradedAt,
      lastDegradedReason: data.lastDegradedReason,
      lastError: data.lastError,
      lastMeta: data.lastMeta,
    };
  }

  return summary;
}

module.exports = {
  markRun,
  markSkipped,
  markError,
  markDegraded,
  getStatus,
  isDbBuilderStale,
  degradedReasonFromResult,
  isAutonomyDegradedReason,
};
