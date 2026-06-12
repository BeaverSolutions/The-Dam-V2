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

function hasThreeStackedRequiredQuotedPhrases(query) {
  return /"[^"]+"\s+"[^"]+"\s+"[^"]+"/.test(String(query || ''));
}

// ── Source contracts ──────────────────────────────────────────────────────
describe('signalHunt source contracts (ICP-first query priority)', () => {
  const src = service('services/signalHunt.js');
  const dbBuilderSrc = service('services/dbBuilder.js');
  const industriesFnStart = src.indexOf('function industriesFromIcp');
  const industriesFnEnd = src.indexOf('function hasIcpSearchScope', industriesFnStart);
  const industriesFn = src.slice(industriesFnStart, industriesFnEnd);

  it('uses one authoritative query source and rejects stale stored config', () => {
    expect(src).toContain('const staticIcpQueries = hasIcpSearchScope(icp) ? buildSignalQueriesFromIcp(icp) : []');
    expect(src).toContain('const dynamicIcpQueries = hasIcpSearchScope(icp) ? await buildDynamicSignalQueriesFromIcp(clientId, icp) : []');
    expect(src).toContain('const icpQueries = [...dynamicIcpQueries, ...staticIcpQueries]');
    expect(src).toContain('function trustedSignalHuntConfigContent');
    expect(src).toContain('rejected_config_source');
    expect(src).toContain('active_tenant_profile_buying_signals');
    expect(src).toContain('tenant_profile_blocked');
    expect(src).toContain('legacy_current_icp_signal_planner');
    expect(src).not.toContain('...icpQueries, ...configuredQueries');
    expect(src).not.toContain('current_icp_signal_planner_then_config');
  });

  it('uses the full ICP and does not slice to the first three industries', () => {
    expect(src).toContain('function industriesFromIcp');
    expect(industriesFn).not.toContain('.slice(0, 3)');
    expect(src).not.toContain('function industryPriority');
    expect(industriesFn).not.toContain('industryPriority');
  });

  it('trusts stored signal_hunt_config only when bound to the active tenant profile version', () => {
    expect(signalHunt._test.trustedSignalHuntConfigContent({
      tenant_profile_content_version: 5,
      signal_queries: [{ query: 'trusted query' }],
    }, { content_version: 5 })).toBe(true);

    expect(signalHunt._test.trustedSignalHuntConfigContent({
      signal_queries: [{ query: 'stale April query' }],
    }, { content_version: 5 })).toBe(false);
  });

  it('labels active tenant profile queries and blocks invalid active profiles instead of falling back', () => {
    expect(signalHunt._test.querySourceForSignalConfig({
      source: 'tenant_profiles',
      content_version: 5,
    }, { icpQueryCount: 2, configuredQueryCount: 0 })).toBe('active_tenant_profile_buying_signals');

    expect(signalHunt._test.querySourceForSignalConfig({
      source: 'tenant_profiles',
      content_version: 5,
    }, { icpQueryCount: 0, configuredQueryCount: 0, tenantProfileBlocked: true })).toBe('tenant_profile_blocked');

    expect(signalHunt._test.querySourceForSignalConfig({}, {
      icpQueryCount: 2,
      configuredQueryCount: 0,
    })).toBe('legacy_current_icp_signal_planner');
  });

  it('keeps bounded query windows on planner source channels instead of agency publication fallbacks', () => {
    const queries = signalHunt._test.buildSignalQueriesFromIcp({
      active_industries: [
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
    const firstSix = queries.slice(0, 6);
    const firstSixText = firstSix.map(q => q.query.toLowerCase()).join('\n');
    const firstSixIndustries = firstSix.map(q => q.industry || '').join('\n');
    const firstSixChannels = queries.slice(0, 6).map(q => q.source_channel);
    const firstTwelveChannels = queries.slice(0, 12).map(q => q.source_channel);
    const allQueries = queries.map(q => q.query).join('\n');

    expect(firstSixIndustries).toMatch(/training|l&d|coaching|skills development/);
    expect(firstSixIndustries).toMatch(/agenc|content studio|pr firm|creative studio/);
    expect(firstSixText).not.toMatch(/"[^"]+"\s+"[^"]+"\s+"[^"]+"/);
    expect(firstSixChannels).toEqual(expect.arrayContaining(['linkedin_jobs', 'press', 'investor_pages']));
    expect(new Set(firstSixChannels).size).toBeGreaterThan(3);
    expect(queries.map(q => q.source_channel)).toEqual(expect.arrayContaining(['review_sites', 'job_descriptions']));
    expect(firstTwelveChannels).not.toContain('industry_publication');
    expect(allQueries).not.toMatch(/marketing-interactive|marketingmagazine|campaignasia|digitalnewsasia/i);
  });

  it('uses universal planner source-channel queries without stored publication fallback injection for MY/SG', () => {
    const queries = signalHunt._test.buildSignalQueriesFromIcp({
      active_industries: ['digital agencies', 'marketing agencies', 'B2B corporate training'],
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
    expect(queries.every(q => !hasThreeStackedRequiredQuotedPhrases(q.query))).toBe(true);
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
      active_industries: ['B2B corporate training', 'professional training', 'L&D providers'],
      exclusions: ['Leo Burnett'],
      competitor_offers: ['lead generation', 'AI outbound'],
    });

    expect(gate).toMatchObject({
      pass: false,
      blocker: 'icp_zero_after_company_extract',
      reason: 'missing_company_icp_evidence',
    });
  });

  it.each([
    'Resume Box',
    'Resume-Library',
    'CV-Library',
    'Foundit',
    'Wobb',
    'Naukri',
    'JobsDB',
  ])('rejects career-platform names before company enrichment: %s', (company) => {
    expect(signalHunt._test.validSignalCompanyName(company)).toBe(false);
  });

  it.each([
    'Shah Alam',
    'Petaling Jaya',
    'Cyberjaya',
    'Kuala Lumpur',
    'Subang Jaya',
    'Klang',
    'Putrajaya',
    'Johor Bahru',
    'Penang',
    'Greater Kuala Lumpur',
    'Klang Valley',
  ])('rejects location-only names before company enrichment: %s', (company) => {
    expect(signalHunt._test.validSignalCompanyName(company)).toBe(false);
  });

  it('keeps real companies valid after career/location blocklists', () => {
    expect(signalHunt._test.validSignalCompanyName('Acme Learning Sdn Bhd')).toBe(true);
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
      active_industries: ['B2B corporate training', 'professional training', 'L&D providers'],
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
      active_industries: ['B2B corporate training'],
      banned_regex: ['Leo Burnett'],
    })).toMatchObject({
      pass: false,
      blocker: 'icp_zero_after_company_extract',
      reason: 'tenant_exclusion_matched',
      matched_terms: ['Leo Burnett'],
    });

    const pipelineProsGate = signalHunt._test.evaluateSignalCompanyIcpGate({
      company: 'Pipeline Pros',
      signal_summary: 'Pipeline Pros is a lead generation agency hiring SDRs.',
      raw_snippet: 'Lead generation agency hiring sales development reps',
    }, {
      verticals: ['B2B corporate training'],
      active_industries: ['B2B corporate training'],
      competitor_offers: ['lead generation'],
    });
    // Genuine lead-gen agency: blocked on the hard competitor check (configured
    // competitor_offers + service-shaped "lead generation agency" wording),
    // before vertical confirmation.
    expect(pipelineProsGate).toMatchObject({
      pass: false,
      blocker: 'competitor_offer_disqualified',
      reason: 'competitor_offer_matched',
    });
    expect(pipelineProsGate.matched_terms).toEqual(expect.arrayContaining(['lead generation']));
  });

  it('runs the company ICP gate (LLM read or regex) before decision-maker lookup and email enrichment', () => {
    const runStart = src.indexOf('async function runSignalHunt');
    // Vertical-first qualifies via the Research Beaver read; signal-first via the regex gate.
    const verticalGateIdx = src.indexOf('qualifyCompanyByReading({', runStart);
    const signalGateIdx = src.indexOf('companyGate = evaluateSignalCompanyIcpGate', runStart);
    const decisionMakerIdx = src.indexOf('findDecisionMaker(signal.company', runStart);
    const emailIdx = src.indexOf('const enriched = await findEmail', runStart);

    expect(verticalGateIdx).toBeGreaterThan(runStart);
    expect(signalGateIdx).toBeGreaterThan(runStart);
    // Both qualification gates run before the paid decision-maker lookup and enrichment.
    expect(verticalGateIdx).toBeLessThan(decisionMakerIdx);
    expect(signalGateIdx).toBeLessThan(decisionMakerIdx);
    expect(decisionMakerIdx).toBeLessThan(emailIdx);
  });

  it('uses the market-sensor parser for industry publication snippets', () => {
    expect(src).toContain('function signalExtractionAgent');
    expect(src).toContain("return 'market_sensor'");
    expect(src).toContain('const agentKey = signalExtractionAgent(query)');
    expect(src).toContain('callAgent(agentKey');
  });

  it('does not rank agency and professional services ahead of focus industries', () => {
    expect(src).not.toContain('function industryPriority');
    expect(src).not.toContain('industryPriority(a) - industryPriority(b)');
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
    expect(src).toContain('function signalPaidBudgetSplit(maxPaidQueries = null, maxLeads = 1, { verticalFirst = false } = {})');
    expect(src).toContain('function shouldStopSignalDiscovery');
    expect(src).toContain('shouldStopSignalDiscovery({ discoveryQueriesRun, paidQueryBudget })');
    expect(src).toContain('Discovery-query budget reached; reserving paid budget for decision-maker lookup');
    expect(src).toContain('lookup_query_budget');

    // Signal-first (default) split: lookup capped at min(target, total/2).
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

  it('biases the lookup share UP for vertical-first runs so wider gate survivors are not starved', () => {
    // Same total budget as signal-first, more reserved for decision-maker lookup.
    const verticalSplit = signalHunt._test.signalPaidBudgetSplit(10, 5, { verticalFirst: true });
    const signalSplit = signalHunt._test.signalPaidBudgetSplit(10, 5);
    expect(verticalSplit.lookup).toBeGreaterThan(signalSplit.lookup);
    // Vertical-first lookup is capped at min(target*2, ceil(total*0.6)) so it
    // doesn't starve discovery either.
    expect(verticalSplit.lookup).toBeLessThanOrEqual(Math.ceil(10 * 0.6));
    expect(verticalSplit.discovery + verticalSplit.lookup).toBe(verticalSplit.total);
  });

  it('keeps signal-first budget split unchanged (regression guard)', () => {
    expect(signalHunt._test.signalPaidBudgetSplit(10, 5)).toEqual({
      total: 10,
      discovery: 5,
      lookup: 5,
    });
  });

  it('surfaces google_cse cap=0 upfront for vertical-first runs (not buried inside the lookup)', () => {
    const runStart = src.indexOf('async function runSignalHunt');
    const warnIdx = src.indexOf("'provider_capacity_warning'", runStart);
    const discoveryLoop = src.indexOf('// Step 1: Run all signal queries', runStart);
    expect(warnIdx).toBeGreaterThan(runStart);
    expect(warnIdx).toBeLessThan(discoveryLoop);
    expect(src).toContain('google_cse_cap_zero_for_vertical_first');
    expect(src).toContain('decision_maker_providers');
  });

  it('does not stop discovery just because off-ICP raw candidates filled the lead buffer', () => {
    expect(typeof signalHunt._test.shouldStopSignalDiscovery).toBe('function');
    expect(signalHunt._test.shouldStopSignalDiscovery({
      rawCandidatesCount: 10,
      maxLeads: 5,
      discoveryQueriesRun: 5,
      paidQueryBudget: { discovery: 13 },
    })).toBe(false);
    expect(signalHunt._test.shouldStopSignalDiscovery({
      rawCandidatesCount: 10,
      maxLeads: 5,
      discoveryQueriesRun: 13,
      paidQueryBudget: { discovery: 13 },
    })).toBe(true);
  });

  it('bounds Signal Hunt email-enrichment provider fanout', () => {
    expect(src).toContain('function signalProviderFanoutCaps(maxPaidQueries = null, maxLeads = 1)');
    expect(src).toContain('const providerFanoutCaps = signalProviderFanoutCaps(maxPaidQueries, maxLeads)');
    expect(src).toContain('maxDomainSearches: providerFanoutCaps.maxDomainSearchesPerLead');
    expect(src).toContain('maxAnymailCalls: providerFanoutCaps.maxAnymailCallsPerLead');
    expect(src).toContain('maxIcypeasCalls: providerFanoutCaps.maxIcypeasCallsPerLead');
    expect(src).toContain('maxSnovCalls: providerFanoutCaps.maxSnovCallsPerLead');
    expect(src).toContain('maxHunterCalls: providerFanoutCaps.maxHunterCallsPerLead');
    expect(src).toContain('maxVerifierCalls: providerFanoutCaps.maxVerifierCallsPerLead');
    expect(src).toContain('provider_fanout_caps');

    expect(signalHunt._test.signalProviderFanoutCaps(17, 5)).toEqual({
      maxDomainSearchesPerLead: 0,
      maxAnymailCallsPerLead: 1,
      maxIcypeasCallsPerLead: 1,
      maxSnovCallsPerLead: 1,
      maxHunterCallsPerLead: 1,
      maxVerifierCallsPerLead: 3,
      maxEnrichmentLeads: 5,
    });
    expect(signalHunt._test.signalProviderFanoutCaps(0, 5)).toEqual({
      maxDomainSearchesPerLead: 0,
      maxAnymailCallsPerLead: 0,
      maxIcypeasCallsPerLead: 0,
      maxSnovCallsPerLead: 0,
      maxHunterCallsPerLead: 0,
      maxVerifierCallsPerLead: 0,
      maxEnrichmentLeads: 0,
    });
    expect(signalHunt._test.signalProviderFanoutCaps(null, 20)).toEqual({
      maxDomainSearchesPerLead: 0,
      maxAnymailCallsPerLead: 1,
      maxIcypeasCallsPerLead: 1,
      maxSnovCallsPerLead: 1,
      maxHunterCallsPerLead: 1,
      maxVerifierCallsPerLead: 3,
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
      active_industries: [
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
    const combined = executable.map(q => `${q.signal_type} ${q.industry || ''} ${q.query}`).join('\n');

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
    expect(src).toContain('signal_hunt_zero_query_set_${klDateString()}_${SIGNAL_HUNT_PARSER_VERSION}_${hash}');
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
      company_website: 'https://acmetraining.com',
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
        company_icp_fit: {
          vertical_match: 'B2B corporate training',
          icp_evidence: ['B2B corporate training'],
          reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
        },
        source: 'signal_hunt',
      },
    }, { evidenceDate: '2026-06-03' });

    expect(packaged.metadata.signal_package).toMatchObject({
      signal_id: 'hiring_sales',
      signal_family: 'hiring_capability_build',
      source_channel: 'web_search',
      source_url: 'https://www.linkedin.com/jobs/view/123',
      company_website: 'https://acmetraining.com',
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

  it('packages vertical-first company discoveries as signal-lite leads without dropping them', () => {
    expect(typeof signalHunt._test.isVerticalFirstPlatformPlan).toBe('function');
    expect(typeof signalHunt._test.verticalFirstSignalsFromResults).toBe('function');

    const platformPlan = {
      mode: 'proof',
      discovery_mode: 'vertical_first',
    };
    expect(signalHunt._test.isVerticalFirstPlatformPlan(platformPlan)).toBe(true);

    const signals = signalHunt._test.verticalFirstSignalsFromResults([
      {
        title: 'Acme Digital - Marketing Agency Malaysia',
        link: 'https://acme.example/about',
        snippet: 'Acme Digital is a Malaysia marketing agency serving B2B companies.',
      },
      {
        title: 'Beta Training Provider',
        url: 'https://beta.example',
        snippet: 'Corporate training provider for Malaysian sales teams.',
      },
    ], {
      query: '"marketing agency" Malaysia',
      platform: 'agency_directory',
      provider: 'brave',
      country: 'MY',
      source_channel: 'vertical_directory',
      platform_plan_id: 'plan-1',
      source_term: 'marketing agency',
      expected_evidence: ['company', 'vertical_evidence', 'source_url'],
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      company: 'Acme Digital',
      signal_id: 'vertical_first_discovery',
      signal_family: 'vertical_first_discovery',
      signal_lite: true,
      discovery_lane: 'vertical_first',
      platform: 'agency_directory',
      provider: 'brave',
      country: 'MY',
    });
    expect(signals[0].signal_summary).toContain('vertical-first company discovery');
    expect(signals[0].metadata).toMatchObject({
      signal_lite: true,
      discovery_lane: 'vertical_first',
      platform: 'agency_directory',
      source_term: 'marketing agency',
    });

    const packaged = signalHunt._test.attachSignalPackageToSignalLead({
      name: 'Jane Tan',
      title: 'Founder',
      company: 'Acme Digital',
      linkedin_url: 'https://www.linkedin.com/in/janetan',
      data_source: 'signal_hunt',
      metadata: {
        signal_id: 'vertical_first_discovery',
        signal_family: 'vertical_first_discovery',
        source_channel: 'vertical_directory',
        platform: 'agency_directory',
        provider: 'brave',
        platform_plan_id: 'plan-1',
        source_url: 'https://acme.example/about',
        evidence: 'Acme Digital is a Malaysia marketing agency serving B2B companies.',
        signal: 'Signal-lite vertical-first company discovery for Acme Digital.',
        why_now: 'Signal-lite vertical-first company discovery.',
        signal_lite: true,
        discovery_lane: 'vertical_first',
        country: 'Malaysia',
        industry_match: 'marketing agency',
        icp_evidence: ['marketing agency'],
        reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
      },
    });

    expect(packaged.metadata.signal_package).toMatchObject({
      signal_id: 'vertical_first_discovery',
      signal_family: 'vertical_first_discovery',
      source_channel: 'vertical_directory',
      signal_lite: true,
      discovery_lane: 'vertical_first',
      source_url: 'https://acme.example/about',
      company_icp_fit: {
        vertical_match: 'marketing agency',
      },
    });
    expect(signalHunt._test.signalPackageMissingFields(packaged.metadata.signal_package)).toEqual([]);

    const runStart = src.indexOf('async function runSignalHunt');
    const verticalBranch = src.indexOf('verticalFirstSignalsFromResults', runStart);
    const extractBranch = src.indexOf('extractSignalsFromResults(clientId', runStart);
    expect(verticalBranch).toBeGreaterThan(runStart);
    expect(verticalBranch).toBeLessThan(extractBranch);
  });

  it('skips listicle/directory results and anchors vertical-first candidates on the company domain', () => {
    const signals = signalHunt._test.verticalFirstSignalsFromResults([
      // Real company homepage with an SEO-y title (the 2026-06-09 failure shape).
      { title: "Malaysia's Leading Corporate Training Providers", link: 'https://thrivingtalents.com/', snippet: 'We are a corporate training provider in Malaysia.' },
      // Listicle — must be skipped, not treated as a company.
      { title: 'Top 10 Corporate Training Providers in Malaysia 2026', link: 'https://corporatetrainingmalaysia.com/top-training-providers-malaysia', snippet: 'A verified list of providers.' },
      // Second result from the same domain — deduped.
      { title: 'Thriving Talents Courses', link: 'https://thrivingtalents.com/courses', snippet: 'Our corporate training courses.' },
      // Another real company.
      { title: 'In House Corporate Training', link: 'https://mmt.my/', snippet: 'Corporate training company.' },
    ], {
      query: '"corporate training" Malaysia',
      platform: 'training_directory',
      provider: 'brave',
      country: 'MY',
      source_channel: 'vertical_directory',
      signal_id: 'vertical_first_discovery',
      signal_family: 'vertical_first_discovery',
      source_term: 'B2B corporate training',
    });

    // Listicle dropped + same-domain duplicate dropped => 2 unique companies.
    expect(signals).toHaveLength(2);
    const domains = signals.map(s => s.domain).sort();
    expect(domains).toEqual(['mmt.my', 'thrivingtalents.com']);
    for (const s of signals) {
      expect(s.company_website).toMatch(/^https?:\/\//);
      expect(s.domain).not.toContain('corporatetrainingmalaysia');
    }
  });

  it('lifts max_results_per_query for vertical-first plans so SMEs surface past top-3 giants', () => {
    const baseConfig = { queries: [], max_results_per_query: 3, query_source: 'icp' };
    const verticalPlan = {
      id: 'plan-vertical',
      mode: 'proof',
      requested_mode: 'vertical_first',
      discovery_mode: 'vertical_first',
      platform_sequence: [{
        platform: 'agency_directory', provider: 'brave', source_channel: 'vertical_directory',
        discovery_mode: 'vertical_first', signal_id: 'vertical_first_discovery',
        signal_family: 'vertical_first_discovery', source_term: 'marketing agency',
        query: '"marketing agency" Malaysia', country: 'MY',
        query_validation: { valid: true, chars: 30, words: 3 },
      }],
    };
    const verticalConfig = signalHunt._test.applyApprovedPlatformPlanToConfig(baseConfig, verticalPlan);
    expect(verticalConfig.max_results_per_query).toBe(signalHunt._test.MAX_VERTICAL_RESULTS_PER_QUERY);
    expect(verticalConfig.max_results_per_query).toBeGreaterThanOrEqual(10);
    expect(verticalConfig.query_source).toBe('approved_platform_plan');
    expect(verticalConfig.approved_platform_plan.discovery_mode).toBe('vertical_first');
  });

  it('keeps signal-first plans at the normal results-per-query cap', () => {
    const baseConfig = { queries: [], max_results_per_query: 3, query_source: 'icp' };
    const signalPlan = {
      id: 'plan-signal',
      mode: 'proof',
      requested_mode: 'proof',
      discovery_mode: 'signal_first',
      platform_sequence: [{
        platform: 'jobstreet_my', provider: 'brave', source_channel: 'linkedin_jobs',
        discovery_mode: 'signal_first', signal_id: 'hiring_sales_roles',
        signal_family: 'hiring_capability_build',
        query: 'site:my.jobstreet.com "sales executive" Malaysia', country: 'MY',
        query_validation: { valid: true, chars: 50, words: 5 },
      }],
    };
    const signalConfig = signalHunt._test.applyApprovedPlatformPlanToConfig(baseConfig, signalPlan);
    expect(signalConfig.max_results_per_query).toBe(3);
    expect(signalConfig.max_results_per_query).toBeLessThan(signalHunt._test.MAX_VERTICAL_RESULTS_PER_QUERY);
  });

  it('signal-first keeps the shared company-shape gate (name+snippet) before paid lookup', () => {
    const runStart = src.indexOf('async function runSignalHunt');
    const shapeCheckIdx = src.indexOf('companyShapeRejection([signal.company, signal.raw_snippet, signal.signal_summary]', runStart);
    const consumeForLookupIdx = src.indexOf("'paid_query_budget_exhausted_before_decision_maker_lookup'", runStart);
    expect(shapeCheckIdx).toBeGreaterThan(runStart);
    expect(shapeCheckIdx).toBeLessThan(consumeForLookupIdx);
    expect(src).toContain('company_shape_pre_lookup');
  });

  it('widens the candidate loop for vertical-first runs so gate-passing SMEs are not truncated', () => {
    // Source-level assertion: the candidate loop slice is widened only when
    // verticalFirstExecution is true.
    expect(src).toContain('const candidateLoopCap = verticalFirstExecution');
    expect(src).toContain('Math.max(maxLeads * 4, 12)');
    expect(src).toContain('uniqueSignals.slice(0, candidateLoopCap)');
    // And the candidate loop existed before this change (regression guard).
    expect(src.indexOf('candidateLoopCap')).toBeGreaterThan(src.indexOf('async function runSignalHunt'));
  });

  describe('Research Beaver reads the page (vertical-first qualification)', () => {
    const icp = { active_industries: ['marketing agency', 'B2B corporate training'], geo: ['MY'] };
    const q = signalHunt._test.qualifyCompanyByReading;

    it('qualifies a real in-ICP MY SME read from the page', async () => {
      const mock = async () => ({
        is_real_company: true, company_name: 'Thriving Talents', in_icp_vertical: true,
        vertical_match: 'B2B corporate training', employee_band: '11-50', geo_ok: true,
        is_competitor: false, is_directory: false,
        decision_maker: { name: 'Alexandre Hanszmann', title: 'Founder' }, reason: 'MY corporate training SME',
      });
      const v = await q({ company: 'x', url: 'https://thrivingtalents.com', pageText: 'corporate training provider in Malaysia', icp, callAgentImpl: mock });
      expect(v.qualified).toBe(true);
      expect(v.company_name).toBe('Thriving Talents');
      expect(v.decision_maker).toMatchObject({ name: 'Alexandre Hanszmann' });
    });

    it('drops a directory / listicle (is_directory) instead of saving it as a company', async () => {
      const mock = async () => ({ is_real_company: false, is_directory: true, in_icp_vertical: true, employee_band: 'unknown', reason: 'listicle' });
      const v = await q({ company: 'x', url: 'https://corporatetrainingmalaysia.com/top-providers', pageText: 'Top 10 providers', icp, callAgentImpl: mock });
      expect(v.qualified).toBe(false);
    });

    it('drops a global/enterprise brand on employee band (200+)', async () => {
      const mock = async () => ({ is_real_company: true, company_name: 'Invensis', in_icp_vertical: true, employee_band: '200+', geo_ok: true, reason: 'global brand' });
      const v = await q({ company: 'x', pageText: 'global training company', icp, callAgentImpl: mock });
      expect(v.qualified).toBe(false);
    });

    it('does NOT disqualify an SME that merely serves government clients', async () => {
      const mock = async () => ({ is_real_company: true, company_name: 'Crossurvive', in_icp_vertical: true, vertical_match: 'B2B corporate training', employee_band: '11-50', geo_ok: true, is_competitor: false, is_directory: false, decision_maker: { name: null, title: null }, reason: 'SME that trains govt clients' });
      const v = await q({ company: 'x', pageText: 'We deliver corporate training to government agencies and GLCs across Malaysia', icp, callAgentImpl: mock });
      expect(v.qualified).toBe(true);
      expect(v.company_name).toBe('Crossurvive');
    });

    it('surfaces an LLM failure instead of silently falling back to regex', async () => {
      const mock = async () => { throw new Error('openai 400 bad model'); };
      const v = await q({ company: 'x', pageText: 'something', icp, callAgentImpl: mock });
      expect(v.error).toMatch(/research_beaver_read_failed/);
      expect(v.qualified).toBeUndefined();
    });

    it('vertical-first loop calls Research Beaver to read + judge, and surfaces LLM failures', () => {
      const runStart = src.indexOf('async function runSignalHunt');
      const verticalBranch = src.indexOf('isVerticalFirstCandidate', runStart);
      const readCall = src.indexOf('qualifyCompanyByReading({', runStart);
      expect(verticalBranch).toBeGreaterThan(runStart);
      expect(readCall).toBeGreaterThan(verticalBranch);
      // Commit 2: LLM failure is surfaced, not swallowed into regex.
      expect(src).toContain('research_beaver_llm_failed');
      expect(src).toContain('research_beaver_disqualified');
      // Final ICP net runs on the clean Brave snippet, not homepage prose.
      expect(src).toContain('snippet: signal.raw_snippet');
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
      signal_type: 'leadership_change',
      signal_family: 'leadership_org_change',
      source_channel: 'press',
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

  it('deterministically extracts active-profile press expansion and leadership signals the LLM can miss', () => {
    const results = [
      {
        title: 'PRecious Communications names first regional COO, expands leadership remit in Malaysia | Marketing-Interactive',
        link: 'https://www.marketing-interactive.com/precious-communications-names-first-regional-coo-expands-leadership-remit-in-malaysia',
        date: 'November 6, 2025',
      },
      {
        title: 'Ruder Finn Asia Group Appoints General Manager of Ruder Finn Malaysia - MARKETING Magazine Asia',
        link: 'https://archive.marketingmagazine.com.my/ruder-finn-asia-group-appoints-general-manager-of-ruder-finn-malaysia/',
      },
    ];

    const leadership = signalHunt._test.deterministicPublicationSignals(results, {
      signal_type: 'leadership_change',
      signal_family: 'leadership_org_change',
      source_channel: 'press',
      country: 'MY',
    });

    expect(leadership.map(s => s.company)).toEqual(['PRecious Communications', 'Ruder Finn Malaysia']);
    expect(leadership.every(s => s.signal_type === 'leadership_change')).toBe(true);
    expect(leadership.every(s => s.confidence >= 0.5 && s.source_url)).toBe(true);
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

  it('deterministically extracts roofing companies from Indeed job result titles', () => {
    const results = [
      {
        title: 'Roofing Sales Representative - Apex Roofing & Restoration | Indeed',
        link: 'https://www.indeed.com/viewjob?jk=abc123',
        snippet: 'Dallas, TX. Apex Roofing & Restoration is hiring a roofing sales representative.',
        date: '2 days ago',
      },
      {
        title: 'Roofing Project Manager at North Star Roofing | Indeed',
        link: 'https://www.indeed.com/viewjob?jk=def456',
        snippet: 'Phoenix, AZ. North Star Roofing is hiring a project manager for roofing crews.',
        date: '1 day ago',
      },
      {
        title: 'Roofing jobs in United States | Indeed',
        link: 'https://www.indeed.com/q-roofing-jobs.html',
        snippet: 'Browse roofing jobs from many employers.',
      },
    ];

    const signals = signalHunt._test.deterministicHiringSignals(results, {
      signal_type: 'roofing_hiring_sales_ops',
      source_channel: 'job_boards',
      country: 'US',
    });

    expect(signals.map(s => s.company)).toEqual(['Apex Roofing & Restoration', 'North Star Roofing']);
    expect(signals.every(s => s.source_url.includes('indeed.com/viewjob'))).toBe(true);
    expect(signals[0]).toMatchObject({
      signal_type: 'roofing_hiring_sales_ops',
      confidence: 0.68,
    });
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
    expect(signalHunt._test.validSignalCompanyName('Apr 2026')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('May 2026')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('Least 5 Months')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('for')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('Hays UK')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('Michael Page')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('Allura Asia')).toBe(true);
    expect(signalHunt._test.validSignalCompanyName('JustSimple Malaysia')).toBe(true);
  });

  it('rejects invalid decision-maker fragments before contact persistence', () => {
    expect(typeof signalHunt._test.validDecisionMakerName).toBe('function');
    expect(signalHunt._test.validDecisionMakerName('insights. Compare pay for')).toBe(false);
    expect(signalHunt._test.validDecisionMakerName('Led Business')).toBe(false);
    expect(signalHunt._test.validDecisionMakerName('agreed we')).toBe(false);
    expect(signalHunt._test.validDecisionMakerName('Jane Tan')).toBe(true);
    expect(signalHunt._test.validDecisionMakerName('Michael Jerry')).toBe(true);
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
    const r = signalHunt._test.buildSignalQueriesFromIcp({
      verticals: ['B2B corporate training', 'professional training', 'L&D providers', 'digital agency'],
      active_industries: ['B2B corporate training', 'professional training', 'L&D providers', 'digital agency'],
      geographies: ['Malaysia'],
    });
    expect(r.some(q => q.industry === 'digital agency')).toBe(true);
    expect(r.every(q => !q.query.includes('"digital agency"'))).toBe(true);
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
      active_industries: ['B2B corporate training', 'digital agencies'],
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
    expect(r.every(q => !hasThreeStackedRequiredQuotedPhrases(q.query))).toBe(true);
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
