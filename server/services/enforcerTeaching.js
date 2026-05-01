'use strict';

/**
 * Enforcer weekly teaching note generator (BATCH 3 cron stub).
 *
 * Sunday 18:00 MYT cron — queries the last 7 days of:
 *   - agent_outcomes (rejected events with signal_type, segment)
 *   - messages (ranger_score, ranger_notes for review patterns)
 *   - improvement-after-feedback events (Sales retry pass rate)
 *
 * Hands the aggregate to Sonnet (enforcer agent) and asks for a teaching
 * note that names the dominant patterns + recommends one tightening for
 * next week. Persists to agent_memory keyed `enforcer_teaching_YYYY-WW`
 * so Captain's Monday morning brief can quote it.
 *
 * Stub-level — the LLM prompt is intentionally minimal; the value is in
 * the data aggregation + persistence flow being wired so the loop
 * compounds week-over-week without further code changes.
 */

const pool = require('../db/pool');
const logger = require('../utils/logger');
const { callAgent } = require('./claude');

const DEFAULT_LOOKBACK_DAYS = 7;
const MIN_REVIEWS_FOR_TEACHING = 10;

async function gatherWeeklyData(clientId, lookbackDays) {
  // Reject patterns from messages.ranger_notes (LLM judgment-gate rejections)
  const rejPatterns = await pool.query(
    `SELECT
       COALESCE(SPLIT_PART(ranger_notes, ':', 1), 'OTHER') AS reason_code,
       COUNT(*) AS n
     FROM messages
     WHERE client_id = $1
       AND ranger_score IS NOT NULL
       AND ranger_score < 75
       AND ranger_notes IS NOT NULL
       AND created_at > NOW() - ($2 || ' days')::interval
     GROUP BY reason_code
     ORDER BY n DESC
     LIMIT 8`,
    [clientId, lookbackDays]
  );

  // Volume + outcomes
  const volume = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE ranger_score IS NOT NULL) AS reviews,
       COUNT(*) FILTER (WHERE ranger_score >= 75) AS approves,
       COUNT(*) FILTER (WHERE ranger_score = 0) AS hard_rejects,
       ROUND(AVG(ranger_score) FILTER (WHERE ranger_score IS NOT NULL)::numeric, 2) AS avg_score
     FROM messages
     WHERE client_id = $1
       AND created_at > NOW() - ($2 || ' days')::interval`,
    [clientId, lookbackDays]
  );

  // Improvement-after-feedback (from logs table — populated by
  // beaverState.recordImprovementAfterFeedback in agents.js retry path)
  const improvement = await pool.query(
    `SELECT
       COUNT(*) AS retries,
       COUNT(*) FILTER (WHERE (metadata->>'retry_passed')::boolean = true) AS retries_passed
     FROM logs
     WHERE client_id = $1
       AND action = 'sales_improvement_check'
       AND created_at > NOW() - ($2 || ' days')::interval`,
    [clientId, lookbackDays]
  );

  // Rejected outcomes from agent_outcomes (Phase D piece 2 substrate)
  const rejByDimension = await pool.query(
    `SELECT
       signal_type,
       segment,
       COUNT(*) AS n
     FROM agent_outcomes
     WHERE client_id = $1
       AND outcome = 'rejected'
       AND occurred_at > NOW() - ($2 || ' days')::interval
     GROUP BY signal_type, segment
     ORDER BY n DESC
     LIMIT 8`,
    [clientId, lookbackDays]
  );

  return {
    volume: volume.rows[0],
    reject_patterns: rejPatterns.rows,
    improvement: improvement.rows[0],
    reject_by_dimension: rejByDimension.rows,
  };
}

async function persistTeachingNote(clientId, payload) {
  const now = new Date();
  // ISO week key: YYYY-WW (Sunday-anchored)
  const week = isoWeek(now);
  const key = `enforcer_teaching_${week}`;
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type)
     VALUES ($1, 'ranger', $2, $3::jsonb, 'config')
     ON CONFLICT (client_id, agent, key) DO UPDATE
       SET content = EXCLUDED.content, updated_at = NOW()`,
    [clientId, key, JSON.stringify(payload)]
  );
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

async function runEnforcerTeaching(clientId, options = {}) {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const data = await gatherWeeklyData(clientId, lookbackDays);

  if ((data.volume?.reviews || 0) < MIN_REVIEWS_FOR_TEACHING) {
    const payload = {
      generated_at: new Date().toISOString(),
      lookback_days: lookbackDays,
      status: 'skipped',
      reason: 'insufficient_data',
      reviews: data.volume?.reviews || 0,
      min_required: MIN_REVIEWS_FOR_TEACHING,
      data,
    };
    await persistTeachingNote(clientId, payload).catch(() => {});
    return payload;
  }

  // Compose user message for the Enforcer agent (already configured as Sonnet)
  const userMessage = `Write this week's teaching note for Sales Beaver. Output PLAIN TEXT, 4-6 sentences max. Conversational-tight tone (lowercase, no preamble).

Last ${lookbackDays} days on Beaver Solutions tenant:
- Reviews: ${data.volume.reviews}
- Approves (≥75): ${data.volume.approves} (${Math.round((data.volume.approves / data.volume.reviews) * 100)}%)
- Hard rejects (=0): ${data.volume.hard_rejects}
- Avg score: ${data.volume.avg_score}
- Improvement after feedback: ${data.improvement.retries_passed} of ${data.improvement.retries} retries passed (${data.improvement.retries > 0 ? Math.round((data.improvement.retries_passed / data.improvement.retries) * 100) + '%' : 'no retries'})

Top rejection reasons:
${data.reject_patterns.map(r => `  - ${r.reason_code}: ${r.n}`).join('\n') || '  (none significant)'}

Rejected outcomes by signal/segment (from agent_outcomes):
${data.reject_by_dimension.map(r => `  - ${r.signal_type || 'unknown'} / ${r.segment || 'unknown'}: ${r.n}`).join('\n') || '  (none significant)'}

Write a teaching note that:
1. Names the dominant pattern Sales should fix this coming week
2. Calls out one positive trend if there is one
3. Recommends one specific tightening (e.g. "tone down qualification questions on the funding-signal segment")

Respond with the teaching note text only. No JSON, no headers.`;

  let teachingNote = null;
  try {
    const result = await callAgent('ranger', userMessage, { clientId });
    teachingNote = (typeof result === 'string') ? result
                  : result?.raw || result?.text || result?.summary || null;
  } catch (err) {
    logger.warn({ msg: '[enforcer-teaching] LLM call failed', err: err.message });
  }

  const payload = {
    generated_at: new Date().toISOString(),
    lookback_days: lookbackDays,
    status: teachingNote ? 'ok' : 'llm_failed',
    teaching_note: teachingNote,
    data,
  };

  await persistTeachingNote(clientId, payload).catch(err =>
    logger.warn({ msg: '[enforcer-teaching] persist failed', err: err.message })
  );

  return payload;
}

module.exports = { runEnforcerTeaching, gatherWeeklyData, isoWeek };
