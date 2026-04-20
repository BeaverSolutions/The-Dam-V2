'use strict';

/**
 * Background Job Health Tracker
 *
 * Tracks last-run timestamps and error counts for all background jobs.
 * Exposed via /health endpoint for ops visibility.
 * Never throws — all methods are fire-and-forget safe.
 */

const jobs = {};

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

/**
 * Returns health summary for all tracked jobs.
 * A job is "stale" if it hasn't run within 2x its expected interval.
 */
function getStatus() {
  const expectedIntervals = {
    reply_detector: 10 * 60 * 1000,     // 5min interval, stale after 10min
    send_queue: 3 * 60 * 1000,          // 60s interval, stale after 3min
    follow_up_scheduler: 65 * 60 * 1000, // 30min interval, stale after 65min
    db_builder: 35 * 60 * 1000,          // 15min interval, stale after 35min
    daily_kickoff: 25 * 60 * 60 * 1000,  // daily, stale after 25h
    morning_brief: 25 * 60 * 60 * 1000,
    linkedin_sweep: 13 * 60 * 60 * 1000, // 6h interval, stale after 13h
  };

  const now = Date.now();
  const summary = {};

  for (const [name, data] of Object.entries(jobs)) {
    const staleThreshold = expectedIntervals[name];
    const msSinceRun = data.lastRunAt ? now - new Date(data.lastRunAt).getTime() : null;
    const isStale = staleThreshold && msSinceRun && msSinceRun > staleThreshold;

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

module.exports = { markRun, markError, getStatus };
