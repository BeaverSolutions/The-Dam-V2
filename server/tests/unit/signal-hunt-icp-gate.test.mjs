import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const signalHunt = require('../../services/signalHunt.js');

const lockedBeaverIcp = {
  active_industries: [
    'B2B corporate training',
    'marketing agency',
  ],
};

function evaluate(signal) {
  return signalHunt._test.evaluateSignalCompanyIcpGate(signal, lockedBeaverIcp);
}

describe('Signal Hunt locked Beaver ICP gate', () => {
  it.each([
    ['recruitment agency', 'Talent Bridge is a recruitment agency hiring sales consultants in Kuala Lumpur.'],
    ['staffing agency', 'PeopleHire Malaysia is a staffing agency expanding its employer services.'],
  ])('rejects %s evidence', (_label, raw_snippet) => {
    const gate = evaluate({
      company: 'Rejected Company',
      signal_summary: raw_snippet,
      raw_snippet,
      source_channel: 'web_search',
    });

    expect(gate.pass).toBe(false);
    expect(gate.reason).toBe('missing_company_icp_evidence');
  });

  it.each([
    ['lead-gen agency', 'Pipeline Pros is a lead-gen agency hiring SDRs for outbound campaigns.'],
    ['cold-email agency', 'Inbox Scale is a cold-email agency selling outbound lead generation.'],
    ['LinkedIn-outreach agency', 'ConnectLab is a LinkedIn-outreach agency for B2B appointment setting.'],
    ['SDR-as-a-service', 'QuotaPod sells SDR-as-a-service and BDR-as-a-service for startups.'],
    ['AI-sales agency', 'Revenue Bot Lab is an AI-sales agency offering AI outbound systems.'],
    ['demand-gen agency', 'Growth Forge is a demand-gen agency running appointment setting campaigns.'],
  ])('blocks %s through the competitor gate', (_label, raw_snippet) => {
    const gate = evaluate({
      company: 'Competitor Company',
      signal_summary: raw_snippet,
      raw_snippet,
      source_channel: 'web_search',
    });

    expect(gate).toMatchObject({
      pass: false,
      blocker: 'competitor_offer_disqualified',
      reason: 'competitor_offer_matched',
    });
    expect(gate.matched_terms.length).toBeGreaterThan(0);
  });

  it.each([
    ['marketing agency', 'BrandMint is a small marketing agency expanding in Malaysia.'],
    ['creative agency', 'Pixel House is a creative agency hiring a business development lead.'],
    ['digital agency', 'Kingdom Digital is a digital agency growing its sales team.'],
    ['PR agency', 'Mad Hat Asia is a PR agency with new client mandates.'],
    ['communications agency', 'ClearComms is a communications agency appointing a new MD.'],
    ['B2B corporate training provider', 'Acme Learning is a B2B corporate training provider hiring sales roles.'],
    ['L&D provider', 'SkillSpring is an L&D provider for enterprise learning teams.'],
    ['executive coaching firm', 'Boardroom Coach is an executive coaching firm expanding in Kuala Lumpur.'],
  ])('passes %s evidence', (_label, raw_snippet) => {
    const gate = evaluate({
      company: 'Accepted Company',
      signal_summary: raw_snippet,
      raw_snippet,
      source_channel: 'web_search',
    });

    expect(gate.pass).toBe(true);
  });
});
