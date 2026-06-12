import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const agents = require('../../services/agents');

describe('Signal Hunt cached-lead readiness contract', () => {
  it('rejects blog-source cached leads without direct company website proof before Sales Beaver', () => {
    expect(typeof agents._test.currentSignalPackageReadiness).toBe('function');

    const result = agents._test.currentSignalPackageReadiness({
      source: 'signal_hunt',
      name: 'Chris Orlob',
      company: 'Caliber (formerly pclub.io)',
      email: 'chris@caliber.io',
      email_verified: true,
      linkedin_url: 'https://www.linkedin.com/in/chrisorlob',
      metadata: {
        platform: 'job_boards',
        source_channel: 'job_boards',
        source_url: 'https://www.caliber.io/blog/sales-leadership-training',
        signal_package: {
          platform: 'job_boards',
          source_channel: 'job_boards',
          source_url: 'https://www.caliber.io/blog/sales-leadership-training',
          company_icp_fit: {
            vertical_match: 'B2B corporate training',
            reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
          },
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'directory_or_aggregator_company',
      missing: ['company_website'],
    });
  });
});
