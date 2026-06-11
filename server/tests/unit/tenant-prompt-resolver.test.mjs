import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const resolver = require('../../services/tenantPromptResolver');

describe('tenantPromptResolver', () => {
  it('prepends active tenant context for Research prompts without placeholders', async () => {
    const prompt = await resolver.resolveTenantAwarePrompt({
      agentKey: 'research_beaver',
      rawPrompt: 'Base prompt says corporate training is the default ICP.',
      clientId: 'tin-city',
      createAuthContextImpl: ({ clientId, source }) => ({ clientId, source, __brand: true }),
      getTenantContextImpl: vi.fn().mockResolvedValue({
        active: true,
        content_version: 3,
        rendered: 'ICP: roofing contractors in United States and Canada.',
        fields: {},
      }),
    });

    expect(prompt).toContain('TENANT PROFILE CONTEXT (active content_version=3)');
    expect(prompt).toContain('ICP: roofing contractors in United States and Canada.');
    expect(prompt).toContain('This tenant profile is authoritative');
    expect(prompt).toContain('Base prompt says corporate training is the default ICP.');
  });

  it('keeps placeholder replacement behavior for Sales and Enforcer prompts', async () => {
    const prompt = await resolver.resolveTenantAwarePrompt({
      agentKey: 'sales_beaver',
      rawPrompt: 'Rules:\n{{OUTREACH_RULES}}\nProof:\n{{PROOF_NUMBERS}}',
      clientId: 'client-1',
      createAuthContextImpl: ({ clientId, source }) => ({ clientId, source, __brand: true }),
      getTenantContextImpl: vi.fn().mockResolvedValue({
        active: true,
        content_version: 7,
        rendered: 'Tenant voice and ICP.',
        fields: { proof: [{ claim: 'Booked estimates', metric: '3-5/week', source: 'case study', approved_for_outreach: true }] },
      }),
    });

    expect(prompt).toContain('Tenant voice and ICP.');
    expect(prompt).toContain('Booked estimates | 3-5/week | source: case study');
    expect(prompt).not.toContain('{{OUTREACH_RULES}}');
    expect(prompt).not.toContain('{{PROOF_NUMBERS}}');
  });
});
