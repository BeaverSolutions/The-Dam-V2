import { createRequire } from 'module';
import { vi, describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);

vi.mock('../../db/pool', () => ({ query: vi.fn() }));
vi.mock('../../services/logs', () => ({ createLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/pipelineTrace', () => ({ traceStage: vi.fn().mockResolvedValue(undefined) }));

const agents = require('../../services/agents.js');
const pipelineTrace = require('../../services/pipelineTrace.js');

const strongSignalPackage = {
  signal_id: 'hiring_sales_roles',
  signal_family: 'hiring_capability_build',
  source_channel: 'linkedin_jobs',
  source_url: 'https://www.linkedin.com/jobs/view/123',
  evidence: 'Acme Training is hiring a Business Development Manager in Kuala Lumpur',
  evidence_date: '2026-06-03',
  why_now: 'Acme Training is adding sales capacity now',
  company_icp_fit: { lead_class: 'icp_match', vertical_match: 'B2B services' },
  decision_maker: {
    name: 'Jane Tan',
    title: 'Founder',
    source_url: 'https://www.linkedin.com/in/janetan',
  },
};

const leadContext = {
  lead_id: 'lead-123',
  name: 'Jane Tan',
  company: 'Acme Training',
  title: 'Founder',
  email: 'jane@acmetraining.com',
  email_verified: true,
  email_source: 'hunter',
  channel: 'email',
  signal_package: strongSignalPackage,
};

describe('Enforcer evidence gate and repair router', () => {
  it('rejects unsupported signal claims with unsupported_signal', () => {
    const result = agents._test.enforcerEvidenceGate({
      message_body: 'Hi Jane, congrats on the Series A funding. Is outbound keeping up with the new growth target?',
      lead_context: leadContext,
    });

    expect(result).toMatchObject({
      decision: 'reject',
      approved: false,
      evidence_decision: 'unsupported_signal',
      repair_route: 'needs_research_repair',
      failed_rule: 'unsupported_signal',
    });
  });

  it('rejects generic messages that do not use the signal', () => {
    const result = agents._test.enforcerEvidenceGate({
      message_body: 'Hi Jane, saw your company is doing great. How are you handling outbound right now?',
      lead_context: leadContext,
    });

    expect(result).toMatchObject({
      decision: 'reject',
      approved: false,
      evidence_decision: 'generic_message',
      repair_route: 'needs_sales_redraft',
      failed_rule: 'generic_message',
    });
  });

  it('routes strong evidence but weak copy to Sales for redraft', () => {
    const result = agents._test.enforcerEvidenceGate({
      message_body: 'Hi Jane, saw Acme is hiring. We help companies grow outbound. Worth a chat?',
      lead_context: leadContext,
    });

    expect(result).toMatchObject({
      decision: 'reject',
      approved: false,
      repair_route: 'needs_sales_redraft',
    });
    expect(['generic_message', 'weak_copy']).toContain(result.failed_rule);
  });

  it('routes weak evidence packages back to Research', () => {
    const result = agents._test.enforcerEvidenceGate({
      message_body: 'Hi Jane, saw Acme is hiring a BDR. Is outbound capacity becoming a weekly problem?',
      lead_context: {
        ...leadContext,
        signal_package: {
          ...strongSignalPackage,
          source_url: '',
          evidence: '',
        },
      },
    });

    expect(result).toMatchObject({
      decision: 'reject',
      approved: false,
      evidence_decision: 'needs_research_repair',
      repair_route: 'needs_research_repair',
    });
    expect(result.required_repair).toContain('Research');
  });

  it('routes competitor-offer prospects to competitor_offer_disqualified', () => {
    const result = agents._test.enforcerEvidenceGate({
      message_body: 'Hi Jane, saw Acme is hiring a BDR. Is outbound capacity becoming a weekly problem?',
      lead_context: {
        ...leadContext,
        signal_package: {
          ...strongSignalPackage,
          company_icp_fit: { lead_class: 'competitor_offer' },
        },
      },
    });

    expect(result).toMatchObject({
      decision: 'reject',
      approved: false,
      evidence_decision: 'competitor_offer_disqualified',
      repair_route: 'competitor_offer_disqualified',
      failed_rule: 'competitor_offer_disqualified',
    });
  });

  it('approves evidence-anchored copy with structured repair fields set to null', () => {
    const result = agents._test.enforcerEvidenceGate({
      message_body: 'Hi Jane, saw Acme is hiring a Business Development Manager in Kuala Lumpur. That usually means pipeline work is moving from founder-led to team-led. Is outbound capacity becoming a weekly problem?',
      lead_context: leadContext,
    });

    expect(result).toMatchObject({
      decision: 'approve',
      approved: true,
      score: 85,
      evidence_decision: 'evidence_ok',
      repair_route: null,
      failed_rule: null,
      required_repair: null,
    });
  });

  it('allows repair_routed as a pipeline trace stage', () => {
    expect(pipelineTrace.STAGE_VOCABULARY.has('repair_routed')).toBe(true);
  });
});
