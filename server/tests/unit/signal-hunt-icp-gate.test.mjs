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
    ['missing ICP object', {}],
    ['empty active industries', { active_industries: [] }],
    ['legacy industries without active industries', { industries: ['B2B corporate training'], active_industries: null }],
  ])('fails closed when %s cannot prove active tenant verticals', (_label, icp) => {
    const gate = signalHunt._test.evaluateSignalCompanyIcpGate({
      company: 'Resume Box',
      signal_summary: 'Resume Box is hiring sales roles in Kuala Lumpur.',
      raw_snippet: 'Sales Executive | Resume Box | LinkedIn Jobs',
      source_channel: 'linkedin_jobs',
    }, icp);

    expect(gate).toMatchObject({
      pass: false,
      blocker: 'icp_no_active_verticals_configured',
      reason: 'tenant_active_industries_not_set',
      reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
    });
  });

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

  // Regression for the 2026-06-09 vertical-first proof: confirmed in-ICP
  // verticals that merely MENTION cold email / lead gen (course topics or
  // client outcomes) must NOT be killed by the competitor gate. Topic wording
  // only disqualifies when no in-ICP vertical is proven.
  it.each([
    ['training provider teaching cold email', 'Thriving Talents is a corporate training provider in Malaysia. Our courses cover cold email outreach, sales coaching and negotiation skills.'],
    ['training provider with lead-gen course', 'MMT is an in-house corporate training company offering workshops on lead generation and B2B selling.'],
    ['marketing agency that ran a lead-gen campaign', 'BrandMint is a creative marketing agency that helped a client with a lead generation campaign last year.'],
  ])('passes %s (topic mention, vertical confirmed)', (_label, raw_snippet) => {
    const gate = evaluate({
      company: 'Vertical Company',
      signal_summary: raw_snippet,
      raw_snippet,
      source_channel: 'vertical_directory',
    });

    expect(gate.pass).toBe(true);
    expect(gate.vertical_match).toBeTruthy();
  });

  it.each([
    ['bare lead-gen page, no vertical', 'GrowthScale helps you book more meetings with lead generation and cold email systems.'],
    ['bare cold-outreach page, no vertical', 'We run cold outreach and demand generation to fill your pipeline.'],
  ])('still blocks %s through the topic gate when no vertical is proven', (_label, raw_snippet) => {
    const gate = evaluate({
      company: 'Ambiguous Company',
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
});
