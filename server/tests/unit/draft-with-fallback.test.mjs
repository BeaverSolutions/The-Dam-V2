import { createRequire } from 'module';
import { vi, describe, it, expect } from 'vitest';
const require = createRequire(import.meta.url);

// pool is imported by pipeline.js at module level but draftWithFallback
// does not call it — mock it to prevent any accidental connection
vi.mock('../../db/pool', () => ({ query: vi.fn() }));
// pipelineTrace.traceStage is .catch(()=>{})-wrapped — mock to no-op
vi.mock('../../services/pipelineTrace', () => ({ traceStage: vi.fn().mockResolvedValue(undefined) }));
// logs service may be required transitively
vi.mock('../../services/logs', () => ({ createLog: vi.fn().mockResolvedValue(undefined) }));

const { draftWithFallback } = require('../../services/pipeline');

const CLIENT_ID = 'ce2fc8e5-0000-0000-0000-000000000000';
const LEAD_ID = 'lead-0000-0000-0000-000000000001';

const baseLead = {
  name: 'Ahmad Razak',
  company: 'Tin City Impact',
  title: 'CEO',
};

const baseParams = {
  lead_id: LEAD_ID,
  channel: 'email',
  context: 'Name: Ahmad Razak\nCompany: Tin City Impact',
  pipeline_path: 'test_path',
};

describe('draftWithFallback', () => {
  it('returns Sales result when salesGenerate returns a body', async () => {
    const salesGenerate = vi.fn().mockResolvedValue({ body: 'Hi Ahmad,\n\nShort message.\n\nMJ', subject: 'Quick question', prompt_variant: 'signal_rich_v2' });
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate });
    expect(result).not.toBeNull();
    expect(result.body).toBe('Hi Ahmad,\n\nShort message.\n\nMJ');
    expect(result.draftSource).toBe('sales_beaver');
    expect(result.prompt_variant).toBe('signal_rich_v2');
  });

  it('returns null (no fallback) when salesGenerate returns null and enableEnforcerFallback=false', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, enableEnforcerFallback: false });
    expect(result).toBeNull();
  });

  it('falls through to Enforcer draft when salesGenerate returns null and enableEnforcerFallback=true', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    const rangerDraft = vi.fn().mockResolvedValue({ body: 'Enforcer-drafted body.', subject: 'Enforcer subject' });
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, rangerDraft, enableEnforcerFallback: true, lead: baseLead });
    expect(result).not.toBeNull();
    expect(result.draftSource).toBe('enforcer_fallback');
    expect(result.body).toBe('Enforcer-drafted body.');
    expect(result.prompt_variant).toBeNull();
  });

  it('returns null when both Sales and Enforcer return no body', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    const rangerDraft = vi.fn().mockResolvedValue({ body: '' });
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, rangerDraft, enableEnforcerFallback: true, lead: baseLead });
    expect(result).toBeNull();
  });

  it('throws when salesGenerate is missing', async () => {
    await expect(draftWithFallback(CLIENT_ID, { ...baseParams })).rejects.toThrow('salesGenerate is required');
  });

  it('throws when rangerDraft is missing and enableEnforcerFallback=true', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    await expect(
      draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, enableEnforcerFallback: true, lead: baseLead })
    ).rejects.toThrow('rangerDraft is required');
  });

  it('throws when lead is missing and enableEnforcerFallback=true', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    const rangerDraft = vi.fn();
    await expect(
      draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, rangerDraft, enableEnforcerFallback: true })
    ).rejects.toThrow('lead is required');
  });

  it('uses defaultDraftSource param for the returned draftSource label', async () => {
    const salesGenerate = vi.fn().mockResolvedValue({ body: 'Hi Ahmad,\n\nBody.', subject: null });
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, defaultDraftSource: 'signal_hunt' });
    expect(result.draftSource).toBe('signal_hunt');
  });
});
