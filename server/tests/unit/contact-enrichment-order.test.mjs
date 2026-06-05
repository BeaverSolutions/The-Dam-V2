import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const research = require('../../services/research.js');
const researchSource = readFileSync(resolve(__dirname, '../../services/research.js'), 'utf-8');
const dbBuilderSource = readFileSync(resolve(__dirname, '../../services/dbBuilder.js'), 'utf-8');
const pipelineSource = readFileSync(resolve(__dirname, '../../services/pipeline.js'), 'utf-8');
const emailEnrichmentSource = readFileSync(resolve(__dirname, '../../services/emailEnrichment.js'), 'utf-8');

describe('Research Beaver decision-maker and contact enrichment order', () => {
  it('documents the canonical Phase 3 enrichment sequence as code', () => {
    expect(research._test.ORDERED_RESEARCH_ENRICHMENT_STAGES).toEqual([
      'company_evidence',
      'icp_and_exclusion_checks',
      'decision_maker_lookup',
      'hunter',
      'millionverifier',
      'contact_gate',
      'save_with_signal_package',
    ]);
  });

  it('requires company evidence before signal package creation can be complete', () => {
    const packaged = research._test.attachSignalPackageToLead({
      name: 'Jane Tan',
      title: 'Founder',
      company: 'Acme Training',
      linkedin_url: 'https://www.linkedin.com/in/janetan',
      metadata: {
        signal_id: 'hiring_sales_roles',
        signal_family: 'hiring_capability_build',
        source_channel: 'linkedin_jobs',
      },
    });

    expect(research._test.signalPackageMissingFields(packaged.metadata.signal_package)).toEqual(expect.arrayContaining([
      'source_url',
      'evidence',
    ]));
  });

  it('runs decision-maker profile lookup before Hunter domain search in company-first strategy', () => {
    const strategyStart = researchSource.indexOf('async function strategyCompanyFirst');
    const strategyEnd = researchSource.indexOf('/* ─── Strategy 3', strategyStart);
    const strategyBody = researchSource.slice(strategyStart, strategyEnd);
    const decisionLookup = strategyBody.indexOf('decision_maker_lookup');
    const hunterLookup = strategyBody.indexOf('hunterService.domainSearch');

    expect(decisionLookup).toBeGreaterThan(-1);
    expect(hunterLookup).toBeGreaterThan(-1);
    expect(decisionLookup).toBeLessThan(hunterLookup);
  });

  it('runs Hunter before MillionVerifier and only verifies generated candidates', () => {
    const hunterIdx = emailEnrichmentSource.indexOf('const hunterResult = await tryHunter');
    const verifyCandidatesIdx = emailEnrichmentSource.indexOf('const verifyCandidates = candidates.slice(0, 3)');
    const millionVerifierIdx = emailEnrichmentSource.indexOf('await verifyEmail(email, clientId)');

    expect(hunterIdx).toBeGreaterThan(-1);
    expect(verifyCandidatesIdx).toBeGreaterThan(hunterIdx);
    expect(millionVerifierIdx).toBeGreaterThan(verifyCandidatesIdx);
    expect(emailEnrichmentSource).toContain('const candidates = generateEmailCandidates(firstName, lastName, domain)');
  });

  it('keeps autonomous Research sourcing off VP and routes save through contact gate with signal package metadata', () => {
    const onDemandStart = dbBuilderSource.indexOf('async function sourceLeadsOnDemand');
    const onDemandBody = dbBuilderSource.slice(onDemandStart, dbBuilderSource.indexOf('module.exports', onDemandStart));
    const saveLeadStart = dbBuilderSource.indexOf('async function saveLead');
    const saveLeadBody = dbBuilderSource.slice(saveLeadStart, dbBuilderSource.indexOf('// ── Source Leads', saveLeadStart));

    expect(onDemandBody).not.toContain('sourceLeadsViaVP');
    expect(onDemandBody).toContain('runSignalHunt');
    expect(onDemandBody).toContain('saveSignalLeads');
    expect(onDemandBody).toContain('source_order: \'signal_hunt_contact_gate\'');
    expect(onDemandBody.indexOf('runSignalHunt')).toBeLessThan(onDemandBody.indexOf('researchModule.researchLeads'));
    expect(saveLeadBody).toContain('contactGate.tryPersistSourcedLead');
    expect(saveLeadBody).toContain('signal_package');
    expect(pipelineSource).not.toContain('vpService');
  });
});
