'use strict';

/**
 * Phase D piece 3 — Quality threshold auto-tuner.
 *
 * Reads agent_outcomes from the last N days, computes pass-through rate
 * (sent → replied) at each candidate threshold, picks the LOWEST threshold
 * where pass-through clears the target rate AND volume is statistically
 * meaningful, then writes the new threshold to clients.vp_threshold_score.
 *
 * Logs the action via beaverState.logCaptainAction so it surfaces in
 * Captain's morning brief under "actions taken".
 *
 * Failure mode: insufficient data (< minSent observations) → no-op,
 * returns {tuned: false, reason: 'insufficient_data'}. Cron tolerates
 * this for the first weeks while reply data accumulates.
 *
 * Cron: Sunday 17:00 MYT (= 09:00 UTC). Off-cron via the manual trigger
 * endpoint POST /api/autonomous/trigger-quality-tune for validation.
 */

const pool = require('../db/pool');
const logger = require('../utils/logger');
const { logCaptainAction } = require('./beaverState');

const DEFAULT_LOOKBACK_DAYS = 14;
const DEFAULT_MIN_SENT      = 20;        // Need this many sent at the chosen threshold
const DEFAULT_TARGET_RATE   = 0.05;      // 5% reply rate target for cold outreach
const THRESHOLD_CANDIDATES  = [50, 55, 60, 65, 70, 75, 80, 85];
const ABSOLUTE_FLOOR        = 50;        // Never tune below this
const ABSOLUTE_CEILING      = 90;        // Never tune above this

/**
 * Compute current threshold's snapshot + per-candidate pass-through.
 */
async function analyzePassThrough(clientId, lookbackDays) {
  const { rows: sent } = await pool.query(
    `SELECT lead_id, message_id, quality_score
       FROM agent_outcomes
      WHERE client_id = $1
        AND outcome = 'sent'
        AND quality_score IS NOT NULL
        AND occurred_at > NOW() - ($2 || ' days')::interval`,
    [clientId, lookbackDays]
  );

  const { rows: replied } = await pool.query(
    `SELECT DISTINCT lead_id
       FROM agent_outcomes
      WHERE client_id = $1
        AND outcome = 'replied'
        AND occurred_at > NOW() - ($2 || ' days')::interval`,
    [clientId, lookbackDays]
  );

  const repliedLeadIds = new Set(replied.map(r => r.lead_id));

  const buckets = THRESHOLD_CANDIDATES.map(t => {
    const above   = sent.filter(s => s.quality_score >= t);
    const replyN  = above.filter(s => repliedLeadIds.has(s.lead_id)).length;
    return {
      threshold: t,
      sent: above.length,
      replied: replyN,
      rate: above.length > 0 ? +(replyN / above.length).toFixed(4) : 0,
    };
  });

  return { sent_total: sent.length, replied_total: replied.length, buckets };
}

/**
 * Pick the lowest threshold that meets target rate AND has enough volume
 * for the result to be reliable. "Enough volume" = at least minSent OR
 * 25% of the cohort, whichever is greater.
 */
function pickThreshold(buckets, sentTotal, targetRate, minSent) {
  const volumeFloor = Math.max(minSent, Math.ceil(sentTotal * 0.25));
  const qualifying = buckets
    .filter(b => b.sent >= volumeFloor && b.rate >= targetRate)
    .sort((a, b) => a.threshold - b.threshold);
  return qualifying[0] || null;
}

async function tuneVpThreshold(clientId, options = {}) {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const minSent      = options.minSent      ?? DEFAULT_MIN_SENT;
  const targetRate   = options.targetRate   ?? DEFAULT_TARGET_RATE;
  const dryRun       = !!options.dryRun;

  const analysis = await analyzePassThrough(clientId, lookbackDays);

  const { rows: [client] } = await pool.query(
    `SELECT vp_threshold_score, name FROM clients WHERE id = $1`,
    [clientId]
  );
  if (!client) throw new Error(`client ${clientId} not found`);
  const current = client.vp_threshold_score;

  // Insufficient data — log + exit
  if (analysis.sent_total < minSent) {
    return {
      tuned: false,
      reason: 'insufficient_data',
      current_threshold: current,
      sent_total: analysis.sent_total,
      replied_total: analysis.replied_total,
      min_required: minSent,
      buckets: analysis.buckets,
    };
  }

  const candidate = pickThreshold(analysis.buckets, analysis.sent_total, targetRate, minSent);

  if (!candidate) {
    return {
      tuned: false,
      reason: 'no_qualifying_threshold',
      current_threshold: current,
      sent_total: analysis.sent_total,
      replied_total: analysis.replied_total,
      target_rate: targetRate,
      buckets: analysis.buckets,
    };
  }

  // Clamp to absolute bounds
  const newThreshold = Math.max(ABSOLUTE_FLOOR, Math.min(ABSOLUTE_CEILING, candidate.threshold));

  if (newThreshold === current) {
    return {
      tuned: false,
      reason: 'already_optimal',
      current_threshold: current,
      candidate: candidate,
      buckets: analysis.buckets,
    };
  }

  if (dryRun) {
    return {
      tuned: false,
      reason: 'dry_run',
      current_threshold: current,
      proposed_threshold: newThreshold,
      candidate,
      buckets: analysis.buckets,
    };
  }

  // Apply
  await pool.query(
    `UPDATE clients SET vp_threshold_score = $1, updated_at = NOW() WHERE id = $2`,
    [newThreshold, clientId]
  );

  // Log Captain action so it surfaces in tomorrow's brief under "actions taken"
  await logCaptainAction(clientId, 'tune_vp_threshold', {
    from: current,
    to: newThreshold,
    rationale: `lookback ${lookbackDays}d: ${analysis.sent_total} sent, ${analysis.replied_total} replied. At new threshold ${newThreshold}: ${candidate.sent} sent, ${candidate.replied} replied (${(candidate.rate * 100).toFixed(2)}%) — clears ${(targetRate * 100).toFixed(0)}% target.`,
    target_rate: targetRate,
    buckets: analysis.buckets,
  }).catch(err => logger.warn({ msg: '[quality-tuner] logCaptainAction failed', err: err.message }));

  return {
    tuned: true,
    from: current,
    to: newThreshold,
    rate_at_new: candidate.rate,
    sent_at_new: candidate.sent,
    replied_at_new: candidate.replied,
    sent_total: analysis.sent_total,
    replied_total: analysis.replied_total,
    buckets: analysis.buckets,
  };
}

/**
 * Persist the tuning run snapshot to agent_memory so we have a history
 * of decisions even when no change was made (insufficient_data is itself
 * useful signal — Captain can surface "still building data" in the brief).
 */
async function persistTuningRun(clientId, result) {
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'captain_orchestrator', $2, $3::jsonb, 'config')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, `quality_tune_${today}`, JSON.stringify(result)]
  );
}

/**
 * Public entry — run + persist.
 */
async function runQualityTune(clientId, options = {}) {
  const result = await tuneVpThreshold(clientId, options);
  await persistTuningRun(clientId, result).catch(err =>
    logger.warn({ msg: '[quality-tuner] persist failed', err: err.message })
  );
  return result;
}

module.exports = { runQualityTune, tuneVpThreshold, analyzePassThrough, pickThreshold };
