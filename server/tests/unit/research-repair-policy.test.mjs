import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const repairPolicy = require('../../services/repairPolicy');

describe('Research repair loop policy', () => {
  it('hashes signal packages deterministically regardless of key order', () => {
    const first = repairPolicy.signalPackageHash({
      source_url: 'https://example.com/jobs',
      evidence: ['Hiring BDR'],
      why_now: 'BDR hiring indicates outbound capacity build',
    });
    const second = repairPolicy.signalPackageHash({
      why_now: 'BDR hiring indicates outbound capacity build',
      evidence: ['Hiring BDR'],
      source_url: 'https://example.com/jobs',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
  });

  it('builds a one-shot repair payload with no-repeat memory', () => {
    const payload = repairPolicy.buildResearchRepairPayload({
      leadId: 'lead-1',
      messageId: 'message-1',
      kickoffId: 'plan-1',
      channel: 'email',
      pipelinePath: 'signal_pipeline',
      failedRule: 'thin_evidence',
      reason: 'needs_research_repair:source_url',
      missingFields: ['source_url'],
      requiredRepair: 'Provide source_url',
      repairAttempt: 0,
      maxRepairAttempts: 1,
      signalPackage: {
        signal_id: 'hiring_sales_roles',
        source_url: '',
        evidence: ['Hiring BDR'],
        why_now: 'Outbound capacity build',
      },
    });

    expect(payload).toMatchObject({
      lead_id: 'lead-1',
      message_id: 'message-1',
      kickoff_id: 'plan-1',
      channel: 'email',
      pipeline_path: 'signal_pipeline',
      repair_route: 'needs_research_repair',
      failed_rule: 'thin_evidence',
      missing_fields: ['source_url'],
      required_repair: 'Provide source_url',
      repair_attempt: 1,
      max_repair_attempts: 1,
    });
    expect(payload.original_signal_package_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(payload.do_not_repeat.signal_package_hash).toBe(payload.original_signal_package_hash);
  });

  it('marks the research loop exhausted after the bounded repair attempt', () => {
    expect(repairPolicy.researchRepairExhausted({ repairAttempt: 0, maxRepairAttempts: 1 })).toBe(false);
    expect(repairPolicy.researchRepairExhausted({ repairAttempt: 1, maxRepairAttempts: 1 })).toBe(true);
  });
});
