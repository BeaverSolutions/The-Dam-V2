import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const research = require('../../services/research.js');
const researchSource = readFileSync(resolve(__dirname, '../../services/research.js'), 'utf-8');

const EXPECTED_COUNTERS = {
  raw_results_total: 0,
  raw_candidates_total: 0,
  companies_extracted: 0,
  icp_passed: 0,
  decision_makers_found: 0,
  contacts_found: 0,
  saved: 0,
};

describe('Research Beaver raw candidate stage gates', () => {
  it('exposes the exact Phase 3 blocker taxonomy', () => {
    expect(research._test.RESEARCH_BLOCKERS).toEqual(expect.arrayContaining([
      'raw_candidates_zero',
      'icp_zero_after_company_extract',
      'decision_maker_zero',
      'contact_zero',
      'all_candidates_deduped',
      'competitor_offer_disqualified',
      'provider_cap_closed',
    ]));
  });

  it('initializes every raw-candidate stage counter with zero', () => {
    expect(research._test.initResearchStageStats()).toEqual(EXPECTED_COUNTERS);
  });

  it('builds a zero-raw-candidate blocker result that skips verification rounds', () => {
    const result = research._test.buildResearchBlockerResult({
      blocker: 'raw_candidates_zero',
      queriesUsed: ['site:linkedin.com/company "sales hiring" Malaysia'],
      stageStats: research._test.initResearchStageStats(),
      diagnostics: { source: 'test' },
    });

    expect(result.leads).toEqual([]);
    expect(result.diagnostics.reason).toBe('raw_candidates_zero');
    expect(result.verification_stats.rounds_ran).toBe(0);
    expect(result.verification_stats.circuit_breaker_tripped).toBe('raw_candidates_zero');
    expect(result.stage_stats).toEqual(EXPECTED_COUNTERS);
  });

  it('keeps the raw-candidate blocker branch before verifyBatch fanout', () => {
    const preFilterIdx = researchSource.indexOf('const preFiltered = deduped.filter');
    const rawBlockerIdx = researchSource.indexOf("raw_candidates_zero", preFilterIdx);
    const initialVerifyIdx = researchSource.indexOf('await verifyBatch(preFiltered', preFilterIdx);

    expect(preFilterIdx).toBeGreaterThan(-1);
    expect(rawBlockerIdx).toBeGreaterThan(preFilterIdx);
    expect(initialVerifyIdx).toBeGreaterThan(rawBlockerIdx);
  });

  it('attaches a complete signal package before leads are returned for saving', () => {
    const packaged = research._test.attachSignalPackageToLead({
      name: 'Jane Tan',
      title: 'Founder',
      company: 'Acme Training',
      email: 'jane@acmetraining.com',
      email_verified: true,
      linkedin_url: 'https://www.linkedin.com/in/janetan',
      why_now: 'Acme Training is hiring sales roles in Kuala Lumpur',
      signal: 'hiring_sales_roles',
      metadata: {
        signal_id: 'hiring_sales_roles',
        signal_family: 'hiring_capability_build',
        source_channel: 'linkedin_jobs',
        source_url: 'https://www.linkedin.com/jobs/view/123',
        evidence: 'Hiring Business Development Manager in Kuala Lumpur',
        company_icp_fit: { vertical_match: 'B2B services', geo_match: 'MY' },
      },
    }, { evidenceDate: '2026-06-03' });

    expect(packaged.metadata.signal_package).toMatchObject({
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'linkedin_jobs',
      source_url: 'https://www.linkedin.com/jobs/view/123',
      evidence: 'Hiring Business Development Manager in Kuala Lumpur',
      evidence_date: '2026-06-03',
      company_icp_fit: { vertical_match: 'B2B services', geo_match: 'MY' },
      decision_maker: {
        name: 'Jane Tan',
        title: 'Founder',
        source_url: 'https://www.linkedin.com/in/janetan',
      },
      contact: {
        email: 'jane@acmetraining.com',
        email_verified: true,
        linkedin_url: 'https://www.linkedin.com/in/janetan',
      },
      why_now: 'Acme Training is hiring sales roles in Kuala Lumpur',
    });
    expect(packaged.metadata.signal_package.sales_angle).toContain('hiring_sales_roles');
  });
});
