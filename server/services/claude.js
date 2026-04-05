'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_MODEL, MAX_TOKENS, AGENTS } = require('../config/agents');

// 30s ceiling on any Claude call. If a model is slow, we fail fast
// rather than leaking a hanging HTTP connection that the background
// autonomous task can't cancel.
const CLAUDE_REQUEST_TIMEOUT_MS = Number(process.env.CLAUDE_REQUEST_TIMEOUT_MS) || 30_000;

let client;

try {
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: CLAUDE_REQUEST_TIMEOUT_MS,
    maxRetries: 2, // SDK default is 2; keep it explicit
  });
} catch (err) {
  console.warn('[claude] Failed to initialise Anthropic client:', err.message);
}

// ─── Execution-mode suffix ─────────────────────────────────────
// Appended to every agent's system prompt. Kept as a SEPARATE constant so
// prompt caching treats the base system prompt as the cache key — small
// suffix changes here don't invalidate a 10KB cached system prompt.
const EXECUTION_MODE_SUFFIX = `

IMPORTANT RULES:
- You are an EXECUTION agent, not a planner
- Do NOT explain what you will do
- Do NOT describe steps
- Do NOT create a plan
- Do NOT think out loud
- ONLY return the final answer
- If asked for companies → return actual companies
- If asked for leads → return actual leads
- Output MUST be valid JSON
- No markdown
- No explanation
`;

/**
 * Call a named agent.
 *
 * @param {string} agentKey - key into AGENTS (director | research_beaver | sales_beaver | reply_classifier | ranger)
 * @param {string} userMessage - the user message for this call
 * @param {object} [context] - optional metadata merged into the user message as JSON context.
 *                             Special keys: `clientId` is stripped from the user message and
 *                             used for usage attribution; everything else is passed through.
 * @returns parsed JSON object or `{ raw: string }` on parse failure
 */
async function callAgent(agentKey, userMessage, context = {}) {
  if (!client) throw new Error('Anthropic client not initialised');

  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  // Per-agent routing with safe fallbacks to the legacy globals.
  const model = agent.model || CLAUDE_MODEL;
  const maxTokens = agent.maxTokens || MAX_TOKENS;

  // Strip clientId (used only for usage attribution) out of the context
  // that gets stringified into the user message.
  const { clientId, ...passthroughContext } = context;
  const contextStr =
    Object.keys(passthroughContext).length > 0
      ? `\n\nContext:\n${JSON.stringify(passthroughContext, null, 2)}`
      : '';

  let response;
  const t0 = Date.now();
  try {
    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // Prompt caching: the system prompt is stable across thousands of calls
      // per day. Marking it as ephemeral-cached means after the first call
      // subsequent calls pay ~10% of input token cost for this block.
      // Requires ≥1024 tokens in the cached content; our agent prompts are
      // all multi-KB so this is always active.
      system: [
        {
          type: 'text',
          text: agent.systemPrompt + EXECUTION_MODE_SUFFIX,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: userMessage + contextStr },
      ],
    });
  } catch (err) {
    const elapsed = Date.now() - t0;
    // Surface a clear error to callers. The SDK's APIError includes status + type.
    const status = err?.status || 'unknown';
    const type = err?.error?.type || err?.name || 'error';
    console.warn(`[claude] ${agentKey} via ${model} failed after ${elapsed}ms: ${status} ${type} ${err?.message || ''}`);
    throw err;
  }

  // Fire-and-forget usage telemetry. Persistence is added in the budget-cap commit;
  // for now we just log so Railway logs show cost attribution per agent/model.
  try {
    const u = response?.usage || {};
    console.log(
      `[claude:usage] client=${clientId || 'n/a'} agent=${agentKey} model=${model} ` +
      `in=${u.input_tokens || 0} out=${u.output_tokens || 0} ` +
      `cache_write=${u.cache_creation_input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} ` +
      `elapsed=${Date.now() - t0}ms`
    );
  } catch { /* never break the caller on a logging failure */ }

  try {
    let text = response.content[0].text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

    try { return JSON.parse(text); } catch {}

    const objMatch = text.match(/\{[\s\S]*\}/);
    const arrMatch = text.match(/\[[\s\S]*\]/);
    const matched = objMatch?.[0] || arrMatch?.[0];
    if (matched) return JSON.parse(matched);

    return { raw: text };
  } catch {
    return { raw: response.content[0].text };
  }
}

module.exports = { callAgent };
