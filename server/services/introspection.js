'use strict';

/**
 * Per-beaver self-reports. Each beaver writes one row at the end of
 * every meaningful run: target / actual / blockers / which directives
 * it acted on. Captain quotes these in morning + EOD briefs so MJ
 * sees what the team thinks of itself, not just raw counters.
 *
 * Wave 2 of the goal-hunting refactor (2026-05-03).
 */

const pool = require('../db/pool');

/**
 * Write a self-report at end of run.
 * @param {string} clientId
 * @param {string} agent — e.g. 'research_beaver', 'sales_beaver', 'kickoff'
 * @param {object} args
 * @param {Date|string} args.runStartedAt
 * @param {object} args.metrics — beaver-specific target-vs-actual snapshot
 * @param {string} args.summary — one sentence Captain can quote verbatim
 * @param {string} [args.blockers]
 * @param {string[]} [args.actedOnDirectives] — UUIDs of directives applied
 */
async function writeReport(clientId, agent, args) {
  const { runStartedAt, metrics, summary, blockers = null, actedOnDirectives = [] } = args;
  const { rows } = await pool.query(
    `INSERT INTO agent_introspection
       (client_id, agent, run_started_at, metrics, summary, blockers, acted_on_directives)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::uuid[])
     RETURNING id`,
    [clientId, agent, runStartedAt, JSON.stringify(metrics), summary, blockers, actedOnDirectives]
  );
  return rows[0].id;
}

/**
 * Latest report per beaver — what the briefs read.
 */
async function latestPerBeaver(clientId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (agent)
            agent, run_started_at, run_ended_at, metrics, summary, blockers, acted_on_directives
     FROM agent_introspection
     WHERE client_id = $1 AND run_ended_at >= NOW() - INTERVAL '36 hours'
     ORDER BY agent, run_ended_at DESC`,
    [clientId]
  );
  return rows;
}

/**
 * Did directives Captain wrote yesterday actually land? Used by Captain's
 * EOD reflection to learn whether its own decisions are working.
 *
 * Returns an array of { directive_id, agent, summary, applied }.
 */
async function directiveLandingReport(clientId, hours = 24) {
  const { rows } = await pool.query(
    `SELECT
       d.id              AS directive_id,
       d.target_agent    AS agent,
       d.directive_type,
       d.reason          AS captain_reason,
       d.status          AS directive_status,
       d.consumed_at,
       i.summary         AS beaver_summary,
       i.metrics         AS beaver_metrics
     FROM agent_directives d
     LEFT JOIN agent_introspection i
       ON i.client_id = d.client_id
       AND i.agent = d.target_agent
       AND d.id = ANY(i.acted_on_directives)
     WHERE d.client_id = $1 AND d.created_at >= NOW() - ($2 || ' hours')::INTERVAL
     ORDER BY d.created_at DESC`,
    [clientId, String(hours)]
  );
  return rows;
}

module.exports = { writeReport, latestPerBeaver, directiveLandingReport };
