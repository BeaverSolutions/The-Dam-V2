'use strict';

const { getOutreachRules, getProofNumbers } = require('./salesRules');
const { createAuthContext, getTenantContext } = require('./tenantContext');

const LEGACY_PROMPT_CACHE = new Map();

function hasPromptPlaceholders(rawPrompt) {
  return typeof rawPrompt === 'string' &&
    (rawPrompt.includes('{{OUTREACH_RULES}}') || rawPrompt.includes('{{PROOF_NUMBERS}}'));
}

function roleForAgent(agentKey) {
  switch (agentKey) {
    case 'sales_beaver':
      return 'sales';
    case 'ranger':
    case 'enforcer_beaver':
      return 'enforcer';
    case 'research_beaver':
      return 'research';
    case 'captain':
    case 'captain_beaver':
    case 'captain_orchestrator':
      return 'captain';
    default:
      return null;
  }
}

function normalizeTenantChannel(channel) {
  const value = String(channel || '').trim().toLowerCase();
  if (value === 'linkedin' || value === 'linkedin_dm') return 'linkedin_dm';
  if (value === 'linkedin_invite') return 'linkedin_invite';
  if (value === 'email') return 'email';
  return 'email';
}

function formatTenantContext(context) {
  return [
    `TENANT PROFILE CONTEXT (active content_version=${context.content_version || 'unknown'})`,
    context.rendered,
  ].filter(Boolean).join('\n\n');
}

function formatTenantProof(context) {
  const proof = Array.isArray(context.fields?.proof) ? context.fields.proof : [];
  const approved = proof.filter(item => item && item.approved_for_outreach === true);
  if (approved.length === 0) {
    return 'Tenant profile has no approved proof yet. Do not cite client outcomes, numbers, or testimonials.';
  }
  return approved
    .map(item => `- ${item.claim} | ${item.metric} | source: ${item.source}`)
    .join('\n');
}

function resolveLegacyPrompt(agentKey, rawPrompt, getOutreachRulesImpl, getProofNumbersImpl) {
  const cacheKey = `${agentKey || 'unknown'}:${rawPrompt}`;
  const cached = LEGACY_PROMPT_CACHE.get(cacheKey);
  if (cached) return cached;

  const resolved = rawPrompt
    .replace('{{OUTREACH_RULES}}', getOutreachRulesImpl())
    .replace('{{PROOF_NUMBERS}}', getProofNumbersImpl());

  LEGACY_PROMPT_CACHE.set(cacheKey, resolved);
  return resolved;
}

function prependTenantContext(rawPrompt, tenantContext) {
  return [
    `${formatTenantContext(tenantContext)}

This tenant profile is authoritative. It overrides any default ICP examples, default verticals, default geography, default offer, default proof, and default voice inside the base agent prompt below. Do not reject a lead for failing Beaver Solutions' default ICP when it fits this tenant profile.`,
    rawPrompt,
  ].filter(Boolean).join('\n\n');
}

async function resolveTenantAwarePrompt({
  agentKey,
  rawPrompt,
  clientId = null,
  channel = null,
  source = 'service',
  createAuthContextImpl = createAuthContext,
  getTenantContextImpl = getTenantContext,
  getOutreachRulesImpl = getOutreachRules,
  getProofNumbersImpl = getProofNumbers,
} = {}) {
  const role = roleForAgent(agentKey);
  if (clientId && role) {
    const authCtx = createAuthContextImpl({ clientId, source });
    const tenantContext = await getTenantContextImpl(authCtx, {
      role,
      channel: normalizeTenantChannel(channel),
    });

    if (tenantContext?.active === true) {
      if (hasPromptPlaceholders(rawPrompt)) {
        return rawPrompt
          .replace('{{OUTREACH_RULES}}', formatTenantContext(tenantContext))
          .replace('{{PROOF_NUMBERS}}', formatTenantProof(tenantContext));
      }
      return prependTenantContext(rawPrompt, tenantContext);
    }
  }

  if (!hasPromptPlaceholders(rawPrompt)) {
    return rawPrompt;
  }

  return resolveLegacyPrompt(agentKey, rawPrompt, getOutreachRulesImpl, getProofNumbersImpl);
}

module.exports = {
  resolveTenantAwarePrompt,
  normalizeTenantChannel,
  roleForAgent,
  _internal: {
    formatTenantContext,
    formatTenantProof,
    hasPromptPlaceholders,
    prependTenantContext,
  },
};
