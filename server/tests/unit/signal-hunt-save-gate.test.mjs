import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const research = require('../../services/research.js');
const signalHunt = require('../../services/signalHunt.js');
const signalHuntSource = readFileSync(resolve(__dirname, '../../services/signalHunt.js'), 'utf-8');

function resumeBoxLead() {
  return {
    name: 'Lee Biggins',
    title: 'Founder',
    company: 'Resume Box',
    linkedin_url: 'https://www.linkedin.com/in/lee-biggins',
    quality_score: 95,
    metadata: {
      signal_package: {
        signal_id: 'hiring_sales_roles',
        signal_family: 'hiring_capability_build',
        source_channel: 'linkedin_jobs',
        source_url: 'https://www.linkedin.com/jobs/resume-box-sales',
        evidence: ['Sales Executive | Resume Box | LinkedIn Jobs'],
        company_icp_fit: {
          vertical_match: null,
          icp_evidence: [],
          reject_rules_checked: ['tenant_exclusions', 'competitor_offers'],
        },
        decision_maker: { name: 'Lee Biggins', title: 'Founder' },
        contact: { linkedin_url: 'https://www.linkedin.com/in/lee-biggins' },
        why_now: 'Hiring sales roles.',
        sales_angle: 'Sales hiring signal.',
      },
    },
  };
}

describe('Signal Hunt save gate', () => {
  it('treats present-but-empty company ICP fit as a missing signal package field', () => {
    expect(research._test.signalPackageMissingFields(resumeBoxLead().metadata.signal_package))
      .toContain('company_icp_fit');
  });

  it('classifies Resume-Box-shaped leads with the empty company ICP evidence save reason', () => {
    const lead = resumeBoxLead();
    const missingFields = research._test.signalPackageMissingFields(lead.metadata.signal_package);

    expect(signalHunt._test.missingSignalPackageSaveMetadata(lead, missingFields)).toMatchObject({
      blocker: 'icp_zero_after_company_extract',
      reason: 'empty_company_icp_evidence',
      missing_fields: expect.arrayContaining(['company_icp_fit']),
      lead_company: 'Resume Box',
      source: 'signal_hunt',
    });
  });

  it('drops incomplete packages in saveSignalLeads before contact gate persistence', () => {
    const saveStart = signalHuntSource.indexOf('async function saveSignalLeads');
    const missingGate = signalHuntSource.indexOf('const missingPackageFields = signalPackageMissingFields', saveStart);
    const skipContinue = signalHuntSource.indexOf('continue;', missingGate);
    const contactGateCall = signalHuntSource.indexOf('contactGate.tryPersistSourcedLead', saveStart);

    expect(missingGate).toBeGreaterThan(saveStart);
    expect(skipContinue).toBeGreaterThan(missingGate);
    expect(skipContinue).toBeLessThan(contactGateCall);
    expect(signalHuntSource).toContain('empty_company_icp_evidence');
  });
});
