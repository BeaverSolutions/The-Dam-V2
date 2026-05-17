'use strict';

/**
 * OpenAI LLM adapter — the second provider behind BeavrDam's agents.
 *
 * Why this exists (2026-05-16): BeavrDam ran exclusively on the Anthropic API.
 * One vendor = one point of failure (the Emplifive "Empy" incident proved it).
 * This adapter lets the 4 beavers run on OpenAI instead, selected at runtime.
 *
 * Activated by `LLM_PROVIDER=openai`. Default is unset → Anthropic path in
 * claude.js runs untouched. claude.js branches to these functions at the very
 * top of callAgent / callAgentWithTools when the flag is set — so the proven
 * Anthropic code is never modified.
 *
 * Interface mirrors claude.js exactly:
 *   callAgentOpenAI(agentKey, userMessage, context)            → parsed JSON | {raw}
 *   callAgentWithToolsOpenAI(agentKey, userMessage, tools, toolHandler, context)
 *                                                              → {text, toolCalls, iterations, stop_reason}
 *
 * Budget gate + usage logging are replicated here (via ./budget) so the OpenAI
 * path enforces the same per-client daily cap as the Anthropic path.
 */

const OpenAI = require('openai');
const { AGENTS, MODELS, CLAUDE_MODEL, MAX_TOKENS } = require('../../config/agents');
const { checkBudget, logUsage, notifyBudgetExceeded, BudgetExceededError } = require('../budget');
const { getCurrentClientId } = require('../../middleware/clientContext');
const { getOutreachRules, getProofNumbers } = require('../salesRules');

const REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 60_000;

let client;
try {
  client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 2,
  });
} catch (err) {
  console.warn('[openai] Failed to initialise OpenAI client:', err.message);
}

// ─── Model mapping ──────────────────────────────────────────────────────────
// Agents declare Claude model IDs (config/agents.js). Map each tier to an
// OpenAI model. Env-overridable so the model can change without a code edit.
const OPENAI_MODEL_REASONING = process.env.OPENAI_MODEL_REASONING || 'gpt-4.1';
const OPENAI_MODEL_FAST = process.env.OPENAI_MODEL_FAST || 'gpt-4.1-mini';

function mapModel(claudeModel) {
  const m = String(claudeModel || '').toLowerCase();
  if (m.includes('haiku')) return OPENAI_MODEL_FAST;        // fast / high-volume tier
  return OPENAI_MODEL_REASONING;                            // sonnet / reasoning tier (default)
}

// ─── Prompt resolution — kept in sync with claude.js ────────────────────────
const _resolvedPromptCache = new Map();
function resolveSystemPrompt(agentKey, rawPrompt) {
  if (!rawPrompt.includes('{{OUTREACH_RULES}}') && !rawPrompt.includes('{{PROOF_NUMBERS}}')) {
    return rawPrompt;
  }
  const cached = _resolvedPromptCache.get(agentKey);
  if (cached) return cached;
  const resolved = rawPrompt
    .replace('{{OUTREACH_RULES}}', getOutreachRules())
    .replace('{{PROOF_NUMBERS}}', getProofNumbers());
  _resolvedPromptCache.set(agentKey, resolved);
  return resolved;
}

// Kept in sync with claude.js EXECUTION_MODE_SUFFIX. Must contain "JSON" so
// OpenAI's json_object response_format is satisfied.
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

// Normalise OpenAI usage → the shape logUsage / budget expect (Anthropic shape).
function normaliseUsage(u) {
  if (!u) return {};
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens || 0,
  };
}

async function enforceBudget(clientId, agentKey) {
  if (!clientId) return;
  const { allowed, spend, budget, pct, period } = await checkBudget(clientId);
  if (!allowed) {
    console.warn(`[openai:budget] BLOCKED client=${clientId} agent=${agentKey} ${period} spend=$${spend.toFixed(4)} budget=$${budget.toFixed(2)}`);
    notifyBudgetExceeded({ clientId, spend, budget, period }).catch(err => console.error('[openai:budget] Telegram alert FAILED:', err.message));
    throw new BudgetExceededError({ clientId, spend, budget, period });
  }
  if (pct >= 0.8) {
    console.warn(`[openai:budget] WARN client=${clientId} agent=${agentKey} at ${Math.round(pct * 100)}% of ${period} cap`);
  }
}

/**
 * Single-shot agent call. Mirrors claude.js callAgent — returns parsed JSON
 * (or { raw } on parse failure).
 */
async function callAgentOpenAI(agentKey, userMessage, context = {}) {
  if (!client) throw new Error('OpenAI client not initialised (OPENAI_API_KEY missing?)');

  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  const model = mapModel(agent.model || CLAUDE_MODEL);
  const maxTokens = agent.maxTokens || MAX_TOKENS;
  const clientId = context?.clientId || getCurrentClientId() || null;

  await enforceBudget(clientId, agentKey);

  const systemText = resolveSystemPrompt(agentKey, agent.systemPrompt) + EXECUTION_MODE_SUFFIX;

  let response;
  const t0 = Date.now();
  try {
    response = await client.chat.completions.create({
      model,
      max_completion_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: userMessage },
      ],
    });
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.warn(`[openai] ${agentKey} via ${model} failed after ${elapsed}ms: ${err?.status || 'unknown'} ${err?.message || ''}`);
    throw err;
  }

  const elapsedMs = Date.now() - t0;
  try {
    const u = normaliseUsage(response?.usage);
    console.log(
      `[openai:usage] client=${clientId || 'n/a'} agent=${agentKey} model=${model} ` +
      `in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens} elapsed=${elapsedMs}ms`
    );
    logUsage({ clientId, agent: agentKey, model, usage: u, elapsedMs })
      .catch(e => console.warn('[openai:usage] persist failed:', e.message));
  } catch { /* never break the caller on a logging failure */ }

  const rawText = response.choices?.[0]?.message?.content || '';
  try {
    let text = rawText.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    try { return JSON.parse(text); } catch {}
    const matched = text.match(/\{[\s\S]*\}/)?.[0] || text.match(/\[[\s\S]*\]/)?.[0];
    if (matched) return JSON.parse(matched);
    return { raw: text };
  } catch {
    return { raw: rawText };
  }
}

/**
 * Multi-turn tool-use call. Mirrors claude.js callAgentWithTools — runs the
 * whole loop in OpenAI's native function-calling format and returns
 * { text, toolCalls, iterations, stop_reason }.
 */
async function callAgentWithToolsOpenAI(agentKey, userMessage, tools, toolHandler, context = {}) {
  if (!client) throw new Error('OpenAI client not initialised (OPENAI_API_KEY missing?)');
  if (!Array.isArray(tools) || tools.length === 0) throw new Error('callAgentWithTools requires a non-empty tools array');
  if (typeof toolHandler !== 'function') throw new Error('callAgentWithTools requires a toolHandler function');

  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  const model = mapModel(agent.model || CLAUDE_MODEL);
  const maxTokens = agent.maxTokens || MAX_TOKENS;
  const clientId = context?.clientId || getCurrentClientId() || null;
  const systemText = context?.systemPrompt || resolveSystemPrompt(agentKey, agent.systemPrompt);

  await enforceBudget(clientId, agentKey);

  // Convert Anthropic tool defs {name, description, input_schema} → OpenAI
  // function defs {type:'function', function:{name, description, parameters}}.
  const openaiTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
  }));

  // Seed conversation. priorHistory is [{role,content}] sanitised by the caller.
  const priorHistory = Array.isArray(context?.history) ? context.history : [];
  const messages = [
    { role: 'system', content: systemText },
    ...priorHistory,
    { role: 'user', content: userMessage },
  ];
  const toolCalls = [];
  let finalText = '';
  const MAX_ITERATIONS = 10;
  const t0 = Date.now();

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let response;
    try {
      response = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        tools: openaiTools,
        messages,
      });
    } catch (err) {
      console.warn(`[openai:tools] ${agentKey} via ${model} failed iter=${iteration}: ${err?.status || 'unknown'} ${err?.message || ''}`);
      throw err;
    }

    try {
      const u = normaliseUsage(response?.usage);
      console.log(`[openai:usage] client=${clientId || 'n/a'} agent=${agentKey} model=${model} iter=${iteration} in=${u.input_tokens} out=${u.output_tokens}`);
      logUsage({ clientId, agent: agentKey, model, usage: u, elapsedMs: Date.now() - t0 })
        .catch(e => console.warn('[openai:usage] persist failed:', e.message));
    } catch { /* never break on logging failure */ }

    const choice = response.choices?.[0];
    const msg = choice?.message || {};
    if (msg.content) finalText = msg.content;

    const calls = msg.tool_calls || [];
    if (calls.length === 0 || choice?.finish_reason === 'stop') {
      return { text: finalText, toolCalls, iterations: iteration + 1, stop_reason: choice?.finish_reason || 'stop' };
    }

    // Record the assistant turn (with its tool_calls) so the model sees its own calls.
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });

    // Execute each tool call, feed results back as role:'tool' messages.
    for (const call of calls) {
      let input = {};
      try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = {}; }
      const callRecord = { name: call.function?.name, input, id: call.id };
      try {
        const result = await toolHandler(call.function?.name, input);
        callRecord.result = result;
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        });
      } catch (err) {
        callRecord.error = err.message;
        console.warn(`[openai:tools] tool ${call.function?.name} failed: ${err.message}`);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: err.message }),
        });
      }
      toolCalls.push(callRecord);
    }
  }

  console.warn(`[openai:tools] ${agentKey} hit MAX_ITERATIONS=${MAX_ITERATIONS}, returning partial result`);
  return {
    text: finalText || 'I ran out of reasoning steps before reaching a final answer.',
    toolCalls,
    iterations: MAX_ITERATIONS,
    stop_reason: 'max_iterations',
  };
}

module.exports = { callAgentOpenAI, callAgentWithToolsOpenAI, mapModel };
