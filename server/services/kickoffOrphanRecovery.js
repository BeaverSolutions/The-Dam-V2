'use strict';

const { todayInMalaysia } = require('../utils/businessDay');

const ORPHAN_AGENT = 'captain_orchestrator';
const ORPHAN_REASON = 'process_restart_orphan';
const ORPHAN_BOUNDARY = 'daily_kickoff_orphan_sweep';
const MIN_ORPHAN_AGE_MS = 30 * 60 * 1000;

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function number(value) {
  return Number(value) || 0;
}

function dailyKickoffHasWorkProof(proof) {
  return !!proof?.daily_kickoff_work_log || number(proof?.trace_count) > 0;
}

function dailyKickoffHasFailureProof(proof) {
  return !!proof?.daily_kickoff_failure_proof;
}

async function markDailyKickoffOrphans({
  pool,
  now = new Date(),
  uptimeSeconds = process.uptime(),
  enabledSlugs = [],
  getDailyKickoffProof,
  isKickoffRunning = () => false,
} = {}) {
  if (!pool?.query) throw new Error('pool is required');
  if (typeof getDailyKickoffProof !== 'function') throw new Error('getDailyKickoffProof is required');

  const result = {
    checked: 0,
    marked: 0,
    skipped_not_started: 0,
    skipped_running: 0,
    skipped_work_proof: 0,
    skipped_failure_proof: 0,
    skipped_not_orphan: 0,
    skipped_existing: 0,
    clients: [],
  };

  const slugs = Array.isArray(enabledSlugs) ? enabledSlugs.filter(Boolean) : [];
  if (slugs.length === 0) {
    return { ...result, disabled: true, reason: 'AUTONOMOUS_ENABLED_CLIENTS empty' };
  }

  const today = todayInMalaysia(now);
  const { rows: clients } = await pool.query(
    `SELECT id, slug FROM clients WHERE slug = ANY($1) AND is_active = true AND onboarding_completed = true`,
    [slugs]
  );

  for (const client of clients) {
    result.checked++;
    result.clients.push(client.slug);

    if (isKickoffRunning(client.id)) {
      result.skipped_running++;
      continue;
    }

    const proof = await getDailyKickoffProof(client.id, today);
    if (!proof?.daily_kickoff_started) {
      result.skipped_not_started++;
      continue;
    }
    if (dailyKickoffHasWorkProof(proof)) {
      result.skipped_work_proof++;
      continue;
    }
    if (dailyKickoffHasFailureProof(proof)) {
      result.skipped_failure_proof++;
      continue;
    }

    const markerAt = toDate(proof.daily_kickoff_started_at);
    if (!markerAt) {
      result.skipped_not_orphan++;
      continue;
    }

    const markerAgeMs = now.getTime() - markerAt.getTime();
    if (markerAgeMs <= MIN_ORPHAN_AGE_MS || (number(uptimeSeconds) * 1000) >= markerAgeMs) {
      result.skipped_not_orphan++;
      continue;
    }

    const sent = number(proof.sent);
    const approvalReady = number(proof.approval_ready);
    const drafting = number(proof.drafting);
    const rejected = number(proof.rejected);
    const delivered = sent + approvalReady;
    const totalOutput = delivered + drafting;
    const content = {
      reason: ORPHAN_REASON,
      boundary: ORPHAN_BOUNDARY,
      detected_at: now.toISOString(),
      today,
      run_marker_at: markerAt.toISOString(),
      marker_age_minutes: Math.floor(markerAgeMs / 60000),
      process_uptime_seconds: Math.floor(number(uptimeSeconds)),
      trace_count: number(proof.trace_count),
      sent,
      approval_ready: approvalReady,
      drafting,
      rejected,
      delivered,
      total_output: totalOutput,
    };

    const key = `daily_kickoff_failure_${today}_${ORPHAN_REASON}`;
    const inserted = await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
       VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
       ON CONFLICT (client_id, agent, key) DO NOTHING
       RETURNING id`,
      [client.id, key, JSON.stringify(content)]
    );

    if (!inserted.rows?.length) {
      result.skipped_existing++;
      continue;
    }

    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata)
       VALUES ($1, 'captain_orchestrator', 'autonomous_kickoff_failed', 'system', $2::jsonb)`,
      [client.id, JSON.stringify(content)]
    );
    result.marked++;
  }

  return result.checked > 0 ? result : { ...result, skipped: true, reason: 'no active onboarded clients matched AUTONOMOUS_ENABLED_CLIENTS' };
}

module.exports = {
  MIN_ORPHAN_AGE_MS,
  ORPHAN_AGENT,
  ORPHAN_BOUNDARY,
  ORPHAN_REASON,
  dailyKickoffHasFailureProof,
  dailyKickoffHasWorkProof,
  markDailyKickoffOrphans,
};
