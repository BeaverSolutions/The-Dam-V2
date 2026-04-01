'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_MODEL, MAX_TOKENS, AGENTS } = require('../config/agents');

let client;

try {
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
} catch (err) {
  console.warn('[claude] Failed to initialise Anthropic client:', err.message);
}

async function callAgent(agentKey, userMessage, context = {}) {
  if (!client) throw new Error('Anthropic client not initialised');

  const agent = AGENTS[agentKey];
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

  const contextStr =
    Object.keys(context).length > 0
      ? `\n\nContext:\n${JSON.stringify(context, null, 2)}`
      : '';

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,

    // 🔥 CRITICAL FIX — FORCE EXECUTION MODE
    system: agent.systemPrompt + `
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
`,

    messages: [
      {
        role: 'user',
        content: userMessage + contextStr,
      },
    ],
  });

  try {
    // Strip markdown code fences
    let text = response.content[0].text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

    // Try direct parse first
    try {
      return JSON.parse(text);
    } catch {}

    // Try to extract JSON object or array
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