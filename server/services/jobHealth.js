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

function markRun(jobName) {
  if (!jobs[jobName]) jobs[jobName] = { runs: 0, errors: 0, lastRunAt: null, lastErrorAt: null, lastError: null };
  jobs[jobName].runs++;
  jobs[jobName].lastRunAt = new Date().toISOString();
}

function markError(jobName, errMsg) {
  if (!jobs[jobName]) jobs[jobName] = { runs: 0, errors: 0, lastRunAt: null, lastErrorAt: null, lastError: null };
  jobs[jobName].errors++;
  jobs[jobName].lastErrorAt = new Date().toISOString();
  jobs[jobName].lastError = String(errMsg).slice(0, 200);
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
  };

  const now = Date.now();
  const summary = {};

  for (const [name, data] of Object.entries(jobs)) {
    const staleThreshold = expectedIntervals[name];
    const msSinceRun = data.lastRunAt ? now - new Date(data.lastRunAt).getTime() : null;
    const isStale = name === 'db_builder'
      ? isDbBuilderStale(data.lastRunAt, now)
      : staleThreshold && msSinceRun && msSinceRun > staleThreshold;

    summary[name] = {
      status: isStale ? 'stale' : (data.runs > 0 ? 'ok' : 'waiting'),
      runs: data.runs,
      errors: data.errors,
      lastRunAt: data.lastRunAt,
      lastError: data.lastError,
    };
  }

  return summary;
}

module.exports = { markRun, markError, getStatus, isDbBuilderStale };
