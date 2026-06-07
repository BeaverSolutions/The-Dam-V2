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
const signalHuntSource = readFileSync(resolve(__dirname, '../../services/signalHunt.js'), 'utf-8');
const indexSource = readFileSync(resolve(__dirname, '../../index.js'), 'utf-8');
const autonomousRouteSource = readFileSync(resolve(__dirname, '../../routes/autonomous.js'), 'utf-8');

describe('Research Beaver decision-maker and contact enrichment order', () => {
  it('documents the canonical Phase 3 enrichment sequence as code', () => {
    expect(research._test.ORDERED_RESEARCH_ENRICHMENT_STAGES).toEqual([
      'company_evidence',
      'icp_and_exclusion_checks',
      'decision_maker_lookup',
      'anymail',
      'icypeas',
      'snov',
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

  it('runs Signal Hunt public evidence lookup before LinkedIn-style decision-maker lookup', () => {
    const fnStart = signalHuntSource.indexOf('async function findDecisionMaker');
    const fnEnd = signalHuntSource.indexOf('async function runSignalHunt', fnStart);
    const body = signalHuntSource.slice(fnStart, fnEnd);
    const publicLookup = body.indexOf('searchOpenWeb');
    const linkedinLookup = body.indexOf('searchLinkedInProfiles');

    expect(fnStart).toBeGreaterThan(-1);
    expect(publicLookup).toBeGreaterThan(-1);
    expect(linkedinLookup).toBeGreaterThan(publicLookup);
    expect(body).toContain('decision_maker_public_evidence');
  });

  it('does not require a LinkedIn URL before Signal Hunt can attempt contact enrichment', () => {
    const loopStart = signalHuntSource.indexOf('for (const signal of uniqueSignals');
    const loopEnd = signalHuntSource.indexOf('leads.push(attachSignalPackageToSignalLead', loopStart);
    const loopBody = signalHuntSource.slice(loopStart, loopEnd);

    expect(loopBody).not.toContain('!person.linkedin_url');
    expect(loopBody).toContain('!person || !person.name');
  });

  it('runs Anymail, then Icypeas, then Snov, then Hunter before MillionVerifier verifies sourced emails', () => {
    const anymailIdx = emailEnrichmentSource.indexOf('const anymailResult = await tryAnymail');
    const icypeasIdx = emailEnrichmentSource.indexOf('const icypeasResult = await tryIcypeas');
    const snovIdx = emailEnrichmentSource.indexOf('const snovResult = await trySnov');
    const hunterIdx = emailEnrichmentSource.indexOf('const hunterResult = await tryHunter');
    const providerVerifyIdx = emailEnrichmentSource.indexOf('await verifyProviderEmail');
    const verifyCandidatesIdx = emailEnrichmentSource.indexOf('const verifyCandidates = candidates.slice(0, verifierCallsRemaining)');
    const millionVerifierIdx = emailEnrichmentSource.indexOf('await verifyEmail(email, clientId)');

    expect(anymailIdx).toBeGreaterThan(-1);
    expect(icypeasIdx).toBeGreaterThan(anymailIdx);
    expect(snovIdx).toBeGreaterThan(icypeasIdx);
    expect(hunterIdx).toBeGreaterThan(-1);
    expect(hunterIdx).toBeGreaterThan(snovIdx);
    expect(providerVerifyIdx).toBeGreaterThan(anymailIdx);
    expect(providerVerifyIdx).toBeLessThan(millionVerifierIdx);
    expect(verifyCandidatesIdx).toBeGreaterThan(hunterIdx);
    expect(millionVerifierIdx).toBeGreaterThan(verifyCandidatesIdx);
    expect(emailEnrichmentSource).toContain('const candidates = generateEmailCandidates(firstName, lastName, domain)');
  });

  it('lets Signal Hunt cap domain, email sourcing providers, and verifier fanout per enrichment call', () => {
    expect(emailEnrichmentSource).toContain('function providerCapInt(value, fallback)');
    expect(emailEnrichmentSource).toContain('const maxDomainSearches = providerCapInt(lead.maxDomainSearches, 1)');
    expect(emailEnrichmentSource).toContain('if (maxDomainSearches > 0)');
    expect(emailEnrichmentSource).toContain('const maxAnymailCalls = providerCapInt(lead.maxAnymailCalls, lead.skipAnymail === true ? 0 : 1)');
    expect(emailEnrichmentSource).toContain('const maxIcypeasCalls = providerCapInt(lead.maxIcypeasCalls, lead.skipIcypeas === true ? 0 : 1)');
    expect(emailEnrichmentSource).toContain('const maxSnovCalls = providerCapInt(lead.maxSnovCalls, lead.skipSnov === true ? 0 : 1)');
    expect(emailEnrichmentSource).toContain('const maxHunterCalls = providerCapInt(lead.maxHunterCalls, lead.skipHunter === true ? 0 : 1)');
    expect(emailEnrichmentSource).toContain('if (maxAnymailCalls > 0)');
    expect(emailEnrichmentSource).toContain('if (maxIcypeasCalls > 0)');
    expect(emailEnrichmentSource).toContain('if (maxSnovCalls > 0)');
    expect(emailEnrichmentSource).toContain('if (maxHunterCalls > 0)');
    expect(emailEnrichmentSource).toContain('const maxVerifierCalls = providerCapInt(lead.maxVerifierCalls, 3)');
    expect(emailEnrichmentSource).toContain('let verifierCallsRemaining = maxVerifierCalls');
    expect(emailEnrichmentSource).toContain('const verifyCandidates = candidates.slice(0, verifierCallsRemaining)');
  });

  it('keeps legacy enrichEmail on the same findEmail provider waterfall', () => {
    const start = emailEnrichmentSource.indexOf('async function enrichEmail(clientId, { name, company })');
    const end = emailEnrichmentSource.indexOf('/* ════════════════════════════════════════════════════════════════════════', start);
    const body = emailEnrichmentSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('const result = await findEmail({');
    expect(body).toContain('return { ...result, source: result.email_source || result.source || null }');
    expect(body).not.toContain('const hunter = await tryHunter');
  });

  it('persists MV verification metadata when legacy callers save enriched email', () => {
    expect(indexSource).toContain('l.email_verified AS lead_email_verified');
    expect(indexSource).toContain('let foundEmail = msg.lead_email_verified === true ? msg.lead_email : null');
    expect(indexSource).toContain("if (result?.email && result.status === 'deliverable')");
    expect(indexSource).toContain('email_verified = $2, email_source = $3');
    expect(indexSource).toContain("result.status === 'deliverable'");
    expect(indexSource).toContain("result.source || result.email_source || 'findemail'");

    expect(autonomousRouteSource).toContain("email_verified: enrich?.status === 'deliverable'");
    expect(autonomousRouteSource).toContain('email_source: enrich?.source || enrich?.email_source || null');
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
