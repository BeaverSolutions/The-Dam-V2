import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const inboundPitch = require('../../services/inboundPitchProspecting.js');

const receivedAt = '2026-06-12T10:15:00.000Z';
const pitchBody = [
  'I help B2B training providers book more meetings with targeted outbound.',
  'We can run cold email and LinkedIn campaigns for your team.',
  'Would you be open to a quick call next week?',
].join('\n');

describe('inboundPitchProspecting pure contracts', () => {
  it('extracts a company sender domain and rejects freemail domains', () => {
    expect(inboundPitch.senderDomainFromHeader('Samantha Lee <samantha@growthpilot.my>')).toBe('growthpilot.my');
    expect(inboundPitch.isFreemailDomain('gmail.com')).toBe(true);
    expect(inboundPitch.isFreemailDomain('growthpilot.my')).toBe(false);
  });

  it('builds an inbound_pitch lead with one-line evidence and no full body storage', () => {
    const result = inboundPitch.buildInboundPitchLeadCandidate({
      from: 'Samantha Lee <samantha@growthpilot.my>',
      subject: 'Helping training firms book more meetings',
      body: pitchBody,
      channel: 'email',
      receivedAt,
      companyIdentity: {
        company: 'GrowthPilot',
        website: 'https://growthpilot.my',
        resolved: true,
        page_text: 'GrowthPilot is a B2B corporate training provider helping Malaysian companies improve sales capability.',
      },
      icpGate: {
        pass: true,
        vertical_match: 'B2B corporate training',
        icp_evidence: ['B2B corporate training'],
      },
    });

    expect(result.action).toBe('create_lead');
    expect(result.lead.source).toBe('inbound_pitch');
    expect(result.lead.email_verified).toBe(true);
    expect(result.lead.email_source).toBe('inbound_pitch');
    expect(result.lead.metadata.signal_package.why_now).toBe('actively running manual cold outbound - pitched us on 2026-06-12');
    expect(result.lead.metadata.signal_package.evidence).toContain('Pitch received via email on 2026-06-12');
    expect(result.lead.metadata.signal_package.evidence).not.toContain('We can run cold email and LinkedIn campaigns');
    expect(result.lead.metadata.signal_package.sender_domain).toBe('growthpilot.my');
  });

  it('parks competitor-offer vendor pitches instead of creating draftable leads', () => {
    const result = inboundPitch.buildInboundPitchLeadCandidate({
      from: 'Alex Tan <alex@outboundsystems.my>',
      subject: 'Cold email engine for you',
      body: 'We sell AI outbound and cold email automation for founders.',
      channel: 'email',
      receivedAt,
      companyIdentity: {
        company: 'Outbound Systems',
        website: 'https://outboundsystems.my',
        resolved: true,
        page_text: 'Outbound Systems sells AI outbound and cold email automation.',
      },
      icpGate: {
        pass: false,
        blocker: 'competitor_offer_disqualified',
        reason: 'competitor_offer_matched',
        matched_terms: ['cold email automation'],
      },
    });

    expect(result.action).toBe('park_competitor');
    expect(result.lead.status).toBe('rejected_persona');
    expect(result.lead.pipeline_stage).toBe('rejected');
    expect(result.lead.metadata.lead_class).toBe('competitor_offer');
  });

  it('rejects freemail senders before company/ICP work', () => {
    const result = inboundPitch.buildInboundPitchLeadCandidate({
      from: 'Pitcher <pitcher@gmail.com>',
      subject: 'Lead generation help',
      body: pitchBody,
      channel: 'email',
      receivedAt,
      companyIdentity: { company: 'Unknown', website: '', resolved: false },
      icpGate: { pass: true },
    });

    expect(result.action).toBe('skip');
    expect(result.reason).toBe('freemail_sender');
  });

  it('detects banned references to the sender pitch', () => {
    expect(inboundPitch.containsInboundPitchReference('Saw your email about lead generation.')).toBe(true);
    expect(inboundPitch.containsInboundPitchReference('Thanks for reaching out last week.')).toBe(true);
    expect(inboundPitch.containsInboundPitchReference('Noticed you are running outbound for clients.')).toBe(false);
  });
});

describe('captureVendorColdPitch', () => {
  it('dedupes same-domain inbound pitches before inserting a lead', async () => {
    const db = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'existing-lead' }] }),
    };
    const logs = { createLog: vi.fn().mockResolvedValue(undefined) };

    const result = await inboundPitch.captureVendorColdPitch('client-1', {
      inboundFrom: 'Samantha Lee <samantha@growthpilot.my>',
      inboundSubject: 'Helping training firms book more meetings',
      snippet: pitchBody,
      provider: 'gmail',
      messageId: 'msg-1',
      receivedAt,
    }, {
      pool: db,
      logsService: logs,
      resolveCompanyIdentity: vi.fn(),
      loadIcpForSignalHunt: vi.fn(),
      evaluateSignalCompanyIcpGate: vi.fn(),
      targetClientId: 'client-1',
    });

    expect(result).toMatchObject({ action: 'skip', reason: 'duplicate_domain', lead_id: 'existing-lead' });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(db.query.mock.calls)).not.toContain('INSERT INTO leads');
  });

  it('is Beaver-only by default and skips external tenant inbox spam', async () => {
    const db = { query: vi.fn() };
    const result = await inboundPitch.captureVendorColdPitch('external-client', {
      inboundFrom: 'Samantha Lee <samantha@growthpilot.my>',
      inboundSubject: 'Helping training firms book more meetings',
      snippet: pitchBody,
      provider: 'gmail',
      messageId: 'msg-1',
      receivedAt,
    }, { pool: db });

    expect(result.reason).toBe('non_beaver_client');
    expect(db.query).not.toHaveBeenCalled();
  });
});
