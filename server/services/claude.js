'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_MODEL, MAX_TOKENS, AGENTS } = require('../config/agents');
const { checkBudget, logUsage, notifyBudgetExceeded, BudgetExceededError } = require('./budget');
const { getCurrentClientId } = require('../middleware/clientContext');

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

  // Extract clientId for usage attribution — everything else is ignored.
  // Previously, non-clientId context was serialized as JSON and appended to
  // the prompt, which caused the Ranger to see raw UUIDs/metadata and reject
  // clean messages for "unfilled template variables." All context the agent
  // needs must be in the userMessage itself, not smuggled through this param.
  const clientId = context?.clientId || getCurrentClientId() || null;
  const contextStr = '';

  // ─── Budget gate ───────────────────────────────────────────
  // If we know who's paying, enforce their daily cap BEFORE burning tokens.
  // Unattributed calls (no clientId) pass straight through.
  if (clientId) {
    const { allowed, spend, budget, pct } = await checkBudget(clientId);
    if (!allowed) {
      console.warn(`[claude:budget] BLOCKED client=${clientId} agent=${agentKey} spend=$${spend.toFixed(4)} budget=$${budget.toFixed(2)}`);
      // Fire-and-forget Telegram alert (deduped to once-per-day-per-client)
      notifyBudgetExceeded({ clientId, spend, budget }).catch(() => {});
      throw new BudgetExceededError({ clientId, spend, budget });
    }
    if (pct >= 0.8) {
      console.warn(`[claude:budget] WARN client=${clientId} agent=${agentKey} at ${Math.round(pct * 100)}% of daily cap ($${spend.toFixed(4)} / $${budget.toFixed(2)})`);
    }
  }

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

  // Usage telemetry — stdout for Railway logs, and persisted to llm_usage
  // for per-client daily spend attribution. Fire-and-forget; a logging
  // failure must never break the caller.
  const elapsedMs = Date.now() - t0;
  try {
    const u = response?.usage || {};
    console.log(
      `[claude:usage] client=${clientId || 'n/a'} agent=${agentKey} model=${model} ` +
      `in=${u.input_tokens || 0} out=${u.output_tokens || 0} ` +
      `cache_write=${u.cache_creation_input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} ` +
      `elapsed=${elapsedMs}ms`
    );
    // Persist to llm_usage (no await inside try — catch handles promise errors)
    logUsage({ clientId, agent: agentKey, model, usage: u, elapsedMs })
      .catch(e => console.warn('[claude:usage] persist failed:', e.message));
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

/**
 * Call an agent with tool use. Multi-turn loop: model may call tools, we execute,
 * feed results back, and repeat until stop_reason === 'end_turn' OR max iterations.
 *
 * @param {string}   agentKey      Key into AGENTS (director, research_beaver, etc.)
 * @param {string}   userMessage   The user's message to start the conversation
 * @param {Array}    tools         Anthropic tool definitions (name, description, input_schema)
 * @param {Function} toolHandler   async (toolName, input) => any — executes each tool call
 * @param {object}   [context]     { clientId, systemPrompt } — systemPrompt overrides the
 *                                 default agent.systemPrompt (used by Captain Beaver to
 *                                 load myclaw/*.md persona files instead of config/agents.js)
 * @returns {Promise<{ text: string, toolCalls: Array, iterations: number }>}
 */
async function callAgentWithTools(agentKey, userMessage, tools, toolHandler, context = {}) {
  if (!client) throw new Error('Anthropic client not initialised');
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('callAgentWithTools requires a non-empty tools array');
  if (typeof toolHandler !== 'function') throw new Error('callAgentWithTools requires a toolHandler function');

  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  const model = agent.model || CLAUDE_MODEL;
  const maxTokens = agent.maxTokens || MAX_TOKENS;
  // Optional per-call override — lets callers inject a dynamically-built system prompt
  // (e.g. Captain Beaver loading myclaw/*.md persona files). Falls back to the config prompt.
  const systemPromptText = context?.systemPrompt || agent.systemPrompt;

  const clientId = context?.clientId || getCurrentClientId() || null;

  // Budget gate (reuse single-shot logic)
  if (clientId) {
    const { allowed, spend, budget, pct } = await checkBudget(clientId);
    if (!allowed) {
      console.warn(`[claude:budget] BLOCKED client=${clientId} agent=${agentKey} spend=$${spend.toFixed(4)} budget=$${budget.toFixed(2)}`);
      notifyBudgetExceeded({ clientId, spend, budget }).catch(() => {});
      throw new BudgetExceededError({ clientId, spend, budget });
    }
    if (pct >= 0.8) {
      console.warn(`[claude:budget] WARN client=${clientId} agent=${agentKey} at ${Math.round(pct * 100)}% of daily cap`);
    }
  }

  const MAX_ITERATIONS = 6;

  // Seed the conversation with prior turns if the caller provided them.
  // history is an array of { role: 'user'|'assistant', content: string } already
  // sanitised by the caller (captainBeaver.handleChat clamps to 20 turns / 8k chars each).
  // The CURRENT user message is always appended as the last user turn.
  const priorHistory = Array.isArray(context?.history) ? context.history : [];
  const messages = [...priorHistory, { role: 'user', content: userMessage }];
  const toolCalls = [];
  let finalText = '';
  let iteration = 0;
  const t0 = Date.now();

  for (iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response;
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: 'text',
            text: systemPromptText,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools,
        messages,
      });
    } catch (err) {
      const elapsed = Date.now() - t0;
      const status = err?.status || 'unknown';
      console.warn(`[claude:tools] ${agentKey} via ${model} failed after ${elapsed}ms iter=${iteration}: ${status} ${err?.message || ''}`);
      throw err;
    }

    // Log usage for this turn
    try {
      const u = response?.usage || {};
      console.log(
        `[claude:usage] client=${clientId || 'n/a'} agent=${agentKey} model=${model} iter=${iteration} ` +
        `in=${u.input_tokens || 0} out=${u.output_tokens || 0} ` +
        `cache_write=${u.cache_creation_input_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} ` +
        `stop=${response.stop_reason}`
      );
      logUsage({ clientId, agent: agentKey, model, usage: u, elapsedMs: Date.now() - t0 })
        .catch(e => console.warn('[claude:usage] persist failed:', e.message));
    } catch { /* never break on logging failure */ }

    // Collect any text blocks from this turn (model may emit text before tool_use)
    const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (textBlocks) finalText = textBlocks; // keep the latest text (usually the final one)

    // If there are no tool_use blocks, we're done
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
      return { text: finalText, toolCalls, iterations: iteration + 1, stop_reason: response.stop_reason };
    }

    // Record the assistant message so the model sees its own tool_use blocks next turn
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool call and build tool_result blocks
    const toolResults = [];
    for (const tu of toolUses) {
      const callRecord = { name: tu.name, input: tu.input, id: tu.id };
      try {
        const result = await toolHandler(tu.name, tu.input);
        callRecord.result = result;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      } catch (err) {
        callRecord.error = err.message;
        console.warn(`[claude:tools] tool ${tu.name} failed: ${err.message}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify({ error: err.message }),
          is_error: true,
        });
      }
      toolCalls.push(callRecord);
    }

    // Feed tool results back as a user-role message
    messages.push({ role: 'user', content: toolResults });
  }

  // Max iterations reached — return what we have with a warning
  console.warn(`[claude:tools] ${agentKey} hit MAX_ITERATIONS=${MAX_ITERATIONS}, returning partial result`);
  return {
    text: finalText || 'I ran out of reasoning steps before reaching a final answer. Here is what I got so far.',
    toolCalls,
    iterations: MAX_ITERATIONS,
    stop_reason: 'max_iterations',
  };
}

module.exports = { callAgent, callAgentWithTools };
