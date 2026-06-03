import { createRequire } from 'module';
import { vi, describe, it, expect } from 'vitest';
const require = createRequire(import.meta.url);

// pool is imported by pipeline.js at module level but draftWithFallback
// does not call it — mock it to prevent any accidental connection
vi.mock('../../db/pool', () => ({ query: vi.fn() }));
// pipelineTrace.traceStage is .catch(()=>{})-wrapped — mock to no-op
vi.mock('../../services/pipelineTrace', () => ({ traceStage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/pipelineTrace.js', () => ({ traceStage: vi.fn().mockResolvedValue(undefined) }));
// logs service may be required transitively
vi.mock('../../services/logs', () => ({ createLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/logs.js', () => ({ createLog: vi.fn().mockResolvedValue(undefined) }));

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

  it('falls through to Captain draft when salesGenerate returns null and fallback is enabled', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    const rangerDraft = vi.fn().mockResolvedValue({ body: 'Should not be used.', subject: 'Enforcer subject' });
    const captainDraft = vi.fn().mockResolvedValue({ body: 'Captain manual-review body.', subject: 'Captain subject' });
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, rangerDraft, captainDraft, enableEnforcerFallback: true, lead: baseLead });
    expect(result).not.toBeNull();
    expect(result.draftSource).toBe('captain_fallback');
    expect(result.body).toBe('Captain manual-review body.');
    expect(result.prompt_variant).toBe('captain_fallback');
    expect(result.manualReview).toBe(true);
    expect(rangerDraft).not.toHaveBeenCalled();
  });

  it('does not fall through to writer fallback when Sales routes thin evidence to Research', async () => {
    const salesGenerate = vi.fn().mockResolvedValue({
      status: 'needs_more_research',
      repair_route: 'needs_research_repair',
      missing_fields: ['source_url'],
    });
    const rangerDraft = vi.fn().mockResolvedValue({ body: 'Should not be used.' });
    const recordRepairRoute = vi.fn().mockResolvedValue({ recorded: true });

    const result = await draftWithFallback(CLIENT_ID, {
      ...baseParams,
      kickoff_id: 'plan-0000-0000-0000-000000000001',
      salesGenerate,
      rangerDraft,
      enableEnforcerFallback: true,
      lead: baseLead,
      recordRepairRoute,
      inlineResearchRepair: false,
    });

    expect(result).toBeNull();
    expect(rangerDraft).not.toHaveBeenCalled();
    expect(recordRepairRoute).toHaveBeenCalledWith(CLIENT_ID, expect.objectContaining({
      lead_id: LEAD_ID,
      kickoff_id: 'plan-0000-0000-0000-000000000001',
      repair_route: 'needs_research_repair',
      failed_rule: 'needs_more_research',
    }));
  });

  it('runs bounded inline Research repair and retries Sales once when Sales routes thin evidence to Research', async () => {
    const salesGenerate = vi.fn()
      .mockResolvedValueOnce({
        status: 'needs_more_research',
        repair_route: 'needs_research_repair',
        missing_fields: ['source_url'],
        required_repair: 'Find a source URL for the timing signal.',
        signal_package: { signal_id: 'hiring_sales_roles', evidence: ['Hiring BDR'] },
      })
      .mockResolvedValueOnce({
        body: 'Hi Ahmad,\n\nSaw the BDR hiring push. Is outbound execution the current bottleneck?\n\nRegards,\nMichael',
        subject: 'BDR hiring',
        prompt_variant: 'signal_rich_v2',
      });
    const rangerDraft = vi.fn().mockResolvedValue({ body: 'Should not be used.' });
    const recordRepairRoute = vi.fn().mockResolvedValue({ recorded: true, directive_written: false });
    const repairSignalPackage = vi.fn().mockResolvedValue({
      repaired: true,
      signal_package: { signal_id: 'hiring_sales_roles', source_url: 'https://example.com/job', evidence: ['Hiring BDR'] },
    });
    const reloadLead = vi.fn().mockResolvedValue({
      ...baseLead,
      id: LEAD_ID,
      metadata: {
        signal_package: { signal_id: 'hiring_sales_roles', source_url: 'https://example.com/job', evidence: ['Hiring BDR'] },
        research_repair: { attempt: 1, max_attempts: 1, status: 'repaired' },
      },
    });

    const result = await draftWithFallback(CLIENT_ID, {
      ...baseParams,
      kickoff_id: 'plan-0000-0000-0000-000000000001',
      salesGenerate,
      rangerDraft,
      enableEnforcerFallback: true,
      lead: { ...baseLead, id: LEAD_ID },
      recordRepairRoute,
      repairSignalPackage,
      reloadLead,
    });

    expect(result).toMatchObject({
      body: 'Hi Ahmad,\n\nSaw the BDR hiring push. Is outbound execution the current bottleneck?\n\nRegards,\nMichael',
      subject: 'BDR hiring',
      draftSource: 'sales_beaver',
      prompt_variant: 'signal_rich_v2',
      signal_package: { signal_id: 'hiring_sales_roles', source_url: 'https://example.com/job', evidence: ['Hiring BDR'] },
      research_repair: { attempt: 1, max_attempts: 1, status: 'repaired' },
    });
    expect(result.lead?.metadata?.signal_package?.source_url).toBe('https://example.com/job');
    expect(salesGenerate).toHaveBeenCalledTimes(2);
    expect(repairSignalPackage).toHaveBeenCalledWith(CLIENT_ID, expect.objectContaining({
      lead_id: LEAD_ID,
      repair_route: 'needs_research_repair',
      repair_attempt: 1,
      max_repair_attempts: 1,
    }));
    expect(reloadLead).toHaveBeenCalledWith(CLIENT_ID, LEAD_ID);
    expect(rangerDraft).not.toHaveBeenCalled();
    expect(recordRepairRoute).toHaveBeenCalledWith(CLIENT_ID, expect.objectContaining({
      lead_id: LEAD_ID,
      write_directive: false,
    }));
  });

  it('uses Captain fallback when Sales still needs Research after the bounded repair attempt', async () => {
    const salesGenerate = vi.fn().mockResolvedValue({
      status: 'needs_more_research',
      repair_route: 'needs_research_repair',
      missing_fields: ['source_url'],
      repair_attempt: 1,
      max_repair_attempts: 1,
      signal_package: { signal_id: 'hiring_sales_roles', evidence: ['Hiring BDR'] },
    });
    const rangerDraft = vi.fn().mockResolvedValue({ body: 'Should not be used.' });
    const captainDraft = vi.fn().mockResolvedValue({ body: 'Captain manual-review draft.', subject: 'Captain subject' });
    const recordRepairRoute = vi.fn().mockResolvedValue({ recorded: true, repair_exhausted: true });

    const result = await draftWithFallback(CLIENT_ID, {
      ...baseParams,
      salesGenerate,
      rangerDraft,
      captainDraft,
      enableEnforcerFallback: true,
      lead: baseLead,
      recordRepairRoute,
      inlineResearchRepair: false,
    });

    expect(result).toMatchObject({
      body: 'Captain manual-review draft.',
      subject: 'Captain subject',
      draftSource: 'captain_fallback',
      prompt_variant: 'captain_fallback',
      manualReview: true,
    });
    expect(rangerDraft).not.toHaveBeenCalled();
    expect(captainDraft).toHaveBeenCalledWith(CLIENT_ID, expect.objectContaining({
      lead: baseLead,
      lead_id: LEAD_ID,
      missing_fields: ['source_url'],
    }));
  });

  it('returns null when both Sales and Captain return no body', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    const rangerDraft = vi.fn().mockResolvedValue({ body: '' });
    const captainDraft = vi.fn().mockResolvedValue({ body: '' });
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, rangerDraft, captainDraft, enableEnforcerFallback: true, lead: baseLead });
    expect(result).toBeNull();
    expect(rangerDraft).not.toHaveBeenCalled();
  });

  it('throws when salesGenerate is missing', async () => {
    await expect(draftWithFallback(CLIENT_ID, { ...baseParams })).rejects.toThrow('salesGenerate is required');
  });

  it('throws when captainDraft is missing and fallback is enabled', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    await expect(
      draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, enableEnforcerFallback: true, lead: baseLead })
    ).rejects.toThrow('captainDraft is required');
  });

  it('throws when lead is missing and enableEnforcerFallback=true', async () => {
    const salesGenerate = vi.fn().mockResolvedValue(null);
    const rangerDraft = vi.fn();
    const captainDraft = vi.fn();
    await expect(
      draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, rangerDraft, captainDraft, enableEnforcerFallback: true })
    ).rejects.toThrow('lead is required');
  });

  it('uses defaultDraftSource param for the returned draftSource label', async () => {
    const salesGenerate = vi.fn().mockResolvedValue({ body: 'Hi Ahmad,\n\nBody.', subject: null });
    const result = await draftWithFallback(CLIENT_ID, { ...baseParams, salesGenerate, defaultDraftSource: 'signal_hunt' });
    expect(result.draftSource).toBe('signal_hunt');
  });
});
