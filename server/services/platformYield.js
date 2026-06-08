'use strict';

const pool = require('../db/pool');
const registry = require('./platformRegistry');

function nonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function calculateYieldPct({ outputCount, requestedCount } = {}) {
  const requested = Math.max(1, Number(requestedCount) || 1);
  return Math.round((nonNegativeInteger(outputCount) / requested) * 100);
}

function classifyStrategyHealth({ requestedCount, outputCount, blocker } = {}) {
  const output = nonNegativeInteger(outputCount);
  const yieldPct = calculateYieldPct({ outputCount: output, requestedCount });
  if (blocker || output <= 0) {
    return { status: 'proof', yield_pct: yieldPct, reason: blocker || 'zero_output' };
  }
  if (yieldPct > 30) {
    return { status: 'trusted_candidate', yield_pct: yieldPct, reason: 'yield_above_threshold' };
  }
  return { status: 'proof', yield_pct: yieldPct, reason: 'yield_below_threshold' };
}

function strategyKeyForPlan(plan = {}) {
  const seq = Array.isArray(plan.platform_sequence) ? plan.platform_sequence : [];
  const first = seq[0] || {};
  const signal = first.signal_id || 'unknown_signal';
  const geo = first.geo || first.country || 'unknown_geo';
  const platforms = seq.map(p => p.platform).filter(Boolean).join(',');
  return `${signal}|${geo}|${platforms}`;
}

async function recordPlatformYield(clientId, event = {}) {
  const validation = registry.validateQuery(event.query || '', event.provider || 'brave');
  const queryValid = event.query_valid === false ? false : validation.valid;
  const { rows: [row] } = await pool.query(
    `INSERT INTO platform_yield_events
       (client_id, plan_id, directive_id, platform, provider, mode, signal_id, signal_family, source_channel, geo,
        query, query_hash, query_chars, query_words, query_valid, paid_units, raw_results, raw_candidates,
        icp_passed, decision_makers_found, contacts_found, saved_leads, approval_ready, sent, replies, meetings,
        blocker, error_code, metadata)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, $23, $24, $25, $26,
        $27, $28, $29::jsonb)
     RETURNING id`,
    [
      clientId,
      event.plan_id || null,
      event.directive_id || null,
      event.platform || 'unknown',
      event.provider || null,
      event.mode || 'proof',
      event.signal_id || null,
      event.signal_family || null,
      event.source_channel || null,
      event.geo || null,
      event.query || null,
      event.query_hash || validation.query_hash,
      nonNegativeInteger(event.query_chars ?? validation.chars),
      nonNegativeInteger(event.query_words ?? validation.words),
      queryValid,
      nonNegativeInteger(event.paid_units),
      nonNegativeInteger(event.raw_results),
      nonNegativeInteger(event.raw_candidates),
      nonNegativeInteger(event.icp_passed),
      nonNegativeInteger(event.decision_makers_found),
      nonNegativeInteger(event.contacts_found),
      nonNegativeInteger(event.saved_leads),
      nonNegativeInteger(event.approval_ready),
      nonNegativeInteger(event.sent),
      nonNegativeInteger(event.replies),
      nonNegativeInteger(event.meetings),
      event.blocker || null,
      event.error_code || null,
      JSON.stringify(event.metadata || {}),
    ]
  );
  return row;
}

async function updateStrategyStateFromPlan(clientId, plan = {}, result = {}) {
  const outputCount = nonNegativeInteger(result.approval_ready ?? result.saved_leads ?? result.saved);
  const health = classifyStrategyHealth({
    requestedCount: plan.requested_count,
    outputCount,
    blocker: result.blocker || null,
  });
  const seq = Array.isArray(plan.platform_sequence) ? plan.platform_sequence : [];
  const first = seq[0] || {};
  const strategyKey = strategyKeyForPlan(plan);
  const status = health.status === 'trusted_candidate' ? 'trusted' : 'proof';
  const { rows: [row] } = await pool.query(
    `INSERT INTO platform_strategy_state
       (client_id, strategy_key, status, signal_id, geo, platforms, last_plan_id, last_plan_hash,
        last_yield_pct, last_requested_count, last_output_count, consecutive_green_runs, last_blocker,
        trusted_at, trusted_by, downgraded_at, downgrade_reason, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
        $9, $10, $11, CASE WHEN $3 = 'trusted' THEN 1 ELSE 0 END, $12,
        CASE WHEN $3 = 'trusted' THEN NOW() ELSE NULL END,
        CASE WHEN $3 = 'trusted' THEN $13 ELSE NULL END,
        CASE WHEN $3 = 'proof' THEN NOW() ELSE NULL END,
        CASE WHEN $3 = 'proof' THEN $12 ELSE NULL END,
        NOW())
     ON CONFLICT (client_id, strategy_key)
       DO UPDATE SET
         status = EXCLUDED.status,
         last_plan_id = EXCLUDED.last_plan_id,
         last_plan_hash = EXCLUDED.last_plan_hash,
         last_yield_pct = EXCLUDED.last_yield_pct,
         last_requested_count = EXCLUDED.last_requested_count,
         last_output_count = EXCLUDED.last_output_count,
         consecutive_green_runs = CASE
           WHEN EXCLUDED.status = 'trusted' THEN platform_strategy_state.consecutive_green_runs + 1
           ELSE 0
         END,
         last_blocker = EXCLUDED.last_blocker,
         trusted_at = CASE
           WHEN EXCLUDED.status = 'trusted' THEN COALESCE(platform_strategy_state.trusted_at, NOW())
           ELSE platform_strategy_state.trusted_at
         END,
         trusted_by = CASE
           WHEN EXCLUDED.status = 'trusted' THEN EXCLUDED.trusted_by
           ELSE platform_strategy_state.trusted_by
         END,
         downgraded_at = CASE
           WHEN EXCLUDED.status = 'proof' THEN NOW()
           ELSE platform_strategy_state.downgraded_at
         END,
         downgrade_reason = CASE
           WHEN EXCLUDED.status = 'proof' THEN EXCLUDED.downgrade_reason
           ELSE platform_strategy_state.downgrade_reason
         END,
         updated_at = NOW()
     RETURNING *`,
    [
      clientId,
      strategyKey,
      status,
      first.signal_id || null,
      first.geo || first.country || null,
      JSON.stringify(seq.map(p => p.platform).filter(Boolean)),
      plan.id || null,
      plan.plan_hash || null,
      health.yield_pct,
      nonNegativeInteger(plan.requested_count),
      outputCount,
      health.reason,
      result.trusted_by || 'system',
    ]
  );
  return row;
}

module.exports = {
  calculateYieldPct,
  classifyStrategyHealth,
  strategyKeyForPlan,
  recordPlatformYield,
  updateStrategyStateFromPlan,
};
