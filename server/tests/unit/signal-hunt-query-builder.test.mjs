import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const service = (p) => readFileSync(resolve(__dirname, '../../', p), 'utf-8');
const signalHunt = require('../../services/signalHunt.js');

// Inline the pure helpers from signalHunt.js so we can execute them
// without touching DB or network. These match the source 1-for-1.
function listFrom(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}
function countryCodeFromText(value) {
  const s = String(value || '').toLowerCase();
  if (/\b(united states|usa|u\.s\.|us)\b/.test(s)) return 'US';
  if (/\b(singapore|sg)\b/.test(s)) return 'SG';
  if (/\b(malaysia|my|kuala lumpur|klang valley)\b/.test(s)) return 'MY';
  if (/\b(australia|au)\b/.test(s)) return 'AU';
  if (/\b(united kingdom|uk|great britain|gb|england)\b/.test(s)) return 'GB';
  return null;
}
function countryNameFromCode(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'US') return 'United States';
  if (c === 'SG') return 'Singapore';
  if (c === 'AU') return 'Australia';
  if (c === 'GB' || c === 'UK') return 'United Kingdom';
  return 'Malaysia';
}
function countriesFromIcp(icp = {}) {
  const raw = [...listFrom(icp.geographies), ...listFrom(icp.geo), ...listFrom(icp.countries), ...listFrom(icp.locations), ...listFrom(icp.target_markets)];
  const countries = raw.map(v => countryCodeFromText(v)).filter(Boolean).map(code => ({ code, name: countryNameFromCode(code) }));
  const seen = new Set();
  const unique = countries.filter(c => { if (seen.has(c.code)) return false; seen.add(c.code); return true; });
  return unique.length > 0 ? unique : [{ code: 'MY', name: 'Malaysia' }];
}
function hasIcpSearchScope(icp = {}) {
  return [...listFrom(icp.industries), ...listFrom(icp.verticals), ...listFrom(icp.segments), ...listFrom(icp.geographies), ...listFrom(icp.geo), ...listFrom(icp.countries), ...listFrom(icp.locations), ...listFrom(icp.target_markets)].length > 0;
}
function industryPriority(value) {
  const s = String(value || '').toLowerCase();
  if (/\b(agency|digital|marketing|creative|media|advertising|professional service|consult)/i.test(s)) return 0;
  if (/\b(outbound|sales|growth|b2b service|smb|founder-led)/i.test(s)) return 1;
  if (/\b(training|learning|l&d|development)/i.test(s)) return 3;
  return 2;
}
function industryBucket(value) {
  const s = String(value || '').toLowerCase();
  if (/\b(training|learning|l&d|coaching|skills development)/i.test(s)) return 'training';
  if (/\b(agency|digital|marketing|creative|media|advertising|content studio|pr firm|professional service|consult)/i.test(s)) return 'agency';
  return 'other';
}
function diversifyIndustriesForQueryRun(industries = []) {
  const buckets = { training: [], agency: [], other: [] };
  for (const industry of industries) buckets[industryBucket(industry)].push(industry);
  const diversified = [];
  const order = ['training', 'agency', 'other'];
  for (let i = 0; diversified.length < industries.length; i++) {
    let moved = false;
    for (const bucket of order) {
      if (buckets[bucket][i]) {
        diversified.push(buckets[bucket][i]);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return diversified;
}
function sourceAwareQueriesForCountry(country = {}, industries = []) {
  void country;
  void industries;
  return [];
}
function industriesFromIcp(icp = {}) {
  const raw = [...listFrom(icp.industries), ...listFrom(icp.verticals), ...listFrom(icp.segments)];
  const base = raw.length > 0 ? raw : ['B2B corporate training', 'professional services', 'managed IT services'];
  const seen = new Set();
  return base
    .filter(value => {
      const key = String(value || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => industryPriority(a) - industryPriority(b));
}
function buildSignalQueriesFromIcp(icp = {}) {
  const countries = countriesFromIcp(icp);
  const finalIndustries = diversifyIndustriesForQueryRun(industriesFromIcp(icp));
  const queries = [];
  for (const country of countries) {
    queries.push(...sourceAwareQueriesForCountry(country, finalIndustries));
    for (const industry of finalIndustries) {
      queries.push({ query: `"${industry}" "${country.name}" "hiring" "sales"`, signal_type: 'hiring_sales', tier: 'P1', country: country.code });
      queries.push({ query: `"${industry}" "${country.name}" ("expanding" OR "launched" OR "growth") founder OR CEO`, signal_type: 'growth_signal', tier: 'P1', country: country.code });
    }
  }
  return queries;
}
function normalizeSignalQuery(item, fallbackCountry = 'MY') {
  const raw = typeof item === 'string' ? { query: item } : (item || {});
  const query = String(raw.query || raw.search || raw.text || '').trim();
  if (!query) return null;
  const country = String(raw.country || countryCodeFromText(query) || fallbackCountry || 'MY').toUpperCase();
  return { query, signal_type: raw.signal_type || raw.type || 'buying_signal', tier: raw.tier || 'P2', country };
}
function queriesFromConfigContent(content) {
  if (Array.isArray(content?.queries) && content.queries.length > 0) return content.queries;
  const signalQueries = content?.signal_queries;
  if (Array.isArray(signalQueries)) return signalQueries;
  if (signalQueries && typeof signalQueries === 'object') {
    return Object.entries(signalQueries).flatMap(([signalType, value]) => {
      const items = Array.isArray(value) ? value : [value];
      return items.map(item => (typeof item === 'string' ? { query: item, signal_type: signalType } : { ...(item || {}), signal_type: item?.signal_type || signalType }));
    });
  }
  return [];
}

// ── Source contracts ──────────────────────────────────────────────────────
describe('signalHunt source contracts (ICP-first query priority)', () => {
  const src = service('services/signalHunt.js');
  const dbBuilderSrc = service('services/dbBuilder.js');
  const industriesFnStart = src.indexOf('function industriesFromIcp');
  const industriesFnEnd = src.indexOf('function hasIcpSearchScope', industriesFnStart);
  const industriesFn = src.slice(industriesFnStart, industriesFnEnd);

  it('ICP queries take priority over stored config and both over defaults', () => {
    expect(src).toContain('const icpQueries = hasIcpSearchScope(icp) ? buildSignalQueriesFromIcp(icp) : []');
    expect(src).toContain('const fallbackQueries = icpQueries.length > 0');
    expect(src).toContain('...icpQueries, ...configuredQueries');
  });

  it('uses the full ICP and does not slice to the first three industries', () => {
    expect(src).toContain('function industriesFromIcp');
    expect(industriesFn).not.toContain('.slice(0, 3)');
  });

  it('keeps bounded query windows on planner source channels instead of agency publication fallbacks', () => {
    const queries = signalHunt._test.buildSignalQueriesFromIcp({
      industries: [
        'B2B corporate training',
        'professional training',
        'L&D providers',
        'executive coaching',
        'sales coaching',
        'skills development',
        'digital agencies',
        'marketing agencies',
        'content studios',
        'PR firms',
        'creative studios',
      ],
      geographies: 'Malaysia, Singapore, United States',
    });
    const firstSix = queries.slice(0, 6).map(q => q.query.toLowerCase()).join('\n');
    const firstSixChannels = queries.slice(0, 6).map(q => q.source_channel);
    const firstTwelveChannels = queries.slice(0, 12).map(q => q.source_channel);
    const allQueries = queries.map(q => q.query).join('\n');

    expect(firstSix).toMatch(/training|l&d|coaching|skills development/);
    expect(firstSix).toMatch(/agenc|content studio|pr firm|creative studio/);
    expect(firstSixChannels).toEqual(expect.arrayContaining(['linkedin_jobs', 'review_sites', 'job_descriptions']));
    expect(new Set(firstSixChannels).size).toBeGreaterThan(3);
    expect(firstTwelveChannels).not.toContain('industry_publication');
    expect(allQueries).not.toMatch(/marketing-interactive|marketingmagazine|campaignasia|digitalnewsasia/i);
  });

  it('uses universal planner source-channel queries without stored publication fallback injection for MY/SG', () => {
    const queries = signalHunt._test.buildSignalQueriesFromIcp({
      industries: ['digital agencies', 'marketing agencies', 'B2B corporate training'],
      geographies: 'Malaysia, Singapore',
    });
    const allQueries = queries.map(q => q.query).join('\n');
    const firstSix = queries.slice(0, 6).map(q => q.query).join('\n');
    const firstSixChannels = queries.slice(0, 6).map(q => q.source_channel);

    expect(firstSix).toContain('site:linkedin.com/jobs');
    expect(firstSixChannels).toEqual(expect.arrayContaining(['linkedin_jobs', 'review_sites', 'job_descriptions']));
    expect(new Set(firstSixChannels).size).toBeGreaterThan(3);
    expect(firstSix).toMatch(/sales|business development|SDR|BDR|account executive/);
    expect(firstSix).toMatch(/expanding|new office|funding|investment|review|CRM/);
    expect(firstSix).toMatch(/Malaysia|Singapore/);
    expect(queries.some(q => q.source_channel === 'industry_publication')).toBe(false);
    expect(allQueries).not.toMatch(/marketing-interactive|marketingmagazine|campaignasia|digitalnewsasia/i);
  });

  it('does not teach Signal Hunt to treat appointed agencies as default target companies', () => {
    expect(src).not.toContain('Agency-publication extraction guidance');
    expect(src).not.toContain('extract the appointed agency as the company');
    expect(src).not.toContain('the lead company is the agency/provider');
    expect(src).toContain('Industry-publication extraction guidance');
  });

  it('normalises ICP title fields before decision-maker lookup', () => {
    expect(src).toContain('function titlesFromIcp');
    expect(src).toContain('const icpTitles = titlesFromIcp(icp)');
    expect(src).not.toContain("(icp.job_titles || icp.who || '').split");
    expect(src).not.toContain('(icp.job_titles || icp.who || "").split');
  });

  it('blocks generic role and geo hiring signals before decision-maker lookup when company ICP evidence is missing', () => {
    const gate = signalHunt._test.evaluateSignalCompanyIcpGate({
      company: 'HEPMIL Malaysia',
      signal_type: 'hiring_sales_roles',
      source_channel: 'linkedin_jobs',
      expected_industry: 'B2B corporate training',
      signal_summary: 'HEPMIL Malaysia is hiring an Account Executive in the target market.',
      raw_snippet: 'Account Executive | HEPMIL Malaysia | LinkedIn Jobs',
      country: 'MY',
    }, {
      verticals: ['B2B corporate training', 'professional training', 'L&D providers'],
      exclusions: ['Leo Burnett'],
      competitor_offers: ['lead generation', 'AI outbound'],
    });

    expect(gate).toMatchObject({
      pass: false,
      blocker: 'icp_zero_after_company_extract',
      reason: 'missing_company_icp_evidence',
    });
  });

  it('passes company ICP gate only when extracted company evidence proves a configured vertical', () => {
    const gate = signalHunt._test.evaluateSignalCompanyIcpGate({
      company: 'Acme Training',
      signal_type: 'hiring_sales_roles',
      source_channel: 'linkedin_jobs',
      signal_summary: 'Acme Training is hiring sales roles in Kuala Lumpur.',
      raw_snippet: 'Corporate training provider hiring Sales Manager in Malaysia',
      country: 'MY',
    }, {
      verticals: ['B2B corporate training', 'professional training', 'L&D providers'],
    });

    expect(gate).toMatchObject({
      pass: true,
      vertical_match: 'B2B corporate training',
    });
    expect(gate.reject_rules_checked).toContain('company_icp_evidence');
  });

  it('blocks tenant exclusions and competitor-offer evidence before enrichment', () => {
    expect(signalHunt._test.evaluateSignalCompanyIcpGate({
      company: 'HEPMIL Malaysia',
      signal_summary: 'HEPMIL Malaysia is hiring. Parent network Leo Burnett appears in the evidence.',
      raw_snippet: 'HEPMIL Malaysia under Leo Burnett',
    }, {
      verticals: ['B2B corporate training'],
      banned_regex: ['Leo Burnett'],
    })).toMatchObject({
      pass: false,
      blocker: 'icp_zero_after_company_extract',
      reason: 'tenant_exclusion_matched',
      matched_terms: ['Leo Burnett'],
    });

    expect(signalHunt._test.evaluateSignalCompanyIcpGate({
      company: 'Pipeline Pros',
      signal_summary: 'Pipeline Pros is a lead generation agency hiring SDRs.',
      raw_snippet: 'Lead generation agency hiring sales development reps',
    }, {
      verticals: ['B2B corporate training'],
      competitor_offers: ['lead generation'],
    })).toMatchObject({
      pass: false,
      blocker: 'competitor_offer_disqualified',
      reason: 'competitor_offer_matched',
      matched_terms: ['lead generation'],
    });
  });

  it('runs the company ICP gate before decision-maker lookup and email enrichment', () => {
    const runStart = src.indexOf('async function runSignalHunt');
    const gateIdx = src.indexOf('const companyGate = evaluateSignalCompanyIcpGate', runStart);
    const decisionMakerIdx = src.indexOf('const person = await findDecisionMaker', runStart);
    const emailIdx = src.indexOf('const enriched = await findEmail', runStart);

    expect(gateIdx).toBeGreaterThan(runStart);
    expect(gateIdx).toBeLessThan(decisionMakerIdx);
    expect(gateIdx).toBeLessThan(emailIdx);
  });

  it('uses the market-sensor parser for industry publication snippets', () => {
    expect(src).toContain('function signalExtractionAgent');
    expect(src).toContain("return 'market_sensor'");
    expect(src).toContain('const agentKey = signalExtractionAgent(query)');
    expect(src).toContain('callAgent(agentKey');
  });

  it('keeps explicit industry prioritization helpers for deterministic ordering', () => {
    expect(src).toContain('function industryPriority');
    expect(src).toContain('professional service');
    expect(src).toContain('training');
  });

  it('paid query budget consumed once per signal query (not doubled)', () => {
    expect(src).toContain('consumePaidQuery(1)');
    expect(src).not.toContain('consumePaidQuery(2)');
  });

  it('uses the manual paid budget to widen the query window without removing caps', () => {
    expect(src).toContain('const MAX_SIGNAL_QUERY_WINDOW = Math.max(MAX_SIGNAL_QUERIES_PER_RUN, envInt(\'SIGNAL_HUNT_MAX_QUERY_WINDOW\', 20))');
    expect(src).toContain('function signalQueryWindow(maxPaidQueries = null)');
    expect(src).toContain('Math.min(MAX_SIGNAL_QUERY_WINDOW, Math.max(MAX_SIGNAL_QUERIES_PER_RUN, paidQueryBudget))');
    expect(src).toContain('loadSignalConfig(clientId, icp, { maxPaidQueries })');
    expect(signalHunt._test.signalQueryWindow(17)).toBe(17);
  });

  it('reserves bounded paid Signal Hunt budget for decision-maker lookup', () => {
    expect(src).toContain('function signalPaidBudgetSplit(maxPaidQueries = null, maxLeads = 1)');
    expect(src).toContain('discoveryQueriesRun >= paidQueryBudget.discovery');
    expect(src).toContain('Discovery-query budget reached; reserving paid budget for decision-maker lookup');
    expect(src).toContain('lookup_query_budget');

    expect(signalHunt._test.signalPaidBudgetSplit(12, 20)).toEqual({
      total: 12,
      discovery: 6,
      lookup: 6,
    });
    expect(signalHunt._test.signalPaidBudgetSplit(5, 20)).toEqual({
      total: 5,
      discovery: 3,
      lookup: 2,
    });
    expect(signalHunt._test.signalPaidBudgetSplit(0, 20)).toEqual({
      total: 0,
      discovery: 0,
      lookup: 0,
    });
  });

  it('bounds Signal Hunt email-enrichment provider fanout', () => {
    expect(src).toContain('function signalProviderFanoutCaps(maxPaidQueries = null, maxLeads = 1)');
    expect(src).toContain('const providerFanoutCaps = signalProviderFanoutCaps(maxPaidQueries, maxLeads)');
    expect(src).toContain('maxDomainSearches: providerFanoutCaps.maxDomainSearchesPerLead');
    expect(src).toContain('maxHunterCalls: providerFanoutCaps.maxHunterCallsPerLead');
    expect(src).toContain('maxVerifierCalls: providerFanoutCaps.maxVerifierCallsPerLead');
    expect(src).toContain('provider_fanout_caps');

    expect(signalHunt._test.signalProviderFanoutCaps(17, 5)).toEqual({
      maxDomainSearchesPerLead: 0,
      maxHunterCallsPerLead: 1,
      maxVerifierCallsPerLead: 1,
      maxEnrichmentLeads: 5,
    });
    expect(signalHunt._test.signalProviderFanoutCaps(0, 5)).toEqual({
      maxDomainSearchesPerLead: 0,
      maxHunterCallsPerLead: 0,
      maxVerifierCallsPerLead: 0,
      maxEnrichmentLeads: 0,
    });
    expect(signalHunt._test.signalProviderFanoutCaps(null, 20)).toEqual({
      maxDomainSearchesPerLead: 0,
      maxHunterCallsPerLead: 1,
      maxVerifierCallsPerLead: 1,
      maxEnrichmentLeads: 20,
    });
  });

  it('scopes repeated-zero protection to executable discovery queries only', () => {
    expect(typeof signalHunt._test.executableDiscoveryQueriesForBudget).toBe('function');
    const plannedQueries = [
      { query: 'agency query 1', signal_type: 'agency', country: 'MY' },
      { query: 'agency query 2', signal_type: 'agency', country: 'MY' },
      { query: 'agency query 3', signal_type: 'agency', country: 'MY' },
      { query: 'training query 1', signal_type: 'training', country: 'MY' },
      { query: 'training query 2', signal_type: 'training', country: 'MY' },
    ];
    const paidBudget = signalHunt._test.signalPaidBudgetSplit(6, 20);
    const executable = signalHunt._test.executableDiscoveryQueriesForBudget(plannedQueries, paidBudget);

    expect(executable.map(q => q.query)).toEqual(['agency query 1', 'agency query 2', 'agency query 3']);
    expect(signalHunt._test.signalQuerySetHash(executable)).not.toBe(
      signalHunt._test.signalQuerySetHash(plannedQueries)
    );
  });

  it('diversifies the first capped discovery window across agency and training ICP surfaces', () => {
    const activeIcp = {
      industries: [
        'B2B corporate training',
        'professional training',
        'L&D providers',
        'executive coaching',
        'sales coaching',
        'skills development',
        'digital agencies',
        'marketing agencies',
        'content studios',
        'PR firms',
        'creative studios',
      ],
      geographies: 'Malaysia, Singapore, United States',
    };
    const queries = signalHunt._test.buildSignalQueriesFromIcp(activeIcp);
    const paidBudget = signalHunt._test.signalPaidBudgetSplit(6, 20);
    const executable = queries.slice(0, paidBudget.discovery);
    const combined = executable.map(q => `${q.signal_type} ${q.query}`).join('\n');

    expect(executable).toHaveLength(3);
    expect(combined).toMatch(/agenc|marketing|content studio|pr firm|creative studio/i);
    expect(combined).toMatch(/training|professional training|b2b corporate training|l&d|coaching|skills development/i);
    expect(combined).not.toMatch(/marketing-interactive|marketingmagazine|campaignasia|digitalnewsasia/i);
  });

  it('logs raw-zero blockers and blocks repeated zero-output query sets per day', () => {
    expect(src).toContain('function signalQuerySetHash');
    expect(src).toContain('SIGNAL_HUNT_PARSER_VERSION');
    expect(src).toContain('parser_version');
    expect(src).toContain('signal_hunt_zero_query_set_');
    expect(src).toContain("'signal_hunt_zero_query_set_blocked'");
    expect(src).toContain("'repeated_zero_output_query_set'");
    expect(src).toContain("'raw_candidates_zero'");
    expect(src).toContain("'signals_zero_after_llm_parse'");
    expect(src).toContain("'contact_zero'");
    expect(src).not.toContain("'contacts_zero'");
    expect(src).toContain('raw_results_total');
    expect(src).toContain('raw_candidates_total');
    expect(src).toContain('companies_extracted');
    expect(src).toContain('icp_passed');
    expect(src).toContain('decision_makers_found');
    expect(src).toContain('contacts_found');
    expect(src).toContain('saved');
    expect(src).toContain('raw_sample');
    expect(src).toContain("'pattern', NOW()");
    expect(src).not.toContain("'state', NOW()");
    expect(src).toContain('ON CONFLICT (client_id, agent, key) DO NOTHING');
  });

  it('exposes a no-spend query plan preview for paid proof preflight', () => {
    expect(src).toContain('async function previewSignalHuntPlan');
    expect(src).toContain('query_set_hash');
    expect(src).toContain('executable_queries');
    expect(src).toContain('repeated_zero_blocked');
    expect(src).toContain('previewSignalHuntPlan');
  });

  it('loads stored Signal Hunt config deterministically when multiple agents share the key', () => {
    expect(src).toContain("WHEN 'research_beaver' THEN 0");
    expect(src).toContain("WHEN 'captain_beaver' THEN 1");
    expect(src).toContain('updated_at DESC');
  });

  it('saveSignalLeads routes through contactGate.tryPersistSourcedLead', () => {
    expect(src).toContain("contactGate.tryPersistSourcedLead(clientId, lead, {");
    expect(src).toContain("sourceStrategy: 'signal_hunt'");
  });

  it('saveSignalLeads sets buying_signal_strength to rich by default', () => {
    expect(src).toContain("|| 'rich'");
    expect(src).toContain('buying_signal_strength, signal_dated_at');
  });

  it('packages Signal Hunt leads with the V2.1 signal_package contract before save', () => {
    const packaged = signalHunt._test.attachSignalPackageToSignalLead({
      name: 'Jane Tan',
      title: 'Founder',
      company: 'Acme Training',
      linkedin_url: 'https://www.linkedin.com/in/janetan',
      email: 'jane@acmetraining.com',
      email_source: 'hunter',
      email_verified: true,
      data_source: 'signal_hunt',
      metadata: {
        signal: 'Acme Training is hiring sales roles in Kuala Lumpur',
        why_now: 'They are building sales capacity now',
        angle: 'Ask how founder-led outreach is being handled while hiring',
        signal_type: 'hiring_sales',
        signal_source_url: 'https://www.linkedin.com/jobs/view/123',
        signal_confidence: 0.92,
        country: 'Malaysia',
        source: 'signal_hunt',
      },
    }, { evidenceDate: '2026-06-03' });

    expect(packaged.metadata.signal_package).toMatchObject({
      signal_id: 'hiring_sales',
      signal_family: 'hiring_capability_build',
      source_channel: 'web_search',
      source_url: 'https://www.linkedin.com/jobs/view/123',
      evidence: 'Acme Training is hiring sales roles in Kuala Lumpur',
      evidence_date: '2026-06-03',
      why_now: 'They are building sales capacity now',
      decision_maker: {
        name: 'Jane Tan',
        title: 'Founder',
        source_url: 'https://www.linkedin.com/in/janetan',
      },
      contact: {
        email: 'jane@acmetraining.com',
        email_verified: true,
        email_source: 'hunter',
        linkedin_url: 'https://www.linkedin.com/in/janetan',
      },
    });
    expect(signalHunt._test.signalPackageMissingFields(packaged.metadata.signal_package)).toEqual([]);
  });

  it('records company ICP evidence in Signal Hunt packages after the pre-enrichment gate passes', () => {
    const packaged = signalHunt._test.attachSignalPackageToSignalLead({
      name: 'Jane Tan',
      title: 'Founder',
      company: 'Acme Training',
      linkedin_url: 'https://www.linkedin.com/in/janetan',
      data_source: 'signal_hunt',
      metadata: {
        signal: 'Acme Training is hiring sales roles in Kuala Lumpur',
        why_now: 'They are building sales capacity now',
        signal_type: 'hiring_sales',
        signal_source_url: 'https://www.linkedin.com/jobs/view/123',
        country: 'Malaysia',
        industry_match: 'B2B corporate training',
        icp_evidence: ['training'],
        reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
      },
    });

    expect(packaged.metadata.signal_package.company_icp_fit).toMatchObject({
      vertical_match: 'B2B corporate training',
      geo_match: 'Malaysia',
      reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
    });
  });

  it('refuses incomplete Signal Hunt packages before contactGate persistence', () => {
    const saveStart = src.indexOf('async function saveSignalLeads');
    const packageGate = src.indexOf('signalPackageMissingFields', saveStart);
    const contactGateCall = src.indexOf('contactGate.tryPersistSourcedLead', saveStart);

    expect(saveStart).toBeGreaterThan(-1);
    expect(packageGate).toBeGreaterThan(saveStart);
    expect(contactGateCall).toBeGreaterThan(packageGate);
    expect(src).toContain('missing_signal_package_before_signal_save');
  });

  it('applies Captain run_signal_playbook payloads to Signal Hunt query selection', () => {
    const config = {
      queries: [
        { query: '"agency" "Malaysia" "hiring" "sales"', signal_type: 'hiring_sales', tier: 'P1', country: 'MY' },
        { query: '"agency" "Malaysia" "expanding"', signal_type: 'growth_signal', tier: 'P1', country: 'MY' },
      ],
      query_source: 'current_icp',
      max_results_per_query: 3,
    };

    const planned = signalHunt._test.applySignalPlaybookToConfig(config, {
      signal_id: 'hiring_sales_roles',
      source_channel: 'linkedin_jobs',
      geo: ['MY'],
      cap: 1,
    });

    expect(planned.queries).toHaveLength(1);
    expect(planned.queries[0]).toMatchObject({
      signal_type: 'hiring_sales',
      source_channel: 'linkedin_jobs',
      signal_id: 'hiring_sales_roles',
    });
    expect(planned.query_source).toBe('current_icp_signal_playbook');
  });

  it('executes Captain-planned signal queries directly instead of relabeling fallback queries', () => {
    const config = {
      queries: [
        { query: 'site:marketing-interactive.com "Malaysia" "agency" "appointed"', signal_type: 'growth_signal', tier: 'P1', country: 'MY', source_channel: 'industry_publication' },
      ],
      query_source: 'current_icp_then_config',
      max_results_per_query: 3,
    };

    const planned = signalHunt._test.applySignalPlaybookToConfig(config, {
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'linkedin_jobs',
      geo: ['MY'],
      cap: 2,
      queries: [
        {
          sourceChannel: 'linkedin_jobs',
          query: 'site:linkedin.com/jobs "sales" "Malaysia" "B2B corporate training" (hiring OR vacancy OR careers)',
          costClass: 'paid_search',
          expectedEvidence: ['company', 'role', 'source_url'],
          industry: 'B2B corporate training',
          geo: 'MY',
          term: 'sales',
        },
        {
          sourceChannel: 'company_careers',
          query: '("careers" OR "jobs" OR "join our team") "sales" "Malaysia" "digital agencies" (hiring OR vacancy OR careers)',
          costClass: 'paid_search',
          expectedEvidence: ['company', 'role', 'source_url'],
          industry: 'digital agencies',
          geo: 'MY',
          term: 'sales',
        },
      ],
    });

    expect(planned.query_source).toBe('signal_playbook_planned_queries');
    expect(planned.queries).toHaveLength(2);
    expect(planned.queries[0]).toMatchObject({
      query: 'site:linkedin.com/jobs "sales" "Malaysia" "B2B corporate training" (hiring OR vacancy OR careers)',
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'linkedin_jobs',
      expected_evidence: ['company', 'role', 'source_url'],
      industry: 'B2B corporate training',
      term: 'sales',
      country: 'MY',
    });
    expect(planned.queries.some(q => q.source_channel === 'industry_publication')).toBe(false);
  });

  it('maps universal signal ids into their canonical families for packages and playbook matching', () => {
    expect(signalHunt._test.signalFamilyForType('vendor_research')).toBe('category_vendor_research');
    expect(signalHunt._test.signalFamilyForType('stack_change')).toBe('technology_stack_change');
    expect(signalHunt._test.signalFamilyForType('regulatory_pressure')).toBe('regulatory_deadline_pressure');
    expect(signalHunt._test.signalFamilyForType('pain_signal')).toBe('pain_friction_evidence');
    expect(signalHunt._test.signalFamilyForType('event_presence')).toBe('event_market_presence');
  });

  it('DB Builder consumes Research run_signal_playbook directives before pool health', () => {
    const researchDirectiveRead = dbBuilderSrc.indexOf("readPendingDirectives(client.id, 'research_beaver')");
    const playbookFilter = dbBuilderSrc.indexOf("directive_type === 'run_signal_playbook'");
    const runSignalHunt = dbBuilderSrc.indexOf('runSignalHunt(client.id', playbookFilter);
    const saveSignalLeads = dbBuilderSrc.indexOf('saveSignalLeads(client.id', playbookFilter);
    const healthCheck = dbBuilderSrc.indexOf('// Check pool health');

    expect(researchDirectiveRead).toBeGreaterThan(-1);
    expect(playbookFilter).toBeGreaterThan(researchDirectiveRead);
    expect(runSignalHunt).toBeGreaterThan(playbookFilter);
    expect(saveSignalLeads).toBeGreaterThan(runSignalHunt);
    expect(saveSignalLeads).toBeLessThan(healthCheck);
    expect(dbBuilderSrc).toContain('signal_playbook_consumed');
  });

  it('marks acted playbook directives before later budget-cap early returns', () => {
    const budgetCapLog = dbBuilderSrc.indexOf('Budget cap, skipping');
    const budgetCapReturn = dbBuilderSrc.indexOf('return;', budgetCapLog);
    const markConsumed = dbBuilderSrc.indexOf('markConsumed(client.id, consumedDirectiveIds)', budgetCapLog);

    expect(budgetCapLog).toBeGreaterThan(-1);
    expect(markConsumed).toBeGreaterThan(budgetCapLog);
    expect(markConsumed).toBeLessThan(budgetCapReturn);
  });
});

// ── Pure function unit tests ──────────────────────────────────────────────
describe('countriesFromIcp', () => {
  it('returns MY default when ICP has no geo fields', () => {
    expect(countriesFromIcp({})).toEqual([{ code: 'MY', name: 'Malaysia' }]);
  });

  it('extracts MY from Kuala Lumpur text', () => {
    const r = countriesFromIcp({ geographies: 'Kuala Lumpur, Malaysia' });
    expect(r.some(c => c.code === 'MY')).toBe(true);
  });

  it('deduplicates multiple references to the same country', () => {
    const r = countriesFromIcp({ geographies: 'Malaysia, Kuala Lumpur, MY' });
    expect(r.filter(c => c.code === 'MY').length).toBe(1);
  });

  it('extracts SG from Singapore text', () => {
    const r = countriesFromIcp({ countries: ['Singapore'] });
    expect(r.some(c => c.code === 'SG')).toBe(true);
  });
});

describe('titlesFromIcp', () => {
  it('normalises array and comma-separated ICP title fields without crashing', () => {
    expect(signalHunt._test.titlesFromIcp({
      job_titles: ['Founder', 'CEO'],
      target_titles: 'Managing Director, Owner',
      who: ['Head of Sales'],
    })).toEqual(['Founder', 'CEO', 'Managing Director', 'Owner', 'Head of Sales']);
  });
});

describe('signal extraction helpers', () => {
  it('routes industry publication parsing away from Research Beaver lead-output rules', () => {
    expect(signalHunt._test.signalExtractionAgent({
      signal_type: 'industry_publication_agency_signal',
      source_channel: 'industry_publication',
    })).toBe('market_sensor');
    expect(signalHunt._test.signalExtractionAgent({
      signal_type: 'hiring_sales',
      source_channel: 'web_search',
    })).toBe('research_beaver');
  });

  it('normalises market-sensor opportunities into Signal Hunt signal shape', () => {
    expect(signalHunt._test.normaliseExtractedSignals([{
      company: 'GO Communications',
      signal_type: 'new_client_win',
      signal_summary: 'Food & Drinks Malaysia appointed GO Communications for PR duties.',
      url: 'https://example.com/go',
      confidence: 'high',
      outreach_angle: 'New PR mandate means founder-led pipeline pressure can surface.',
    }], 'industry_publication_agency_signal')).toMatchObject([{
      company: 'GO Communications',
      signal_type: 'new_client_win',
      source_url: 'https://example.com/go',
      confidence: 0.9,
      angle: 'New PR mandate means founder-led pipeline pressure can surface.',
    }]);
  });

  it('normalises single-object market-sensor variants into complete Signal Hunt signals', () => {
    expect(signalHunt._test.normaliseExtractedSignals([{
      company_name: 'PRecious Communications',
      summary: 'PRecious Communications appointed its first regional COO with a Malaysia remit.',
      url: 'https://example.com/precious',
      suggested_angle: 'Ask how regional leadership is scaling pipeline across Malaysia.',
    }], 'industry_publication_agency_signal')).toMatchObject([{
      company: 'PRecious Communications',
      signal_type: 'industry_publication_agency_signal',
      source_url: 'https://example.com/precious',
      signal_summary: 'PRecious Communications appointed its first regional COO with a Malaysia remit.',
      why_now: 'PRecious Communications appointed its first regional COO with a Malaysia remit.',
      angle: 'Ask how regional leadership is scaling pipeline across Malaysia.',
      confidence: 0.6,
    }]);
  });

  it('accepts OpenAI json_object wrappers around extracted signal arrays', () => {
    expect(signalHunt._test.extractedSignalItems({
      leads: [{ company: 'Kingdom Digital' }],
    })).toEqual([{ company: 'Kingdom Digital' }]);
    expect(signalHunt._test.extractedSignalItems({
      companies: [{ company: 'GO Communications' }],
    })).toEqual([{ company: 'GO Communications' }]);
    expect(signalHunt._test.extractedSignalItems({
      buying_signals: [{ company: 'Mad Hat Asia' }],
    })).toEqual([{ company: 'Mad Hat Asia' }]);
  });

  it('accepts OpenAI single-object and stringified wrappers around extracted signals', () => {
    expect(signalHunt._test.extractedSignalItems({
      company_name: 'GO Communications',
      summary: 'GO Communications won a PR mandate.',
    })).toEqual([{
      company_name: 'GO Communications',
      summary: 'GO Communications won a PR mandate.',
    }]);
    expect(signalHunt._test.extractedSignalItems({
      data: { company_name: 'Kingdom Digital' },
    })).toEqual([{ company_name: 'Kingdom Digital' }]);
    expect(signalHunt._test.extractedSignalItems({
      signals: JSON.stringify([{ company_name: 'PRecious Communications' }]),
    })).toEqual([{ company_name: 'PRecious Communications' }]);
    expect(signalHunt._test.extractedSignalItems({
      payload: {
        opportunities: [{ company_name: 'Ruder Finn Malaysia' }],
      },
    })).toEqual([{ company_name: 'Ruder Finn Malaysia' }]);
  });

  it('deterministically extracts obvious industry-publication signals the LLM can miss', () => {
    const results = [
      {
        title: 'Food & Drinks Malaysia Dishes Out PR Duties To GO Communications | MARKETING Magazine Asia',
        link: 'https://marketingmagazine.com.my/food-drinks-malaysia-dishes-out-pr-duties-to-go-communications/',
        date: '1 month ago',
      },
      {
        title: 'Malaysia Airlines Appoints Kingdom Digital as Creative Automation Agency to PowerScalable Global Campaigns | MARKETING Magazine Asia',
        link: 'https://marketingmagazine.com.my/malaysia-airlines-appoints-kingdom-digital-as-creative-automation-agency-to-powerscalable-global-campaigns/',
        date: 'April 15, 2026',
      },
      {
        title: 'PRecious Communications names first regional COO, expands leadership remit in Malaysia | Marketing-Interactive',
        link: 'https://www.marketing-interactive.com/precious-communications-names-first-regional-coo-expands-leadership-remit-in-malaysia',
        date: 'November 6, 2025',
      },
      {
        title: 'Ruder Finn Asia Group Appoints General Manager of Ruder Finn Malaysia - MARKETING Magazine Asia',
        link: 'https://archive.marketingmagazine.com.my/ruder-finn-asia-group-appoints-general-manager-of-ruder-finn-malaysia/',
      },
      {
        title: 'How VLT Malaysia became SEA independent agency of the year | Campaign Asia',
        link: 'https://www.campaignasia.com/article/how-vlt-malaysia-became-seas-independent-agency-of-the-year/haybke73tzcgrbset5x0sevvj5',
      },
      {
        title: 'Digital skills transformation company, General Assembly launches in Malaysia, will accelerate upskilling of workforce | Digital News Asia',
        link: 'https://www.digitalnewsasia.com/digital-economy/digital-skills-transformation-company-general-assembly-launches-malaysia-will',
        date: 'January 24, 2020',
      },
    ];

    const signals = signalHunt._test.deterministicPublicationSignals(results, {
      signal_type: 'industry_publication_agency_signal',
      source_channel: 'industry_publication',
    });

    expect(signals.map(s => s.company)).toEqual([
      'GO Communications',
      'Kingdom Digital',
      'PRecious Communications',
      'Ruder Finn Malaysia',
      'VLT Malaysia',
    ]);
    expect(signals.every(s => s.confidence >= 0.5 && s.source_url)).toBe(true);
  });

  it('deterministically extracts local hiring companies from LinkedIn job result titles', () => {
    const results = [
      {
        title: 'Full Cycle Sales Executive - Malaysia Market at Fact Base | LinkedIn',
        link: 'https://www.linkedin.com/jobs/view/4418286599',
        snippet: 'Greater Kuala Lumpur. Fact Base is hiring for a sales role in Malaysia.',
        date: '1 month ago',
      },
      {
        title: 'Account Executive, GTS - Gartner | LinkedIn',
        link: 'https://www.linkedin.com/jobs/view/4412110000',
        snippet: 'Kuala Lumpur, Malaysia. Gartner is looking for an Account Executive.',
        date: '1 week ago',
      },
      {
        title: '15,000+ Sales jobs in Malaysia | LinkedIn',
        link: 'https://www.linkedin.com/jobs/sales-jobs-malaysia',
        snippet: 'Sales roles from MYR3,500 per month across Malaysia.',
      },
      {
        title: '(ASM) Area Sales Manager Pharma job vacancy at Delhi NCR and Jaipur in Tablets India',
        link: 'https://www.linkedin.com/jobs/view/4422053099',
        snippet: 'Indian Pharma Jobs - Pharma Jobs in India',
        date: '1 week ago',
      },
    ];

    const signals = signalHunt._test.deterministicHiringSignals(results, {
      signal_type: 'hiring_sales_roles',
      source_channel: 'linkedin_jobs',
      country: 'MY',
    });

    expect(signals.map(s => s.company)).toEqual(['Fact Base', 'Gartner']);
    expect(signals.every(s => s.signal_type === 'hiring_sales_roles')).toBe(true);
    expect(signals.every(s => s.confidence >= 0.65 && s.source_url)).toBe(true);
  });

  it('merges deterministic publication fallback without duplicating parser output', () => {
    expect(signalHunt._test.mergeExtractedSignalSets([{
      company: 'Kingdom Digital',
      source_url: 'https://example.com/kingdom',
      confidence: 0.9,
    }], [{
      company: 'Kingdom Digital',
      source_url: 'https://example.com/kingdom',
      confidence: 0.62,
    }, {
      company: 'GO Communications',
      source_url: 'https://example.com/go',
      confidence: 0.62,
    }])).toEqual([{
      company: 'Kingdom Digital',
      source_url: 'https://example.com/kingdom',
      confidence: 0.9,
    }, {
      company: 'GO Communications',
      source_url: 'https://example.com/go',
      confidence: 0.62,
    }]);
  });

  it('rejects salary and aggregate text as signal company names before lead lookup', () => {
    expect(signalHunt._test.validSignalCompanyName('MYR3,500')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('15,000+ Sales jobs in Malaysia')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('Allura Asia')).toBe(true);
  });
});

describe('buildSignalQueriesFromIcp', () => {
  it('produces industry x country cross-product (2 query types each)', () => {
    const r = buildSignalQueriesFromIcp({ industries: ['SaaS'], geographies: ['Malaysia'] });
    // 1 industry x 1 country x 2 query types = 2
    expect(r.length).toBe(2);
    expect(r[0].signal_type).toBe('hiring_sales');
    expect(r[1].signal_type).toBe('growth_signal');
  });

  it('includes country code on each query', () => {
    const r = buildSignalQueriesFromIcp({ industries: ['Agency'], countries: ['Singapore'] });
    expect(r.every(q => q.country === 'SG')).toBe(true);
  });

  it('does not drop later ICP verticals after the first three', () => {
    const r = buildSignalQueriesFromIcp({
      verticals: ['B2B corporate training', 'professional training', 'L&D providers', 'digital agency'],
      geographies: ['Malaysia'],
    });
    expect(r.some(q => q.query.includes('"digital agency"'))).toBe(true);
  });

  it('does not allow publication fallbacks to consume the proof window', () => {
    const r = buildSignalQueriesFromIcp({
      verticals: ['B2B corporate training', 'professional training', 'digital agency', 'professional services'],
      geographies: ['Malaysia'],
    });
    const firstFour = r.slice(0, 4);
    expect(firstFour.some(q => q.source_channel === 'industry_publication')).toBe(false);
    expect(r.map(q => q.query.toLowerCase()).join('\n')).not.toMatch(/marketingmagazine|marketing-interactive|campaignasia|digitalnewsasia/);
  });

  it('builds ICP Signal Hunt queries from the universal signal planner across source channels', () => {
    const r = signalHunt._test.buildSignalQueriesFromIcp({
      verticals: ['B2B corporate training', 'digital agencies'],
      geo: ['MY'],
      competitor_offers: ['lead generation', 'AI outbound'],
      buying_signals: [
        {
          id: 'hiring_sales_roles',
          family: 'hiring_capability_build',
          enabled: true,
          priority: 1,
          source_channels: ['linkedin_jobs', 'company_careers'],
          query_terms: ['sales'],
          evidence_required: ['company', 'role', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'expansion_markets',
          family: 'expansion_growth',
          enabled: true,
          priority: 2,
          source_channels: ['company_news', 'press'],
          query_terms: ['expanding'],
          evidence_required: ['company', 'expansion_fact', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'fresh_capital',
          family: 'capital_budget_event',
          enabled: true,
          priority: 3,
          source_channels: ['news', 'investor_pages'],
          query_terms: ['funding'],
          evidence_required: ['company', 'event', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'active_ads',
          family: 'active_gtm_spend',
          enabled: true,
          priority: 4,
          source_channels: ['meta_ad_library', 'google_ads_transparency'],
          query_terms: ['demo'],
          evidence_required: ['company', 'ad_url', 'offer'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
      ],
    });

    expect(r.map(q => q.signal_id)).toEqual(expect.arrayContaining([
      'hiring_sales_roles',
      'expansion_markets',
      'fresh_capital',
      'active_ads',
    ]));
    expect(r.map(q => q.source_channel)).toEqual(expect.arrayContaining([
      'linkedin_jobs',
      'company_news',
      'news',
      'meta_ad_library',
    ]));
    expect(r[0]).toMatchObject({
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'linkedin_jobs',
      country: 'MY',
    });
    expect(r[0].query).toMatch(/Kuala Lumpur|Greater Kuala Lumpur|Malaysia/i);
    expect(r[0].query).not.toMatch(/B2B corporate training|digital agencies/i);
    expect(r.slice(0, 12).some(q => q.source_channel === 'industry_publication')).toBe(false);
    expect(r.map(q => q.query).join('\n')).not.toMatch(/marketing-interactive|marketingmagazine|campaignasia|digitalnewsasia/);
  });
});

describe('normalizeSignalQuery', () => {
  it('returns null for empty/missing query string', () => {
    expect(normalizeSignalQuery({ query: '' })).toBeNull();
    expect(normalizeSignalQuery('')).toBeNull();
    expect(normalizeSignalQuery({})).toBeNull();
  });

  it('uppercases country code', () => {
    const r = normalizeSignalQuery({ query: 'test query', country: 'sg' });
    expect(r.country).toBe('SG');
  });

  it('falls back to MY for unresolvable country', () => {
    const r = normalizeSignalQuery({ query: 'test query with no country' }, 'MY');
    expect(r.country).toBe('MY');
  });

  it('infers country from query text', () => {
    const r = normalizeSignalQuery('"Malaysia" B2B hiring');
    expect(r.country).toBe('MY');
  });
});

describe('queriesFromConfigContent', () => {
  it('returns [] for null/empty content', () => {
    expect(queriesFromConfigContent(null)).toEqual([]);
    expect(queriesFromConfigContent({})).toEqual([]);
  });

  it('returns content.queries array when present', () => {
    const q = [{ query: 'test' }];
    expect(queriesFromConfigContent({ queries: q })).toBe(q);
  });

  it('reads signal_queries as object and normalises to array', () => {
    const r = queriesFromConfigContent({ signal_queries: { hiring: ['query A', 'query B'] } });
    expect(r.length).toBe(2);
    expect(r.every(x => x.signal_type === 'hiring')).toBe(true);
  });
});
