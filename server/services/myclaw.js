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
// Cache the path that worked so we don't probe on every call
let WORKING_PATH = process.env.MYCLAW_HOOK_PATH || null;
const CANDIDATE_PATHS = ['/hooks/agent', '/hooks/wake', '/api/hooks/agent', '/api/v1/hooks/agent'];

async function tryEndpoint(path, body, headers) {
  const url = `${MYCLAW_BASE_URL}${path}`;
  return axios.post(url, body, { headers, timeout: MYCLAW_TIMEOUT, validateStatus: () => true });
}

async function callAgent(message, options = {}) {
  if (!isConfigured()) return null;

  const body = {
    message,
    name: options.name || 'BeavrDam',
    timeoutSeconds: options.timeoutSeconds || 55,
  };
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${MYCLAW_TOKEN}`,
    'x-openclaw-token': MYCLAW_TOKEN,
  };

  // Build path order: cached working path first (if any), then probe candidates
  const pathsToTry = WORKING_PATH
    ? [WORKING_PATH, ...CANDIDATE_PATHS.filter(p => p !== WORKING_PATH)]
    : CANDIDATE_PATHS;

  let lastError = null;
  for (const path of pathsToTry) {
    try {
      console.log(`[myclaw] POST ${MYCLAW_BASE_URL}${path} — ${message.substring(0, 80)}...`);
      const resp = await tryEndpoint(path, body, headers);

      // 404 → wrong path, try the next one
      if (resp.status === 404) {
        console.warn(`[myclaw] 404 on ${path}, trying next path...`);
        lastError = `404 on ${path}`;
        continue;
      }

      // Non-2xx that isn't 404 → this is the right path but something else broke
      if (resp.status >= 400) {
        console.warn(`[myclaw] HTTP ${resp.status} on ${path}: ${typeof resp.data === 'string' ? resp.data.substring(0, 200) : JSON.stringify(resp.data).substring(0, 200)}`);
        lastError = `HTTP ${resp.status} on ${path}`;
        // Cache this path anyway — non-404 means the endpoint exists
        WORKING_PATH = path;
        return null;
      }

      // 2xx — cache the working path and parse the response
      WORKING_PATH = path;
      const data = resp.data;
      const result = data?.response || data?.result || data?.data || data;
      console.log(`[myclaw] Response from ${path}: status=${resp.status}, type=${typeof result}`);

      if (typeof result === 'string') {
        try {
          const cleaned = result.trim()
            .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '')
            .trim();
          return JSON.parse(cleaned);
        } catch {
          return { interpretation: result, raw: result };
        }
      }
      return result;
    } catch (err) {
      console.warn(`[myclaw] Network error on ${path}: ${err.message}`);
      lastError = err.message;
    }
  }

  console.warn(`[myclaw] All endpoint paths failed. Last error: ${lastError}`);
  return null;
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
 * MyClaw as Director Chat brain.
 *
 * Sends a freeform user command + full context, asks MyClaw to interpret
 * intent and return a structured action JSON. BeavrDam dispatches based on
 * the action.
 *
 * Returns:
 *   { action: 'research' | 'check_leads' | 'check_approvals' | 'do_outreach'
 *           | 'check_status' | 'pipeline_summary' | 'chat',
 *     query: string,
 *     filters: object,
 *     reply: string }
 *
 * Or null on failure → caller should fall back to local Haiku classifier.
 */
async function myClawChat(payload) {
  if (!isConfigured()) return null;

  const message = `You are Captain Beaver — the director of BeavrDam, an outbound B2B sales machine.

A user just typed this in Director Chat:
"${payload.command}"

CLIENT CONTEXT:
- Client ID: ${payload.clientId}
${payload.icp ? `- ICP: ${JSON.stringify(payload.icp)}` : ''}
${payload.persona ? `- Persona: ${JSON.stringify(payload.persona)}` : ''}
${payload.recentActivity ? `- Recent activity: ${payload.recentActivity}` : ''}

YOUR JOB:
Decide what action to take. Available actions:

- research: Find/source NEW leads. User examples: "20 b2b founders in KL", "marketing agency CEOs", "find 10 SaaS directors in Singapore", "anyone in proptech malaysia"
- check_leads: View existing leads in pipeline (NOT find new ones). "show my leads", "what do I have"
- show_linkedin: Get LinkedIn URLs of existing leads
- check_approvals: View pending message approvals
- do_outreach: Draft/send messages to existing leads
- check_status: System health / KPI / daily stats
- pipeline_summary: Pipeline overview / dashboard / stats
- check_memory: View agent memory entries
- chat: Greeting, unclear, or conversational reply (no action needed)

CRITICAL RULES:
- A message that contains a job title + a country/city/industry is ALWAYS research, even without verbs like "find"
- Be decisive. Don't ask clarifying questions. Pick the closest action.
- If the user is greeting or chatting, set action to "chat" and put your reply in the reply field

Return JSON only, no markdown:
{
  "action": "research",
  "query": "<the original user command, untouched>",
  "filters": {},
  "reply": "<short Captain-Beaver-voice acknowledgement, 1 sentence>"
}`;

  return callAgent(message, { timeoutSeconds: 25, name: 'BeavrDam-Chat' });
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
  myClawChat,
  myClawBrief,
  myClawReview,
};
