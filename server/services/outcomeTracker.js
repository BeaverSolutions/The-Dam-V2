'use strict';

const pool = require('../db/pool');
const logger = require('../utils/logger');

/**
 * Phase D piece 2 — outcome attribution helper.
 *
 * Single entry point for writing rows to agent_outcomes. Best-effort and
 * non-throwing: callers should use it as fire-and-forget so a tracker
 * failure never blocks the real work (sourcing, drafting, sending, etc).
 *
 * Hooks shipped today: sourced, drafted, sent, replied.
 * Deferred (data sources don't exist yet): meeting_booked, closed_won,
 * closed_lost, bounced, unsubscribed.
 *
 * Snapshot pattern: caller passes whatever attribution dimensions are
 * already in scope (signal_type, segment, source_strategy, channel,
 * quality_score, signal_tier). recordOutcome stores them as a snapshot
 * so historical analysis is stable when lead attributes evolve later.
 *
 * @param {string} clientId
 * @param {object} opts
 * @param {string} opts.outcome — required, one of the canonical values
 * @param {string} opts.leadId  — required
 * @param {string} [opts.messageId]
 * @param {string} [opts.sourceStrategy]
 * @param {string} [opts.signalType]
 * @param {string} [opts.segment]
 * @param {string} [opts.channel]
 * @param {number} [opts.qualityScore]
 * @param {string} [opts.signalTier]
 * @param {object} [opts.eventData]   — outcome-specific payload, jsonb
 * @returns {Promise<void>}
 */
async function recordOutcome(clientId, opts = {}) {
  const {
    outcome,
    leadId,
    messageId = null,
    sourceStrategy = null,
    signalType = null,
    segment = null,
    channel = null,
    qualityScore = null,
    signalTier = null,
    eventData = {},
  } = opts;

  if (!clientId || !leadId || !outcome) {
    logger.warn({ msg: '[outcomeTracker] missing required field', clientId, leadId, outcome });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO agent_outcomes
         (client_id, lead_id, message_id, outcome,
          source_strategy, signal_type, segment, channel,
          quality_score, signal_tier, event_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        clientId, leadId, messageId, outcome,
        sourceStrategy, signalType, segment, channel,
        qualityScore, signalTier, JSON.stringify(eventData || {}),
      ]
    );
  } catch (err) {
    // Never throw from a tracker. Log and continue.
    logger.warn({ msg: '[outcomeTracker] insert failed', outcome, leadId, err: err.message });
  }
}

/**
 * Convenience helper: extract attribution dimensions from a lead row.
 * Use when the caller has the lead in hand and wants a one-liner.
 */
function attributionFromLead(lead) {
  if (!lead) return {};
  const meta = lead.metadata || {};
  return {
    sourceStrategy: lead.source || null,
    signalType: meta.signal || meta.signal_type || null,
    segment: meta.industry || meta.segment || null,
    qualityScore: lead.quality_score ?? null,
    signalTier: lead.signal_tier || null,
  };
}

module.exports = { recordOutcome, attributionFromLead };
