'use strict';

const { vi } = require('vitest');

let agentResponses = [];
let agentCalls = [];

function mockCallAgent(clientId, { agent, prompt, model, maxTokens }) {
  agentCalls.push({ clientId, agent, prompt, model, maxTokens });
  const response = agentResponses.shift();
  if (response instanceof Error) return Promise.reject(response);
  if (response === undefined) {
    return Promise.reject(new Error('No mock response configured for callAgent'));
  }
  return Promise.resolve(response);
}

const cannedResponses = {
  enforcerPass: (score = 85) => JSON.stringify({
    score,
    personalisation: 25,
    relevance: 22,
    quality: 20,
    cta: 18,
    verdict: 'approve',
    suggestions: [],
  }),

  enforcerBorderline: (score = 68) => JSON.stringify({
    score,
    personalisation: 18,
    relevance: 20,
    quality: 15,
    cta: 15,
    verdict: 'approve_with_suggestions',
    suggestions: ['Shorten the opener', 'Add a specific hook about their recent work'],
  }),

  enforcerReject: (score = 35) => JSON.stringify({
    score,
    personalisation: 8,
    relevance: 10,
    quality: 10,
    cta: 7,
    verdict: 'reject',
    reason: 'Generic template with no personalisation',
  }),

  salesDraft: (name = 'Ahmad') => JSON.stringify({
    body: `Hi ${name},\n\nNoticed your agency just expanded into TikTok campaigns. Running creator outreach manually across 10+ brands must be a grind.\n\nWould a 4-second shortlist from 700K verified SEA creators save your team time?\n\nRegards,\nMichael Jerry`,
    subject: null,
    prompt_variant: 'signal_rich_v2',
  }),

  salesDraftBadBanned: (name = 'Ahmad') => JSON.stringify({
    body: `Hi ${name},\n\nI wanted to reach out because your cutting-edge approach to influencer marketing is truly innovative. Let's leverage synergy to move the needle on your campaigns.\n\nWould love to connect and discuss how we can streamline your workflow?\n\nRegards,\nMichael Jerry`,
    subject: null,
    prompt_variant: 'signal_rich_v2',
  }),

  salesDraftTooLong: (name = 'Ahmad') => JSON.stringify({
    body: `Hi ${name},\n\n${'Word '.repeat(120).trim()}\n\nWould this help?\n\nRegards,\nMichael Jerry`,
    subject: null,
    prompt_variant: 'signal_rich_v2',
  }),
};

function queueResponse(response) {
  agentResponses.push(response);
}

function queueResponses(responses) {
  agentResponses.push(...responses);
}

function getCalls() {
  return agentCalls;
}

function getLastCall() {
  return agentCalls[agentCalls.length - 1] || null;
}

function reset() {
  agentResponses = [];
  agentCalls = [];
}

const callAgent = vi.fn(mockCallAgent);

module.exports = {
  callAgent,
  cannedResponses,
  queueResponse,
  queueResponses,
  getCalls,
  getLastCall,
  reset,
};
