'use strict';

/**
 * MyClaw Integration — MyClaw = Captain Beaver.
 *
 * Uses OpenClaw's /hooks/agent endpoint to run an isolated agent turn.
 * MyClaw has full strategic context about Beaver Solutions, pilot clients,
 * and business goals — making smarter campaign decisions than a template prompt.
 *
 * Setup: Set these env vars in Railway:
 *   MYCLAW_BASE_URL=https://your-openclaw-domain.com
 *   MYCLAW_HOOK_TOKEN=your-shared-secret-token
 *
 * OpenClaw endpoint: POST {MYCLAW_BASE_URL}/hooks/agent
 * Auth: Authorization: Bearer {MYCLAW_HOOK_TOKEN}
 *
 * Falls back to Claude Captain Beaver if MyClaw is unavailable.
 */

let axios;
try {
  axios = require('axios');
} catch {
  console.warn('[myclaw] axios not installed');
}

const MYCLAW_BASE_URL = (process.env.MYCLAW_BASE_URL || process.env.MYCLAW_WEBHOOK_URL || '').replace(/\/$/, '');
const MYCLAW_TOKEN = process.env.MYCLAW_HOOK_TOKEN || process.env.MYCLAW_API_KEY || '';
const MYCLAW_TIMEOUT = parseInt(process.env.MYCLAW_TIMEOUT_MS, 10) || 60000; // 60s — agent turns can take time

function isConfigured() {
  return !!(MYCLAW_BASE_URL && MYCLAW_TOKEN && axios);
}

/**
 * Call MyClaw's /hooks/agent endpoint.
 *
 * OpenClaw /hooks/agent payload format:
 * {
 *   message: string (required) — the prompt/command for MyClaw
 *   name: string — who is calling (for MyClaw's context)
 *   timeoutSeconds: number — max time to wait for response
 * }
 *
 * @param {string} message  - The full prompt to send to MyClaw
 * @param {object} options  - { timeoutSeconds, name }
 * @returns {object|null}   - MyClaw's response or null on failure
 */
async function callAgent(message, options = {}) {
  if (!isConfigured()) return null;

  const endpoint = `${MYCLAW_BASE_URL}/hooks/agent`;

  try {
    console.log(`[myclaw] POST ${endpoint} — ${message.substring(0, 100)}...`);

    const resp = await axios.post(
      endpoint,
      {
        message,
        name: options.name || 'BeavrDam',
        timeoutSeconds: options.timeoutSeconds || 55,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${MYCLAW_TOKEN}`,
          'x-openclaw-token': MYCLAW_TOKEN,
        },
        timeout: MYCLAW_TIMEOUT,
      }
    );

    const data = resp.data;

    // OpenClaw may return different shapes — normalise
    const result = data?.response || data?.result || data?.data || data;

    console.log(`[myclaw] Response: status=${resp.status}, type=${typeof result}`);

    // If result is a string, try to parse as JSON (MyClaw might return a JSON string)
    if (typeof result === 'string') {
      try {
        const trimmed = result.trim();
        // Strip markdown code fences if present
        const cleaned = trimmed
          .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '')
          .trim();
        return JSON.parse(cleaned);
      } catch {
        // Not JSON — return as a text response
        return { interpretation: result, raw: result };
      }
    }

    return result;
  } catch (err) {
    console.warn(`[myclaw] Call failed:`, err.message);
    return null;
  }
}

/**
 * Ask MyClaw to create a campaign plan.
 *
 * Sends full context: command, ICP, persona, memory brief.
 * MyClaw returns: { interpretation, steps, estimated_leads, estimated_time }
 */
async function myClawPlan(payload) {
  const message = `You are Captain Beaver — the Director of BeavrDam.

A user just gave this command in Director Chat:
"${payload.command}"

CLIENT CONTEXT:
- Client ID: ${payload.clientId}
- Requested lead count: ${payload.requested_count || 5}

ICP (Ideal Customer Profile):
${JSON.stringify(payload.icp || {}, null, 2)}

CLIENT PERSONA:
${JSON.stringify(payload.persona || {}, null, 2)}

AGENT MEMORY CONTEXT:
${payload.memory_brief || 'No memory loaded.'}

YOUR TASK:
Create a campaign plan. Consider:
- What industry/role to target and WHY (based on ICP + what's worked before)
- Which signals to look for (hiring, funding, growth, pain indicators)
- What angle Sales Beaver should use
- Any strategic context from memory (past rejections, winning hooks, etc.)

Return valid JSON only:
{
  "interpretation": "What you understood from the command + your strategic additions",
  "steps": [
    { "step": 1, "agent": "research_beaver", "action": "specific search instruction", "status": "pending" },
    { "step": 2, "agent": "sales_beaver", "action": "specific drafting instruction", "status": "pending" },
    { "step": 3, "agent": "ranger", "action": "Quality check all messages", "status": "pending" },
    { "step": 4, "agent": "director", "action": "Queue for user approval", "status": "pending" }
  ],
  "estimated_leads": number,
  "estimated_time": "~X min"
}`;

  return callAgent(message, { timeoutSeconds: 30 });
}

/**
 * Ask MyClaw for a strategic daily brief.
 */
async function myClawBrief(payload) {
  const message = `You are Captain Beaver — the Director of BeavrDam.

Generate a strategic morning brief for the team.

CURRENT STATS:
${JSON.stringify(payload.stats || {}, null, 2)}

RECENT ACTIVITY:
${JSON.stringify((payload.recent_activity || []).map(l => `${l.agent}: ${l.action}`), null, 2)}

YOUR TASK:
Write a concise 2-3 sentence brief. Include:
- Pipeline health: are we on track for 15 meetings this month?
- What needs attention TODAY (approvals, follow-ups, stale leads)
- One strategic recommendation

Return valid JSON only:
{ "summary": "Your brief here", "priorities": ["priority 1", "priority 2"], "alerts": [] }`;

  return callAgent(message, { timeoutSeconds: 20 });
}

/**
 * Ask MyClaw to review campaign results and suggest next actions.
 */
async function myClawReview(payload) {
  const message = `You are Captain Beaver — the Director of BeavrDam.

A campaign just completed. Review the results:
${JSON.stringify(payload, null, 2)}

Analyse: What worked? What didn't? What should the next campaign focus on?

Return valid JSON only:
{ "assessment": "1-2 sentence summary", "next_action": "What to do next", "learnings": ["key insight 1", "key insight 2"] }`;

  return callAgent(message, { timeoutSeconds: 20 });
}

module.exports = {
  isConfigured,
  callAgent,
  myClawPlan,
  myClawBrief,
  myClawReview,
};
