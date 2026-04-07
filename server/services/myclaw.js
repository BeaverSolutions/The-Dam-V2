'use strict';

/**
 * MyClaw Integration — replaces Captain Beaver's Claude call.
 *
 * When MYCLAW_WEBHOOK_URL is configured, directorPlan and directorBrief
 * route through MyClaw instead of Claude. MyClaw has full strategic context
 * about Beaver Solutions, pilot clients, and business goals.
 *
 * Setup: Set these env vars in Railway:
 *   MYCLAW_WEBHOOK_URL=https://your-myclaw-endpoint/webhook
 *   MYCLAW_API_KEY=your-api-key (optional, for auth)
 *
 * MyClaw should return JSON matching Captain Beaver's output format.
 */

let axios;
try {
  axios = require('axios');
} catch {
  console.warn('[myclaw] axios not installed');
}

const MYCLAW_URL = process.env.MYCLAW_WEBHOOK_URL || '';
const MYCLAW_KEY = process.env.MYCLAW_API_KEY || '';
const MYCLAW_TIMEOUT = parseInt(process.env.MYCLAW_TIMEOUT_MS, 10) || 30000;

function isConfigured() {
  return !!(MYCLAW_URL && axios);
}

/**
 * Send a command to MyClaw and get a response.
 *
 * @param {string} action   - 'plan' | 'brief' | 'execute' | 'review'
 * @param {object} payload  - { command, icp, persona, memory, clientId, ... }
 * @returns {object|null}   - MyClaw's response or null on failure
 */
async function callMyClaw(action, payload) {
  if (!isConfigured()) return null;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (MYCLAW_KEY) headers['Authorization'] = `Bearer ${MYCLAW_KEY}`;
    // Also send as x-api-key for webhook platforms that use that pattern
    if (MYCLAW_KEY) headers['x-api-key'] = MYCLAW_KEY;

    console.log(`[myclaw] Calling MyClaw: action=${action}, command=${payload.command?.substring(0, 80) || 'N/A'}`);

    const resp = await axios.post(
      MYCLAW_URL,
      {
        action,
        ...payload,
        source: 'the-dam',
        timestamp: new Date().toISOString(),
      },
      {
        headers,
        timeout: MYCLAW_TIMEOUT,
      }
    );

    const data = resp.data;

    // MyClaw may wrap response in { data: ... } or return directly
    const result = data?.data || data?.result || data;

    console.log(`[myclaw] Response received: status=${resp.status}, keys=${Object.keys(result || {}).join(',')}`);
    return result;
  } catch (err) {
    console.warn(`[myclaw] Call failed (action=${action}):`, err.message);
    return null;
  }
}

/**
 * Ask MyClaw to create a campaign plan.
 * Returns same format as Captain Beaver: { interpretation, steps, estimated_leads, estimated_time }
 * Returns null if MyClaw is unavailable → caller falls back to Claude.
 */
async function myClawPlan(payload) {
  return callMyClaw('plan', payload);
}

/**
 * Ask MyClaw for a daily/weekly brief.
 * Returns { summary, priorities, alerts } or null.
 */
async function myClawBrief(payload) {
  return callMyClaw('brief', payload);
}

/**
 * Ask MyClaw to review campaign results and suggest next actions.
 * Called after directorExecute completes.
 */
async function myClawReview(payload) {
  return callMyClaw('review', payload);
}

module.exports = {
  isConfigured,
  callMyClaw,
  myClawPlan,
  myClawBrief,
  myClawReview,
};
