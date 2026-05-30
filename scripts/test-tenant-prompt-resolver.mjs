#!/usr/bin/env node
/**
 * test-tenant-prompt-resolver.mjs
 *
 * Pure smoke test for tenant-aware prompt placeholder resolution.
 * No DB access, no network calls, no LLM calls.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  resolveTenantAwarePrompt,
  normalizeTenantChannel,
  roleForAgent,
} = require('../server/services/tenantPromptResolver.js');

let passCount = 0;
let failCount = 0;
const failures = [];

function pass(name) {
  passCount++;
  console.log(`  PASS  ${name}`);
}

function fail(name, detail) {
  failCount++;
  failures.push({ name, detail });
  console.log(`  FAIL  ${name}`);
  console.log(`        ${detail}`);
}

function assert(name, condition, detail) {
  if (condition) pass(name);
  else fail(name, detail || 'assertion failed');
}

console.log('\n[1] role and channel mapping');

assert('sales_beaver maps to sales role', roleForAgent('sales_beaver') === 'sales');
assert('ranger maps to enforcer role', roleForAgent('ranger') === 'enforcer');
assert('research_beaver maps to research role', roleForAgent('research_beaver') === 'research');
assert('captain_beaver maps to captain role', roleForAgent('captain_beaver') === 'captain');
assert('linkedin normalizes to linkedin_dm', normalizeTenantChannel('linkedin') === 'linkedin_dm');
assert('email stays email', normalizeTenantChannel('email') === 'email');

console.log('\n[2] placeholder replacement');

const rawPrompt = 'Rules:\n{{OUTREACH_RULES}}\nProof:\n{{PROOF_NUMBERS}}';

{
  let called = false;
  const resolved = await resolveTenantAwarePrompt({
    agentKey: 'sales_beaver',
    rawPrompt,
    clientId: 'client-1',
    channel: 'email',
    createAuthContextImpl: ({ clientId, source }) => ({ clientId, source, branded: true }),
    getTenantContextImpl: async (authCtx, opts) => {
      called = true;
      assert('active profile gets service auth context', authCtx.clientId === 'client-1' && authCtx.source === 'service');
      assert('sales profile requested with email channel', opts.role === 'sales' && opts.channel === 'email');
      return {
        active: true,
        rendered: 'TENANT SALES CONTEXT',
        content_version: 7,
        fields: {
          proof: [
            { claim: 'Approved roof proof', metric: '3-5 booked estimates/week', source: 'TCI', approved_for_outreach: true },
            { claim: 'Unapproved proof', metric: 'hidden', source: 'TCI', approved_for_outreach: false },
          ],
        },
      };
    },
    getOutreachRulesImpl: () => 'LEGACY RULES',
    getProofNumbersImpl: () => 'LEGACY PROOF',
  });

  assert('active profile lookup was called', called);
  assert('active profile replaces outreach rules', resolved.includes('TENANT SALES CONTEXT') && !resolved.includes('LEGACY RULES'));
  assert('active profile includes approved proof only', resolved.includes('Approved roof proof') && !resolved.includes('Unapproved proof'));
}

{
  const resolved = await resolveTenantAwarePrompt({
    agentKey: 'sales_beaver',
    rawPrompt,
    clientId: 'client-1',
    channel: 'email',
    createAuthContextImpl: ({ clientId, source }) => ({ clientId, source, branded: true }),
    getTenantContextImpl: async () => ({ active: false, reason: 'draft_only' }),
    getOutreachRulesImpl: () => 'LEGACY RULES',
    getProofNumbersImpl: () => 'LEGACY PROOF',
  });

  assert('inactive profile falls back to legacy rules', resolved.includes('LEGACY RULES'));
  assert('inactive profile falls back to legacy proof', resolved.includes('LEGACY PROOF'));
}

{
  const resolved = await resolveTenantAwarePrompt({
    agentKey: 'ranger',
    rawPrompt,
    clientId: 'client-1',
    channel: 'linkedin',
    createAuthContextImpl: ({ clientId, source }) => ({ clientId, source, branded: true }),
    getTenantContextImpl: async (authCtx, opts) => {
      assert('ranger requests enforcer linkedin_dm projection', opts.role === 'enforcer' && opts.channel === 'linkedin_dm');
      return {
        active: true,
        rendered: 'TENANT ENFORCER CONTEXT',
        content_version: 3,
        fields: { proof: [] },
      };
    },
    getOutreachRulesImpl: () => 'LEGACY RULES',
    getProofNumbersImpl: () => 'LEGACY PROOF',
  });

  assert('ranger uses tenant enforcer context', resolved.includes('TENANT ENFORCER CONTEXT') && !resolved.includes('LEGACY RULES'));
}

{
  const noPlaceholder = 'No placeholders here.';
  const resolved = await resolveTenantAwarePrompt({
    agentKey: 'sales_beaver',
    rawPrompt: noPlaceholder,
    clientId: 'client-1',
    channel: 'email',
    getTenantContextImpl: async () => {
      throw new Error('should not be called');
    },
  });

  assert('prompt without placeholders returns unchanged', resolved === noPlaceholder);
}

console.log('\n────────────────────────────────────────');
console.log(`PASS: ${passCount}   FAIL: ${failCount}`);
if (failCount > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
}

console.log('All tenant prompt resolver tests passed.');
process.exit(0);
