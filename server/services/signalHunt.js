'use strict';

/**
 * ============================================================
 * SIGNAL HUNT — Phase C: Signal-First Lead Generation
 * ============================================================
 *
 * Philosophy: signal is the INPUT, not a filter.
 *
 * Flow:
 *   1. Load signal_hunt_config from agent_memory for the client
 *      (or fall back to sensible defaults based on ICP)
 *   2. Run planner-built source-channel queries across universal signal families
 *   3. Use Haiku to parse company name + signal summary from each result
 *   4. For each extracted company, run LinkedIn people search to find founder/decision-maker
 *   5. Enrich with Hunter first, then MillionVerifier-backed pattern fallback
 *   6. Return leads with P1 tag + signal + why_now + angle
 *
 * These leads become the FIRST batch the outreach pipeline processes
 * before falling back to cold research.
 */

const pool = require('../db/pool');
const logsService = require('./logs');
const { searchOpenWeb, searchLinkedInProfiles } = require('./searchService');
const { callAgent } = require('./claude');
const { checkBudget, BudgetExceededError, isBudgetExceededError } = require('./budget');
const { attachSignalPackageToLead, signalPackageMissingFields } = require('./research');
const signalPlanner = require('./signalPlanner');
const { normalizeBuyingSignalsForTenant } = require('../config/buyingSignals');
const crypto = require('crypto');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_SIGNAL_QUERIES_PER_RUN = envInt('SIGNAL_HUNT_MAX_QUERIES', 6);
const MAX_SIGNAL_QUERY_WINDOW = Math.max(MAX_SIGNAL_QUERIES_PER_RUN, envInt('SIGNAL_HUNT_MAX_QUERY_WINDOW', 20));
const MAX_SIGNAL_RESULTS_PER_QUERY = envInt('SIGNAL_HUNT_RESULTS_PER_QUERY', 3);
const SIGNAL_HUNT_PARSER_VERSION = 'universal_signal_planner_v2';

function klDateString() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function signalQuerySetHash(queries = []) {
  const canonical = queries
    .map(q => `${String(q.country || '').toUpperCase()}|${String(q.signal_type || '')}|${String(q.query || '').trim().toLowerCase()}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(`${SIGNAL_HUNT_PARSER_VERSION}\n${canonical}`).digest('hex').slice(0, 16);
}

function signalQueryWindow(maxPaidQueries = null) {
  const n = Number(maxPaidQueries);
  const paidQueryBudget = Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : MAX_SIGNAL_QUERIES_PER_RUN;
  return Math.max(1, Math.min(MAX_SIGNAL_QUERY_WINDOW, Math.max(MAX_SIGNAL_QUERIES_PER_RUN, paidQueryBudget)));
}

function signalPaidBudgetSplit(maxPaidQueries = null, maxLeads = 1) {
  if (maxPaidQueries === null || maxPaidQueries === undefined || maxPaidQueries === '') {
    return { total: null, discovery: null, lookup: null };
  }

  const n = Number(maxPaidQueries);
  if (!Number.isFinite(n) || n <= 0) {
    return { total: 0, discovery: 0, lookup: 0 };
  }

  const total = Math.max(0, Math.floor(n));
  const target = Math.max(1, Math.ceil(Number(maxLeads) || 1));
  const lookup = Math.max(1, Math.min(target, Math.floor(total / 2)));
  return {
    total,
    discovery: Math.max(0, total - lookup),
    lookup,
  };
}

function signalProviderFanoutCaps(maxPaidQueries = null, maxLeads = 1) {
  const paidQueryBudget = signalPaidBudgetSplit(maxPaidQueries, maxLeads);
  const target = Math.max(1, Math.ceil(Number(maxLeads) || 1));
  const lookup = paidQueryBudget.lookup === null || paidQueryBudget.lookup === undefined
    ? target
    : Math.max(0, Math.min(target, Math.floor(Number(paidQueryBudget.lookup) || 0)));
  const perLeadPaidEnrichment = lookup > 0 ? 1 : 0;

  return {
    maxDomainSearchesPerLead: 0,
    maxHunterCallsPerLead: perLeadPaidEnrichment,
    maxVerifierCallsPerLead: perLeadPaidEnrichment,
    maxEnrichmentLeads: lookup,
  };
}

function providerFanoutCapsLog(caps) {
  return {
    max_domain_searches_per_lead: caps.maxDomainSearchesPerLead,
    max_hunter_calls_per_lead: caps.maxHunterCallsPerLead,
    max_verifier_calls_per_lead: caps.maxVerifierCallsPerLead,
    max_enrichment_leads: caps.maxEnrichmentLeads,
  };
}

function executableDiscoveryQueriesForBudget(queries = [], paidQueryBudget = {}) {
  if (!Array.isArray(queries)) return [];
  const discovery = paidQueryBudget?.discovery;
  if (discovery === null || discovery === undefined) return queries;
  const limit = Math.max(0, Math.floor(Number(discovery) || 0));
  return queries.slice(0, limit);
}

async function blockedByRepeatedZeroQuerySet(clientId, queries = []) {
  const hash = signalQuerySetHash(queries);
  const key = `signal_hunt_zero_query_set_${klDateString()}_${hash}`;
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'research_beaver' AND key = $2
     LIMIT 1`,
    [clientId, key]
  );
  if (rows.length === 0) return { blocked: false, key, hash };

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'signal_hunt_zero_query_set_blocked',
    metadata: {
      key,
      query_set_hash: hash,
      parser_version: SIGNAL_HUNT_PARSER_VERSION,
      blocker: 'repeated_zero_output_query_set',
      previous: rows[0].content || null,
    },
  }).catch(() => {});
  return { blocked: true, key, hash, previous: rows[0].content || null };
}

async function rememberZeroQuerySet(clientId, { key, hash, queries, queriesRun, rawResultsTotal, blocker }) {
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
     VALUES ($1, 'research_beaver', $2, $3::jsonb, 'pattern', NOW())
     ON CONFLICT (client_id, agent, key) DO NOTHING`,
    [
      clientId,
      key,
      JSON.stringify({
        query_set_hash: hash,
        blocker,
        parser_version: SIGNAL_HUNT_PARSER_VERSION,
        queries_run: queriesRun,
        raw_results_total: rawResultsTotal,
        queries_preview: queries.map(q => q.query).slice(0, queriesRun),
        recorded_at: new Date().toISOString(),
      }),
    ]
  );
}

async function assertLlmBudgetOpen(clientId) {
  const budget = await checkBudget(clientId);
  if (!budget.allowed) {
    throw new BudgetExceededError({
      clientId,
      spend: budget.spend,
      budget: budget.budget,
      period: budget.period,
    });
  }
  return budget;
}

// Default signal queries — used when no client-specific config exists.
// Phrased as Google search queries with SEA/MY bias.
const DEFAULT_SIGNAL_QUERIES = [
  // Hiring signals (strongest — means they're scaling)
  { query: '"hiring" "sales" "Malaysia" site:linkedin.com/jobs', signal_type: 'hiring_sales', tier: 'P1' },
  { query: '"hiring" "marketing" "Kuala Lumpur"', signal_type: 'hiring_marketing', tier: 'P1' },
  { query: '"hiring" "growth" OR "revops" Malaysia', signal_type: 'hiring_growth', tier: 'P1' },

  // Funding signals
  { query: '"raised" "Malaysia" "Series A" OR "seed round" 2026', signal_type: 'funding', tier: 'P1' },
  { query: '"Malaysia" startup "raised" OR "closed" funding 2026', signal_type: 'funding', tier: 'P1' },

  // Launch / expansion signals
  { query: '"launched" "Malaysia" B2B 2026', signal_type: 'launch', tier: 'P2' },
  { query: '"Malaysia" "expanding" OR "expansion" 2026', signal_type: 'expansion', tier: 'P2' },
  { query: '"Malaysia" "new CEO" OR "new Managing Director" 2026', signal_type: 'leadership_change', tier: 'P2' },
];

const SIGNAL_HUNT_CONFIG_KEY = 'signal_hunt_config';

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
  const raw = [
    ...listFrom(icp.geographies),
    ...listFrom(icp.geo),
    ...listFrom(icp.countries),
    ...listFrom(icp.locations),
    ...listFrom(icp.target_markets),
  ];
  const countries = raw
    .map(v => countryCodeFromText(v))
    .filter(Boolean)
    .map(code => ({ code, name: countryNameFromCode(code) }));
  const seen = new Set();
  const unique = countries.filter(c => {
    if (seen.has(c.code)) return false;
    seen.add(c.code);
    return true;
  });
  return unique.length > 0 ? unique : [{ code: 'MY', name: 'Malaysia' }];
}

function industriesFromIcp(icp = {}) {
  const industries = [
    ...listFrom(icp.industries),
    ...listFrom(icp.verticals),
    ...listFrom(icp.segments),
  ];
  const base = industries.length > 0 ? industries : ['B2B corporate training', 'digital agency'];
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

function titlesFromIcp(icp = {}) {
  return [
    ...listFrom(icp.job_titles),
    ...listFrom(icp.target_titles),
    ...listFrom(icp.titles),
    ...listFrom(icp.who),
  ]
    .map(v => String(v).trim())
    .filter(Boolean);
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
  for (const industry of industries) {
    buckets[industryBucket(industry)].push(industry);
  }
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
  const name = country.name || countryNameFromCode(country.code);
  const code = country.code || countryCodeFromText(name) || 'MY';
  const joinedIndustries = industries.join(' ').toLowerCase();
  const wantsAgency = /agency|digital|marketing|creative|media|advertising|content studio|pr firm/.test(joinedIndustries);
  const wantsTraining = /training|learning|l&d|coaching|skills|development/.test(joinedIndustries);
  const currentYear = new Date().getUTCFullYear();
  const agencyQueries = [];
  const trainingQueries = [];

  if (wantsAgency && (code === 'MY' || code === 'SG')) {
    agencyQueries.push({
      query: `site:marketing-interactive.com "${name}" ("social media agency" OR "PR agency" OR "creative agency" OR "media agency") ("appointed" OR "retainer" OR "pitch") ${currentYear}`,
      signal_type: 'industry_publication_agency_signal',
      signal_id: 'agency_client_win_or_growth',
      signal_family: 'expansion_growth',
      source_channel: 'industry_publication',
      tier: 'P1',
      country: code,
    });
    agencyQueries.push({
      query: `site:marketing-interactive.com "${name}" ("agency" OR "communications") ("launches" OR "expands" OR "enters" OR "names new leader") ${currentYear}`,
      signal_type: 'industry_publication_agency_signal',
      signal_id: 'agency_client_win_or_growth',
      signal_family: 'expansion_growth',
      source_channel: 'industry_publication',
      tier: 'P1',
      country: code,
    });
    agencyQueries.push({
      query: `site:marketingmagazine.com.my "${name}" ("agency" OR "communications") ("appoints" OR "promotes" OR "general manager" OR "CEO") ${currentYear}`,
      signal_type: 'industry_publication_agency_signal',
      signal_id: 'agency_client_win_or_growth',
      signal_family: 'leadership_org_change',
      source_channel: 'industry_publication',
      tier: 'P1',
      country: code,
    });
    agencyQueries.push({
      query: `site:marketingmagazine.com.my "${name}" ("agency" OR "communications") ("wins" OR "appointed" OR "retainer" OR "launches") ${currentYear}`,
      signal_type: 'industry_publication_agency_signal',
      signal_id: 'agency_client_win_or_growth',
      signal_family: 'expansion_growth',
      source_channel: 'industry_publication',
      tier: 'P1',
      country: code,
    });
    agencyQueries.push({
      query: `site:campaignasia.com "${name}" ("agency" OR "independent agency" OR "growth" OR "40 Under 40") ${currentYear}`,
      signal_type: 'industry_publication_agency_signal',
      signal_id: 'agency_client_win_or_growth',
      signal_family: 'expansion_growth',
      source_channel: 'industry_publication',
      tier: 'P1',
      country: code,
    });
  }

  if (wantsTraining && code === 'MY') {
    trainingQueries.push({
      query: `site:digitalnewsasia.com "${name}" ("training" OR "upskilling" OR "skills") ("launches" OR "expands" OR "partners") ${currentYear}`,
      signal_type: 'training_growth_signal',
      signal_id: 'training_growth_publication',
      signal_family: 'expansion_growth',
      source_channel: 'industry_publication',
      tier: 'P1',
      country: code,
    });
  }

  const queries = [];
  const maxLength = Math.max(agencyQueries.length, trainingQueries.length);
  for (let i = 0; i < maxLength; i++) {
    if (agencyQueries[i]) queries.push(agencyQueries[i]);
    if (trainingQueries[i]) queries.push(trainingQueries[i]);
  }
  return queries;
}

function fastProofQueriesForCountry(country = {}, industries = []) {
  const name = country.name || countryNameFromCode(country.code);
  const code = country.code || countryCodeFromText(name) || 'MY';
  const location = code === 'MY'
    ? '("Kuala Lumpur" OR "Greater Kuala Lumpur" OR "Malaysia")'
    : `"${name}"`;
  const negativeGeo = code === 'MY' ? ' -India -Delhi -NCR -Jaipur -Siliguri' : '';
  const queries = [
    {
      query: `site:linkedin.com/jobs ${location} ("Sales Executive" OR "Account Executive" OR "Business Development Manager" OR "Sales Manager")${negativeGeo}`,
      signal_type: 'hiring_sales_roles',
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'linkedin_jobs',
      tier: 'P1',
      country: code,
    },
    {
      query: `site:linkedin.com/jobs "${name}" ("business development" OR "account executive" OR "sales") ("Easy Apply" OR hiring OR vacancy)${negativeGeo}`,
      signal_type: 'hiring_sales_roles',
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'linkedin_jobs',
      tier: 'P1',
      country: code,
    },
  ];

  queries.push(...sourceAwareQueriesForCountry({ code, name }, industries));
  return queries;
}

function hasIcpSearchScope(icp = {}) {
  return [
    ...listFrom(icp.industries),
    ...listFrom(icp.verticals),
    ...listFrom(icp.segments),
    ...listFrom(icp.geographies),
    ...listFrom(icp.geo),
    ...listFrom(icp.countries),
    ...listFrom(icp.locations),
    ...listFrom(icp.target_markets),
  ].length > 0;
}

function signalPlannerTenantFromIcp(icp = {}) {
  const verticals = listFrom(icp.verticals).length > 0
    ? listFrom(icp.verticals)
    : [...listFrom(icp.industries), ...listFrom(icp.segments)];
  return {
    icp: {
      ...icp,
      verticals: diversifyIndustriesForQueryRun(verticals),
      geo: listFrom(icp.geo).length > 0
        ? listFrom(icp.geo)
        : [...listFrom(icp.geographies), ...listFrom(icp.countries), ...listFrom(icp.locations), ...listFrom(icp.target_markets)],
      competitor_offers: listFrom(icp.competitor_offers),
      exclusions: listFrom(icp.exclusions),
    },
    buying_signals: Array.isArray(icp.buying_signals) ? icp.buying_signals : undefined,
  };
}

function signalHuntQueryFromPlannerQuery(query = {}, plan = {}) {
  const country = String(query.geo || countryCodeFromText(query.query) || 'MY').toUpperCase();
  return {
    query: query.query,
    signal_type: plan.signalId,
    signal_id: plan.signalId,
    signal_family: plan.signalFamily,
    source_channel: query.sourceChannel || 'web_search',
    tier: 'P1',
    country,
    cost_class: query.costClass || 'paid_search',
    expected_evidence: query.expectedEvidence || [],
    industry: query.industry || null,
    term: query.term || null,
    source_term: query.term || null,
  };
}

function rotateQueryWindow(queries = [], offset = 0) {
  if (!Array.isArray(queries) || queries.length <= 1) return queries;
  const n = Math.abs(Number(offset) || 0) % queries.length;
  if (n === 0) return queries;
  return [...queries.slice(n), ...queries.slice(0, n)];
}

function buildSignalQueriesFromIcp(icp = {}) {
  const tenant = signalPlannerTenantFromIcp(icp);
  const signals = normalizeBuyingSignalsForTenant(tenant).filter(signal => signal.enabled !== false);
  const countryObjects = countriesFromIcp(icp);
  const countries = countryObjects.map(country => country.code);
  const industries = tenant.icp?.verticals?.length > 0 ? tenant.icp.verticals : industriesFromIcp(icp);
  const perSignalQueries = [];

  for (const [idx, signal] of signals.entries()) {
    try {
      const plan = signalPlanner.buildSignalPlan({
        tenant,
        signalId: signal.id,
        geo: countries,
        maxQueries: signal.stop_rules?.max_paid_searches_per_day || MAX_SIGNAL_QUERY_WINDOW,
      });
      const mapped = plan.queries.map(query => signalHuntQueryFromPlannerQuery(query, plan));
      perSignalQueries.push(rotateQueryWindow(mapped, idx));
    } catch (err) {
      console.warn('[signalHunt] Failed to build signal plan:', err.message);
    }
  }

  const queries = [];
  const maxLength = Math.max(0, ...perSignalQueries.map(items => items.length));
  for (let i = 0; i < maxLength; i++) {
    for (const items of perSignalQueries) {
      if (items[i]) queries.push(items[i]);
    }
  }
  const highYieldQueries = countryObjects.flatMap(country => fastProofQueriesForCountry(country, industries));
  const combined = [...queries.slice(0, 6), ...highYieldQueries, ...queries.slice(6)];
  const seen = new Set();
  return combined.filter(q => {
    const key = String(q.query || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeSignalQuery(item, fallbackCountry = 'MY') {
  const raw = typeof item === 'string' ? { query: item } : (item || {});
  const query = String(raw.query || raw.search || raw.text || '').trim();
  if (!query) return null;
  const country = String(raw.country || countryCodeFromText(query) || fallbackCountry || 'MY').toUpperCase();
  return {
    query,
    signal_id: raw.signal_id || raw.id || raw.signal,
    signal_family: raw.signal_family || raw.family,
    source_channel: raw.source_channel || raw.sourceChannel,
    signal_type: raw.signal_type || raw.type || 'buying_signal',
    tier: raw.tier || 'P2',
    country,
  };
}

function signalFamilyForType(signalType = '') {
  const s = String(signalType || '').toLowerCase();
  if (/hiring|vacancy|job|sales_role|sdr|bdr/.test(s)) return 'hiring_capability_build';
  if (/fund|grant|invest|capital|raised/.test(s)) return 'capital_budget_event';
  if (/launch|expansion|expand|growth|new_office/.test(s)) return 'expansion_growth';
  if (/leadership|appointed|new_ceo|new_cro|joined/.test(s)) return 'leadership_org_change';
  if (/ad|gtm|campaign|landing|demo|consultation/.test(s)) return 'active_gtm_spend';
  if (/vendor|category|review|compare|alternative|intent/.test(s)) return 'category_vendor_research';
  if (/stack|tech|crm|revops|migration|integration/.test(s)) return 'technology_stack_change';
  if (/regulatory|regulation|compliance|permit|deadline|audit/.test(s)) return 'regulatory_deadline_pressure';
  if (/pain|friction|manual_process|bottleneck|hard_to_scale|struggling/.test(s)) return 'pain_friction_evidence';
  if (/event|sponsor|webinar|conference|exhibitor|speaker/.test(s)) return 'event_market_presence';
  return 'buying_signal';
}

function canonicalSignalKey(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function signalMatchesPlaybook(query = {}, signalId = null) {
  if (!signalId) return true;
  const wanted = canonicalSignalKey(signalId);
  const candidates = [
    query.signal_id,
    query.signal_type,
    query.signal_family,
    signalFamilyForType(query.signal_type || query.signal_id || query.signal_family),
  ].map(canonicalSignalKey).filter(Boolean);
  if (candidates.includes(wanted)) return true;
  if (/hiring|sales_role/.test(wanted) && candidates.some(v => /hiring|sales/.test(v))) return true;
  if (/growth|expansion|launch/.test(wanted) && candidates.some(v => /growth|expansion|launch/.test(v))) return true;
  if (/capital|fund|grant|investment/.test(wanted) && candidates.some(v => /capital|fund|grant|investment/.test(v))) return true;
  if (/gtm|ad|campaign/.test(wanted) && candidates.some(v => /gtm|ad|campaign/.test(v))) return true;
  return false;
}

function queryMatchesGeo(query = {}, geo = []) {
  if (geo.length === 0) return true;
  const country = String(query.country || '').toUpperCase();
  const queryText = String(query.query || '').toLowerCase();
  return geo.some(g => {
    const code = String(g || '').toUpperCase();
    const name = countryNameFromCode(code).toLowerCase();
    return country === code || queryText.includes(code.toLowerCase()) || queryText.includes(name);
  });
}

function normalizePlaybookPlannedQuery(raw = {}, signalPlaybook = {}) {
  const query = String(raw.query || raw.search || raw.text || '').trim();
  if (!query) return null;

  const playbookGeo = listFrom(signalPlaybook.geo)[0] || '';
  const rawGeo = raw.geo || raw.country || playbookGeo || 'MY';
  const country = String(raw.country || countryCodeFromText(rawGeo) || rawGeo || 'MY').toUpperCase();
  const signalId = signalPlaybook.signal_id || signalPlaybook.signalId || raw.signal_id || raw.signalId || raw.signal;
  const signalFamily = signalPlaybook.signal_family
    || signalPlaybook.signalFamily
    || raw.signal_family
    || raw.signalFamily
    || signalFamilyForType(signalId || raw.signal_type || raw.type);
  const sourceChannel = raw.source_channel
    || raw.sourceChannel
    || signalPlaybook.source_channel
    || signalPlaybook.sourceChannel
    || 'web_search';

  return {
    query,
    signal_id: signalId || raw.signal_type || raw.type || 'signal_playbook',
    signal_family: signalFamily,
    source_channel: sourceChannel,
    signal_type: raw.signal_type || raw.type || signalId || signalFamily || 'buying_signal',
    tier: raw.tier || 'P1',
    country,
    cost_class: raw.cost_class || raw.costClass || 'paid_search',
    expected_evidence: raw.expected_evidence || raw.expectedEvidence || [],
    industry: raw.industry || null,
    term: raw.term || raw.source_term || null,
    source_term: raw.source_term || raw.term || null,
  };
}

function applySignalPlaybookToConfig(config = {}, signalPlaybook = null) {
  if (!signalPlaybook || typeof signalPlaybook !== 'object') return config;
  const plannedQueries = Array.isArray(signalPlaybook.queries)
    ? signalPlaybook.queries
      .map(q => normalizePlaybookPlannedQuery(q, signalPlaybook))
      .filter(Boolean)
    : [];
  if (plannedQueries.length > 0) {
    return {
      ...config,
      queries: plannedQueries,
      query_source: 'signal_playbook_planned_queries',
      signal_playbook: signalPlaybook,
    };
  }

  const signalId = signalPlaybook.signal_id || signalPlaybook.signalId || null;
  const sourceChannel = signalPlaybook.source_channel || signalPlaybook.sourceChannel || null;
  const geo = listFrom(signalPlaybook.geo).map(v => String(v).toUpperCase());
  const cap = Math.max(1, Number(signalPlaybook.cap || signalPlaybook.maxLeads || config.queries?.length || 1) || 1);
  const queries = Array.isArray(config.queries) ? config.queries : [];
  const signalMatched = queries.filter(q => signalMatchesPlaybook(q, signalId));
  const geoMatched = signalMatched.filter(q => queryMatchesGeo(q, geo));
  const selected = (geoMatched.length > 0 ? geoMatched : signalMatched)
    .slice(0, cap)
    .map(q => ({
      ...q,
      signal_id: signalId || q.signal_id || q.signal_type,
      signal_family: q.signal_family || signalFamilyForType(signalId || q.signal_type || q.signal_id),
      source_channel: sourceChannel || q.source_channel || 'web_search',
    }));

  return {
    ...config,
    queries: selected,
    query_source: `${config.query_source || 'default'}_signal_playbook`,
    signal_playbook: signalPlaybook,
  };
}

function attachSignalPackageToSignalLead(lead = {}, options = {}) {
  const metadata = { ...(lead.metadata || {}) };
  const signalType = metadata.signal_id
    || metadata.signal_type
    || lead.signal_type
    || lead.signal
    || 'signal_hunt';
  const evidence = metadata.evidence
    || metadata.signal
    || metadata.signal_summary
    || lead.signal
    || lead.snippet
    || lead.why_now
    || null;
  const whyNow = metadata.why_now || lead.why_now || evidence;
  const sourceUrl = metadata.source_url
    || metadata.signal_source_url
    || lead.signal_source_url
    || lead.source_url
    || metadata.linkedin_company_url
    || lead.linkedin_company_url
    || null;
  const sourceChannel = metadata.source_channel
    || metadata.sourceChannel
    || options.source_channel
    || 'web_search';
  const signalFamily = metadata.signal_family || signalFamilyForType(signalType);
  const decisionMaker = metadata.decision_maker || {
    name: lead.name || null,
    title: lead.title || null,
    source_url: lead.linkedin_url || metadata.decision_maker_source_url || null,
  };
  const contact = metadata.contact || {
    email: lead.email || null,
    email_verified: lead.email_verified === true,
    email_source: lead.email_source || null,
    linkedin_url: lead.linkedin_url || null,
  };

  return attachSignalPackageToLead({
    ...lead,
    signal: signalType,
    why_now: whyNow,
    metadata: {
      ...metadata,
      signal_id: signalType,
      signal_family: signalFamily,
      source_channel: sourceChannel,
      source_url: sourceUrl,
      evidence,
      company_icp_fit: metadata.company_icp_fit || {
        vertical_match: metadata.industry || metadata.segment || null,
        geo_match: metadata.country || lead.country || null,
        size_signal: null,
        reject_rules_checked: [],
      },
      decision_maker: decisionMaker,
      contact,
      why_now: whyNow,
      sales_angle: metadata.sales_angle || metadata.angle || `${signalType}: ${whyNow || evidence || 'signal-backed outreach angle'}`,
    },
  }, options);
}

function queriesFromConfigContent(content) {
  if (Array.isArray(content?.queries) && content.queries.length > 0) return content.queries;
  const signalQueries = content?.signal_queries;
  if (Array.isArray(signalQueries)) return signalQueries;
  if (signalQueries && typeof signalQueries === 'object') {
    return Object.entries(signalQueries).flatMap(([signalType, value]) => {
      const items = Array.isArray(value) ? value : [value];
      return items.map(item => (
        typeof item === 'string'
          ? { query: item, signal_type: signalType }
          : { ...(item || {}), signal_type: item?.signal_type || signalType }
      ));
    });
  }
  return [];
}

/**
 * Load the client's signal hunt config, or return defaults.
 */
async function loadSignalConfig(clientId, icp = {}, { maxPaidQueries = null } = {}) {
  let content = null;
  try {
    const { rows } = await pool.query(
      `SELECT content FROM agent_memory
       WHERE client_id = $1 AND key = $2
       ORDER BY
         CASE agent
           WHEN 'research_beaver' THEN 0
           WHEN 'captain_beaver' THEN 1
           WHEN 'director' THEN 2
           ELSE 3
         END,
         updated_at DESC
       LIMIT 1`,
      [clientId, SIGNAL_HUNT_CONFIG_KEY]
    );
    content = rows[0]?.content || null;
    if (typeof content === 'string') {
      try { content = JSON.parse(content); } catch { content = null; }
    }
  } catch (err) {
    console.warn('[signalHunt] Failed to load config, using defaults:', err.message);
  }

  const configuredQueries = queriesFromConfigContent(content);
  const icpQueries = hasIcpSearchScope(icp) ? buildSignalQueriesFromIcp(icp) : [];
  const fallbackQueries = icpQueries.length > 0
    ? [...icpQueries, ...configuredQueries]
    : (configuredQueries.length > 0 ? configuredQueries : DEFAULT_SIGNAL_QUERIES);
  const querySource = icpQueries.length > 0
    ? (configuredQueries.length > 0 ? 'current_icp_signal_planner_then_config' : 'current_icp_signal_planner')
    : (configuredQueries.length > 0 ? 'stored_config' : 'default');
  const seenQueries = new Set();
  const fallbackCountry = countriesFromIcp(icp)[0]?.code || 'MY';
  const queryWindow = signalQueryWindow(maxPaidQueries);
  const queries = fallbackQueries
    .map(q => normalizeSignalQuery(q, fallbackCountry))
    .filter(Boolean)
    .filter(q => {
      const key = q.query.toLowerCase();
      if (seenQueries.has(key)) return false;
      seenQueries.add(key);
      return true;
    })
    .slice(0, queryWindow);
  const requestedResults = Number(content?.max_results_per_query || MAX_SIGNAL_RESULTS_PER_QUERY);

  return {
    ...(content || {}),
    queries,
    query_source: querySource,
    query_window: queryWindow,
    max_results_per_query: Number.isFinite(requestedResults) && requestedResults > 0
      ? Math.min(requestedResults, MAX_SIGNAL_RESULTS_PER_QUERY)
      : MAX_SIGNAL_RESULTS_PER_QUERY,
  };
}

async function previewSignalHuntPlan(clientId, { icp = {}, maxPaidQueries = null, maxLeads = 20, signalPlaybook = null } = {}) {
  let config = await loadSignalConfig(clientId, icp, { maxPaidQueries });
  config = applySignalPlaybookToConfig(config, signalPlaybook);
  const paidQueryBudget = signalPaidBudgetSplit(maxPaidQueries, maxLeads);
  const executableDiscoveryQueries = executableDiscoveryQueriesForBudget(config.queries, paidQueryBudget);
  const hash = signalQuerySetHash(executableDiscoveryQueries);
  const key = `signal_hunt_zero_query_set_${klDateString()}_${hash}`;
  const executableQueryCount = executableDiscoveryQueries.length;
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'research_beaver' AND key = $2
     LIMIT 1`,
    [clientId, key]
  );
  const shapeQuery = q => ({
    query: q.query,
    signal_type: q.signal_type,
    tier: q.tier,
    country: q.country,
    signal_id: q.signal_id || null,
    source_channel: q.source_channel || null,
  });

  return {
    query_source: config.query_source,
    max_results_per_query: config.max_results_per_query,
    query_set_hash: hash,
    query_set_key: key,
    repeated_zero_blocked: rows.length > 0,
    previous_zero_output: rows[0]?.content || null,
    parser_version: SIGNAL_HUNT_PARSER_VERSION,
    paid_query_budget: paidQueryBudget.total,
    discovery_query_budget: paidQueryBudget.discovery,
    lookup_query_budget: paidQueryBudget.lookup,
    total_queries: config.queries.length,
    executable_query_count: executableQueryCount,
    queries: config.queries.map(shapeQuery),
    executable_queries: executableDiscoveryQueries.map(shapeQuery),
  };
}

function signalExtractionGuidance(query = {}) {
  const signalType = String(query.signal_type || '').toLowerCase();
  const sourceChannel = String(query.source_channel || '').toLowerCase();
  if (isHiringSignalQuery(query)) {
    return `
Hiring-source extraction guidance:
- Extract the hiring company from LinkedIn/job-board titles and snippets, not LinkedIn or the job board itself.
- Titles often look like "Role at Company", "Role - Company", or "Company hiring Role"; use that company as the signal company.
- Skip location-mismatched results, generic job-board pages, and results where no specific hiring company is named.
- A sales, account executive, business development, SDR, BDR, growth, or RevOps job in the target geography is a real buying signal.`;
  }
  if (sourceChannel === 'industry_publication' || /agency|publication/.test(signalType)) {
    return `
Agency-publication extraction guidance:
- If a result says a brand appointed, retained, reappointed, or picked an agency/PR/social/creative/media partner, extract the appointed agency as the company, not the brand client.
- Treat agency client wins, retainer appointments, market entry, new office/team launch, senior leadership appointments, and named growth/capability expansion as real buying signals.
- Do not reject a signal merely because the source is an industry publication instead of the company's own site.
- Prefer current-year and dated results. If the result date is stale and there is no ongoing appointment/retainer/expansion, skip it.
- For multi-company roundups, include only companies with a named event and source URL.`;
  }
  if (/training|upskilling|skills|learning/.test(signalType)) {
    return `
Training-publication extraction guidance:
- Extract the training, coaching, upskilling, L&D, or skills provider as the company when it launches, expands, partners, or announces a new programme.
- Skip conference listings, generic education articles, and government-only programmes unless a named private provider is clearly involved.`;
  }
  return '';
}

function signalExtractionAgent(query = {}) {
  const signalType = String(query.signal_type || '').toLowerCase();
  const sourceChannel = String(query.source_channel || '').toLowerCase();
  if (sourceChannel === 'industry_publication' || /agency|publication|training_growth/.test(signalType)) {
    return 'market_sensor';
  }
  return 'research_beaver';
}

function normaliseSignalConfidence(value, item = {}) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').toLowerCase();
  if (text === 'high') return 0.9;
  if (text === 'medium') return 0.7;
  if (text === 'low') return 0.5;
  if ((item.company || item.company_name || item.name)
    && (item.signal_summary || item.summary || item.why_now || item.outreach_angle || item.angle)
    && (item.source_url || item.url || item.link)) {
    return 0.6;
  }
  return 0;
}

function normaliseExtractedSignals(items = [], fallbackSignalType = 'buying_signal') {
  return (Array.isArray(items) ? items : [])
    .map(item => ({
      ...item,
      company: item.company || item.company_name || item.name || '',
      signal_type: item.signal_type || fallbackSignalType,
      source_url: item.source_url || item.url || item.link || '',
      signal_summary: item.signal_summary || item.summary || '',
      why_now: item.why_now || item.signal_summary || item.summary || item.outreach_angle || item.angle || '',
      angle: item.angle || item.outreach_angle || item.suggested_angle || '',
      confidence: normaliseSignalConfidence(item.confidence, item),
    }));
}

function extractedSignalItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed?.company || parsed?.company_name || parsed?.name) return [parsed];
  const keys = ['signals', 'data', 'opportunities', 'leads', 'companies', 'items', 'results', 'buying_signals'];
  for (const key of keys) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
    if (parsed?.[key] && typeof parsed[key] === 'object' && (parsed[key].company || parsed[key].company_name || parsed[key].name)) {
      return [parsed[key]];
    }
    if (typeof parsed?.[key] === 'string') {
      try {
        const nested = JSON.parse(parsed[key]);
        const nestedItems = extractedSignalItems(nested);
        if (nestedItems) return nestedItems;
      } catch { /* leave unmatched */ }
    }
  }
  if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value) && value.some(item => item?.company || item?.company_name || item?.name)) return value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nestedItems = extractedSignalItems(value);
        if (nestedItems) return nestedItems;
      }
    }
  }
  return null;
}

function isIndustryPublicationQuery(query = {}) {
  const signalType = String(query.signal_type || '').toLowerCase();
  const sourceChannel = String(query.source_channel || '').toLowerCase();
  return sourceChannel === 'industry_publication' || /agency|publication|training_growth/.test(signalType);
}

function publicationTitle(result = {}) {
  return String(result.title || result.name || '')
    .replace(/\s+\|\s+.*$/, '')
    .replace(/\s+-\s+MARKETING\s+Magazine.*$/i, '')
    .trim();
}

function publicationYear(value = '') {
  const match = String(value || '').match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function publicationResultIsStale(result = {}) {
  const year = publicationYear(`${result.date || ''} ${result.title || ''} ${result.snippet || ''}`);
  if (!year) return false;
  const currentYear = Number(klDateString().slice(0, 4));
  return year < currentYear - 1;
}

function cleanPublicationCompanyName(value = '') {
  let company = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/g, '')
    .trim();

  company = company
    .replace(/\s+(?:as|for|after|with|from|in)\b.*$/i, '')
    .replace(/\s+(?:PR|creative|media|social media|automation|retainer|agency|partner)$/i, '')
    .trim();

  if (!company || company.length < 3 || company.length > 80) return '';
  if (/\b(open rfp|nominations?|awards?|winners?|conference|event|review)\b/i.test(company)) return '';
  if (/^(puma group malaysia|mdec|astro|malaysia airlines|food & drinks malaysia|cmo awards|campaign asia)$/i.test(company)) return '';
  return company;
}

function publicationCompanyFromResult(result = {}) {
  const title = publicationTitle(result);
  const text = `${title}. ${result.snippet || ''}`.replace(/\s+/g, ' ');
  const patterns = [
    /\b(?:appoints|appointed|reappointed|retains|retained|selects|selected|picks|picked|names|named)\s+([A-Z][A-Za-z0-9&.' ,-]{2,80})\s+(?:as|for|to handle|to lead)\b/i,
    /\b(?:duties|mandate|retainer|account|brief)\s+to\s+([A-Z][A-Za-z0-9&.' ,-]{2,80})$/i,
    /\bgeneral manager of\s+([A-Z][A-Za-z0-9&.' ,-]{2,80})\b/i,
    /^([A-Z][A-Za-z0-9&.' ,-]{2,80})\s+(?:names|appoints|promotes)\s+(?:first\s+)?(?:regional\s+)?(?:coo|ceo|md|general manager|managing director)\b/i,
    /\bhow\s+([A-Z][A-Za-z0-9&.' ,-]{2,80})\s+became\b/i,
    /^([A-Z][A-Za-z0-9&.' ,-]{2,80})\s+(?:launches|expands|enters|opens|wins|became|becomes)\b/i,
    /\bcompany,\s+([A-Z][A-Za-z0-9&.' ,-]{2,80})\s+(?:launches|expands|partners|enters)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const company = cleanPublicationCompanyName(match?.[1]);
    if (company) return company;
  }

  return '';
}

function deterministicPublicationSignals(results = [], query = {}) {
  if (!isIndustryPublicationQuery(query)) return [];

  return (Array.isArray(results) ? results : [])
    .filter(result => result && !publicationResultIsStale(result))
    .map(result => {
      const company = publicationCompanyFromResult(result);
      if (!company) return null;
      const title = publicationTitle(result);
      const sourceUrl = result.link || result.url || '';
      return {
        company,
        signal_type: query.signal_type || 'industry_publication_agency_signal',
        source_url: sourceUrl,
        signal_summary: `${company} has a current industry-publication signal: ${title}.`,
        why_now: `A current industry publication gives Sales Beaver a timely opening to contact ${company}.`,
        angle: `Open with the published trigger and ask how ${company} is scaling outbound around it.`,
        signal_date: publicationYear(result.date) ? String(result.date || '') : '',
        raw_snippet: result.snippet || title,
        confidence: 0.62,
      };
    })
    .filter(Boolean);
}

function isHiringSignalQuery(query = {}) {
  const signalType = String(query.signal_type || query.signal_id || '').toLowerCase();
  const sourceChannel = String(query.source_channel || '').toLowerCase();
  return /hiring|sales_roles|vacancy|job/.test(signalType)
    || ['linkedin_jobs', 'company_careers', 'job_boards'].includes(sourceChannel);
}

function resultOutsideTargetCountry(result = {}, country = 'MY') {
  const code = String(country || '').toUpperCase();
  const text = `${result.title || ''} ${result.snippet || ''} ${result.link || result.url || ''}`.toLowerCase();
  if (code === 'MY') {
    const hasMalaysia = /\b(malaysia|kuala lumpur|greater kuala lumpur|selangor|petaling jaya|klang valley)\b/.test(text);
    const hasIndia = /\b(india|delhi|ncr|jaipur|siliguri|gurugram|mumbai|bangalore|bengaluru)\b/.test(text);
    return hasIndia && !hasMalaysia;
  }
  return false;
}

function validSignalCompanyName(value = '') {
  const company = String(value || '').replace(/\s+/g, ' ').trim();
  if (!company || company.length < 2 || company.length > 80) return false;
  if (/^(?:MYR|RM|USD|\$)?\s*\d[\d,.]*(?:\+)?(?:\s|$)/i.test(company)) return false;
  if (/\b(?:MYR|RM|USD)\s*\d[\d,.]*/i.test(company)) return false;
  if (/^\d[\d,.]*(?:\+)?\s+.*\bjobs?\s+in\b/i.test(company)) return false;
  if (/^(?:easy apply|top applicants|full[- ]time|on[- ]site|remote|hybrid)$/i.test(company)) return false;
  return true;
}

function cleanHiringCompanyName(value = '') {
  let company = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\|\s*LinkedIn.*$/i, '')
    .replace(/\s+-\s*LinkedIn.*$/i, '')
    .replace(/\s+\|\s*(JobStreet|Hiredly|Indeed|Glassdoor).*$/i, '')
    .replace(/^[,\s-]+|[,\s-]+$/g, '')
    .trim();

  company = company
    .replace(/\s+(?:is\s+)?(?:hiring|looking|seeking)\b.*$/i, '')
    .replace(/\s+(?:job vacancy|jobs?|careers?)\b.*$/i, '')
    .replace(/\s+(?:in|at)\s+(?:Malaysia|Kuala Lumpur|Greater Kuala Lumpur|Singapore)\b.*$/i, '')
    .trim();

  if (!validSignalCompanyName(company)) return '';
  if (/\b(linkedin|jobstreet|hiredly|indeed|glassdoor|jobs in india|indian pharma jobs|pharma jobs)\b/i.test(company)) return '';
  return company;
}

function hiringCompanyFromResult(result = {}) {
  const title = String(result.title || result.name || '')
    .replace(/\s+\|\s*LinkedIn.*$/i, '')
    .trim();
  const text = `${title}. ${result.snippet || ''}`.replace(/\s+/g, ' ');
  const patterns = [
    /\bat\s+([A-Z][A-Za-z0-9&.'() ,-]{2,80}?)(?:\s*(?:\||-|,|\.|$))/i,
    /[-–]\s*([A-Z][A-Za-z0-9&.'() ,-]{2,80}?)(?:\s*(?:\||[-–]|\.|$))/i,
    /^([A-Z][A-Za-z0-9&.'() ,-]{2,80}?)\s+(?:is\s+)?(?:hiring|seeking|looking for)\b/i,
    /\|\s*([A-Z][A-Za-z0-9&.'() ,-]{2,80}?)$/i,
  ];

  for (const sourceText of [title, text]) {
    for (const pattern of patterns) {
      const match = sourceText.match(pattern);
      const company = cleanHiringCompanyName(match?.[1]);
      if (company) return company;
    }
  }
  return '';
}

function deterministicHiringSignals(results = [], query = {}) {
  if (!isHiringSignalQuery(query)) return [];
  const country = query.country || countryCodeFromText(query.query) || 'MY';

  return (Array.isArray(results) ? results : [])
    .filter(result => result && !resultOutsideTargetCountry(result, country))
    .map(result => {
      const company = hiringCompanyFromResult(result);
      if (!company) return null;
      const title = String(result.title || '').replace(/\s+\|\s*LinkedIn.*$/i, '').trim();
      const sourceUrl = result.link || result.url || '';
      return {
        company,
        signal_type: query.signal_type || query.signal_id || 'hiring_sales_roles',
        source_url: sourceUrl,
        signal_summary: `${company} is hiring a sales or business development role in the target market: ${title}.`,
        why_now: `${company} is adding sales capacity now, which creates an outbound scaling conversation.`,
        angle: `Open with the hiring signal and ask how ${company} is covering pipeline while building the sales team.`,
        signal_date: result.date || '',
        raw_snippet: result.snippet || title,
        confidence: 0.68,
      };
    })
    .filter(Boolean);
}

function mergeExtractedSignalSets(primary = [], fallback = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [...primary, ...fallback]) {
    const company = String(item?.company || item?.company_name || item?.name || '').toLowerCase().trim();
    const sourceUrl = String(item?.source_url || item?.url || item?.link || '').toLowerCase().trim();
    const key = `${company}|${sourceUrl}`;
    if (!company || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * Extract companies + signal data through the budgeted signal parser path.
 */
async function extractSignalsFromResults(clientId, results, queryContext = {}, geoText = 'the configured target geographies') {
  if (!results || results.length === 0) return [];
  const query = typeof queryContext === 'string' ? { signal_type: queryContext } : (queryContext || {});
  const signal_type = query.signal_type || 'buying_signal';
  const extractionGuidance = signalExtractionGuidance(query);
  const agentKey = signalExtractionAgent(query);
  const deterministicSignals = mergeExtractedSignalSets(
    deterministicPublicationSignals(results, query),
    deterministicHiringSignals(results, query)
  );

  const snippetsForBudgetedAgent = results.map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}${r.date ? `\nDate: ${r.date}` : ''}`
  ).join('\n\n');

  try {
    const parsed = await callAgent(agentKey, `You are a buying signal detector. Analyse these search results and extract real buying signals for B2B outreach.

Signal type: ${signal_type}

Search results:
${snippetsForBudgetedAgent}

${extractionGuidance}

For each result containing a REAL buying signal from a company in ${geoText}, return JSON array:
[{
  "company": "Exact company name",
  "signal_type": "${signal_type}",
  "signal_summary": "One sentence: what happened and why it matters for outreach",
  "why_now": "One sentence: why NOW is the right time to reach out",
  "angle": "One sentence: the opening angle Sales Beaver should use",
  "signal_date": "YYYY-MM-DD or empty",
  "source_url": "the URL",
  "raw_snippet": "original snippet",
  "confidence": 0.0-1.0
}]

Rules:
- Only include REAL signals from companies in ${geoText}
- Ignore generic articles, listicles, job boards with no specific company
- For agency/client-win articles, the lead company is the agency/provider being appointed or expanding, not the brand that hired them
- Confidence 0.9 = very clear specific company + event, 0.5 = weak
- Use the result date as signal_date when available; use empty string if no date is visible
- If no real signals found, return []
- Return ONLY the JSON array, nothing else`, { clientId });
    const parsedItems = extractedSignalItems(parsed);
    if (parsedItems) return mergeExtractedSignalSets(normaliseExtractedSignals(parsedItems, signal_type), deterministicSignals);
    if (typeof parsed?.raw === 'string') {
      try {
        const rawItems = extractedSignalItems(JSON.parse(parsed.raw));
        if (rawItems) return mergeExtractedSignalSets(normaliseExtractedSignals(rawItems, signal_type), deterministicSignals);
      } catch { /* fall through to bracket extraction */ }
      const jsonMatch = parsed.raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) return mergeExtractedSignalSets(normaliseExtractedSignals(JSON.parse(jsonMatch[0]), signal_type), deterministicSignals);
    }
  } catch (err) {
    if (isBudgetExceededError(err)) {
      console.warn('[signalHunt] budget cap reached during signal parsing:', err.message);
      throw err;
    }
    console.warn('[signalHunt] budgeted signal parsing failed:', err.message);
  }

  return deterministicSignals;

}

/**
 * For a company with a signal, find the best decision-maker via LinkedIn.
 * Returns { name, title, linkedin_url } or null.
 */
async function findDecisionMaker(companyName, icpTitles = [], country = 'MY') {
  if (!companyName) return null;

  const titleHints = icpTitles.length > 0 ? icpTitles.slice(0, 3).join(' OR ') : 'founder OR CEO OR director';
  const query = `"${companyName}" (${titleHints})`;

  try {
    const profiles = await searchLinkedInProfiles(query, 3, { country });
    if (profiles.length === 0) return null;

    // Prefer the highest-seniority title
    const seniorityRank = (title) => {
      const t = (title || '').toLowerCase();
      if (/founder|ceo|co-founder/.test(t)) return 5;
      if (/managing director|md|president/.test(t)) return 4;
      if (/director|head of|vp/.test(t)) return 3;
      if (/manager|lead/.test(t)) return 2;
      return 1;
    };

    const sorted = profiles
      .filter(p => p.name && p.linkedin_url)
      .sort((a, b) => seniorityRank(b.title) - seniorityRank(a.title));

    return sorted[0] || null;
  } catch (err) {
    console.warn(`[signalHunt] findDecisionMaker failed for ${companyName}:`, err.message);
    return null;
  }
}

/**
 * Main entry point: run a signal hunt for a client.
 * Returns an array of lead objects ready for the outreach pipeline.
 *
 * @param {string} clientId
 * @param {object} options
 * @param {number} options.maxLeads - stop after finding this many leads (default 20)
 * @param {object} options.icp - ICP memory for seniority ranking
 * @returns {Promise<Array<Lead>>}
 */
async function runSignalHunt(clientId, { maxLeads = 20, icp = {}, maxPaidQueries = null, signalPlaybook = null, plan_id = null } = {}) {
  console.log(`[signalHunt] Starting signal hunt for client ${clientId} (target: ${maxLeads})`);
  await assertLlmBudgetOpen(clientId);

  let config = await loadSignalConfig(clientId, icp, { maxPaidQueries });
  config = applySignalPlaybookToConfig(config, signalPlaybook);
  const paidQueryBudget = signalPaidBudgetSplit(maxPaidQueries, maxLeads);
  const providerFanoutCaps = signalProviderFanoutCaps(maxPaidQueries, maxLeads);
  const executableDiscoveryQueries = executableDiscoveryQueriesForBudget(config.queries, paidQueryBudget);
  const zeroSet = await blockedByRepeatedZeroQuerySet(clientId, executableDiscoveryQueries);
  if (zeroSet.blocked) {
    console.log('[signalHunt] Blocking repeated zero-output query set for today');
    return [];
  }

  const allSignals = [];
  const leads = [];
  const rawSample = [];
  let queriesRun = 0;
  let rawResultsTotal = 0;
  let paidQueriesRemaining = paidQueryBudget.total;
  let discoveryQueriesRun = 0;
  const consumePaidQuery = (units = 1) => {
    if (paidQueriesRemaining === null) return true;
    const needed = Math.max(1, Number(units) || 1);
    if (paidQueriesRemaining < needed) return false;
    paidQueriesRemaining -= needed;
    return true;
  };

  // Step 1: Run all signal queries in sequence (cost control)
  for (const q of config.queries) {
    if (allSignals.length >= maxLeads * 2) break; // 2x buffer — some will fail contact lookup
    if (paidQueryBudget.discovery !== null && discoveryQueriesRun >= paidQueryBudget.discovery) {
      console.log('[signalHunt] Discovery-query budget reached; reserving paid budget for decision-maker lookup');
      break;
    }

    await assertLlmBudgetOpen(clientId);
    if (!consumePaidQuery(1)) {
      console.log('[signalHunt] Paid-query budget exhausted before open-web signal search');
      break;
    }

    console.log(`[signalHunt] Running query: ${q.query}`);
    queriesRun++;
    discoveryQueriesRun++;
    try {
      const country = q.country || 'MY';
      const geoText = countryNameFromCode(country);
      const results = await searchOpenWeb(q.query, config.max_results_per_query || 5, { country, clientId });
      const safeResults = Array.isArray(results) ? results : [];
      rawResultsTotal += safeResults.length;
      for (const result of safeResults.slice(0, 2)) {
        if (rawSample.length >= 12) break;
        rawSample.push({
          query: q.query,
          title: String(result.title || '').slice(0, 160),
          url: String(result.link || '').slice(0, 240),
          source: String(result.source || '').slice(0, 80),
          date: result.date || null,
        });
      }
      if (safeResults.length === 0) continue;

      const extracted = await extractSignalsFromResults(clientId, safeResults, q, geoText);
      const validSignals = extracted.filter(s => s.company && validSignalCompanyName(s.company) && s.confidence >= 0.5);

      // Assign tier from the query config
      validSignals.forEach(s => {
        s.tier = q.tier || 'P2';
        s.country = country;
        s.signal_id = q.signal_id || q.signal_type;
        s.signal_family = q.signal_family || signalFamilyForType(q.signal_id || q.signal_type);
        s.source_channel = q.source_channel || 'web_search';
      });
      allSignals.push(...validSignals);

      console.log(`[signalHunt] Query "${q.signal_type}" extracted ${validSignals.length} signals`);
    } catch (err) {
      console.warn(`[signalHunt] Query failed: ${err.message}`);
    }
  }

  console.log(`[signalHunt] Total signals extracted: ${allSignals.length}`);

  if (allSignals.length === 0) {
    const blocker = rawResultsTotal === 0 ? 'raw_candidates_zero' : 'signals_zero_after_llm_parse';
    await rememberZeroQuerySet(clientId, {
      key: zeroSet.key,
      hash: zeroSet.hash,
      queries: executableDiscoveryQueries,
      queriesRun,
      rawResultsTotal,
      blocker,
    }).catch(() => {});
    await logsService.createLog(clientId, {
      agent: 'research_beaver',
      action: 'signal_hunt_complete',
      metadata: {
        plan_id,
        query_source: config.query_source,
        queries_run: queriesRun,
        discovery_query_budget: paidQueryBudget.discovery,
        lookup_query_budget: paidQueryBudget.lookup,
        provider_fanout_caps: providerFanoutCapsLog(providerFanoutCaps),
        queries_preview: config.queries.slice(0, queriesRun).map(q => q.query),
        paid_query_budget_remaining: paidQueriesRemaining,
        raw_results_total: rawResultsTotal,
        raw_sample: rawSample,
        blocker,
        total_signals: 0,
        unique_companies: 0,
        leads_with_contacts: 0,
        tiers: {},
      },
    }).catch(() => {});
    return [];
  }

  // Step 2: Dedupe by company name
  const seenCompanies = new Set();
  const uniqueSignals = allSignals.filter(s => {
    const key = (s.company || '').toLowerCase().trim();
    if (!key || seenCompanies.has(key)) return false;
    seenCompanies.add(key);
    return true;
  });

  // Step 3: Sort P1 first
  uniqueSignals.sort((a, b) => {
    const rank = { P1: 3, P2: 2, P3: 1 };
    return (rank[b.tier] || 0) - (rank[a.tier] || 0);
  });

  // Step 4: For each signal, find the decision-maker
  const icpTitles = titlesFromIcp(icp);

  for (const signal of uniqueSignals.slice(0, maxLeads * 2)) {
    if (leads.length >= maxLeads) break;

    await assertLlmBudgetOpen(clientId);
    if (!consumePaidQuery(1)) {
      console.log('[signalHunt] Paid-query budget exhausted before decision-maker lookup');
      break;
    }

    const country = signal.country || countryCodeFromText(signal.raw_snippet || signal.signal_summary || '') || 'MY';
    const countryName = countryNameFromCode(country);
    const person = await findDecisionMaker(signal.company, icpTitles, country);
    if (!person || !person.linkedin_url) {
      console.log(`[signalHunt] No decision-maker found for ${signal.company}`);
      continue;
    }

    const { applyIcpV2Filter } = require('./agents');
    const gate = applyIcpV2Filter({
      name: person.name,
      company: signal.company,
      title: person.title || '',
      country: countryName,
      score: signal.tier === 'P1' ? 90 : 70,
      metadata: { country: countryName },
    });
    if (!gate.pass) {
      console.log(`[signalHunt] ICP gate blocked ${person.name} / ${signal.company}: ${gate.reason}`);
      continue;
    }

    // Step 5: email enrichment. Uses Hunter while its cap allows, then falls
    // through to pattern + MillionVerifier when Hunter is exhausted.
    let email = null;
    let email_source = null;
    let email_verified = false;
    try {
      const { findEmail } = require('./emailEnrichment');
      const enriched = await findEmail({
        name: person.name,
        company: signal.company,
        clientId,
        maxDomainSearches: providerFanoutCaps.maxDomainSearchesPerLead,
        maxHunterCalls: providerFanoutCaps.maxHunterCallsPerLead,
        maxVerifierCalls: providerFanoutCaps.maxVerifierCallsPerLead,
      });
      if (enriched?.email) {
        email = enriched.email;
        email_source = enriched.email_source || 'findemail';
        email_verified = enriched.status === 'deliverable';
      }
    } catch (err) {
      console.warn(`[signalHunt] Email enrichment failed for ${person.name}:`, err.message);
    }

    leads.push(attachSignalPackageToSignalLead({
      name: person.name,
      title: person.title || '',
      company: signal.company,
      linkedin_url: person.linkedin_url,
      email,
      email_source,
      email_verified,
      signal_tier: signal.tier,
      score: signal.tier === 'P1' ? 90 : 70,
      verified: true,
      data_source: 'signal_hunt',
      metadata: {
        signal_id: signal.signal_id || signal.signal_type,
        signal_family: signal.signal_family || signalFamilyForType(signal.signal_id || signal.signal_type),
        source_channel: signal.source_channel || 'web_search',
        source_url: signal.source_url,
        evidence: signal.signal_summary || signal.raw_snippet || signal.why_now,
        signal: signal.signal_summary,
        why_now: signal.why_now,
        angle: signal.angle,
        signal_type: signal.signal_type,
        signal_source_url: signal.source_url,
        signal_confidence: signal.confidence,
        country: countryName,
        tier: signal.tier,
        source: 'signal_hunt',
      },
    }, {
      evidenceDate: signal.signal_date || undefined,
      source_channel: signal.source_channel || 'web_search',
    }));
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'signal_hunt_complete',
    metadata: {
      plan_id,
      query_source: config.query_source,
      queries_run: queriesRun,
      discovery_query_budget: paidQueryBudget.discovery,
      lookup_query_budget: paidQueryBudget.lookup,
      provider_fanout_caps: providerFanoutCapsLog(providerFanoutCaps),
      queries_preview: config.queries.slice(0, queriesRun).map(q => q.query),
      paid_query_budget_remaining: paidQueriesRemaining,
      raw_results_total: rawResultsTotal,
      raw_sample: rawSample,
      blocker: leads.length === 0 ? 'contacts_zero' : null,
      total_signals: allSignals.length,
      unique_companies: uniqueSignals.length,
      leads_with_contacts: leads.length,
      tiers: leads.reduce((acc, l) => {
        acc[l.signal_tier] = (acc[l.signal_tier] || 0) + 1;
        return acc;
      }, {}),
    },
  }).catch(() => {});

  if (leads.length === 0) {
    await rememberZeroQuerySet(clientId, {
      key: zeroSet.key,
      hash: zeroSet.hash,
      queries: executableDiscoveryQueries,
      queriesRun,
      rawResultsTotal,
      blocker: 'contacts_zero',
    }).catch(() => {});
  }

  console.log(`[signalHunt] Returning ${leads.length} leads with decision-makers`);
  return leads;
}

/**
 * Save signal-sourced leads directly to the DB, bypassing the Captain gates
 * (signals are pre-qualified — they ARE the filter).
 */
async function saveSignalLeads(clientId, leads) {
  const saved = [];
  const saveStats = {
    attempted: 0,
    saved: 0,
    duplicate_linkedin: 0,
    missing_signal_package: 0,
    contact_gate_blocked: 0,
    insert_failed: 0,
  };
  const contactGate = require('./contactGate');

  for (const lead of leads) {
    saveStats.attempted++;
    const missingPackageFields = signalPackageMissingFields(lead.metadata?.signal_package);
    if (missingPackageFields.length > 0) {
      saveStats.missing_signal_package++;
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'research_blocker',
        target_type: 'research',
        metadata: {
          blocker: 'contact_zero',
          reason: 'missing_signal_package_before_signal_save',
          missing_fields: missingPackageFields,
          lead_name: lead.name || null,
          lead_company: lead.company || null,
          source: 'signal_hunt',
        },
      }).catch(() => {});
      console.log(`[signalHunt] Skipping ${lead.name || lead.company || 'lead'} - incomplete signal_package: ${missingPackageFields.join(',')}`);
      continue;
    }

    // Dedup check on LinkedIn URL
    if (lead.linkedin_url) {
      const dup = await pool.query(
        `SELECT id FROM leads WHERE client_id = $1 AND linkedin_url = $2 AND deleted_at IS NULL LIMIT 1`,
        [clientId, lead.linkedin_url]
      );
      if (dup.rows.length > 0) {
        saveStats.duplicate_linkedin++;
        await logsService.createLog(clientId, {
          agent: 'research_beaver',
          action: 'signal_lead_duplicate_skipped',
          target_type: 'lead',
          target_id: dup.rows[0].id,
          metadata: {
            source: 'signal_hunt',
            lead_company: lead.company || null,
            signal_id: lead.metadata?.signal_package?.signal_id || null,
          },
        }).catch(() => {});
        console.log(`[signalHunt] Skipping duplicate: ${lead.linkedin_url}`);
        continue;
      }
    }

    // Tiered contact gate (migration 061, 2026-05-05): assigns A/B tier;
    // C rejected and logged. Signals are pre-qualified by intent but signal
    // alone doesn't grant Tier A — channel-presence still required.
    const gateResult = await contactGate.tryPersistSourcedLead(clientId, lead, {
      sourceStrategy: 'signal_hunt',
      allowLinkedinOnly: !!lead.linkedin_only_override,
    });
    if (!gateResult.passed) {
      saveStats.contact_gate_blocked++;
      console.log(`[signalHunt] Tier C ${lead.name} — reason: ${gateResult.missReason}`);
      continue;
    }
    const leadTier = gateResult.tier;

    // Phase 2 V2 Step 6 (2026-05-08): buying_signal_strength + signal_dated_at.
    // signalHunt is a SIGNAL-FIRST producer — by definition every lead it
    // sources has a buying signal in metadata. Default to 'rich' (the source
    // of truth IS the signal hunt) unless explicitly overridden, with the
    // signal date pulled from metadata.signal_dated_at if Research Beaver
    // emitted it, else NOW() (today's hunt).
    const buyingSignalStrength = lead.buying_signal_strength
      || lead.metadata?.buying_signal_strength
      || 'rich';
    const signalDatedAt = lead.signal_dated_at
      || lead.metadata?.signal_dated_at
      || new Date().toISOString();

    try {
      const res = await pool.query(
        `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                            pipeline_stage, status, email_verified, email_source, linkedin_url, metadata,
                            lead_tier, tiered_at,
                            buying_signal_strength, signal_dated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'signal_hunt','prospecting','new',$8,$9,$10,$11,$12,NOW(),$13,$14)
         RETURNING *`,
        [
          clientId, lead.name, lead.email || null, lead.company, lead.title || null,
          lead.signal_tier, lead.score,
          lead.email_verified, lead.email_source, lead.linkedin_url,
          JSON.stringify(lead.metadata || {}),
          leadTier,
          buyingSignalStrength, signalDatedAt,
        ]
      );
      if (res.rows.length > 0) {
        saved.push(res.rows[0]);
        saveStats.saved++;
      }
    } catch (err) {
      saveStats.insert_failed++;
      console.error('[signalHunt] Failed to save signal lead:', err.message);
    }
  }

  Object.defineProperty(saved, 'saveStats', {
    value: saveStats,
    enumerable: false,
  });
  return saved;
}

module.exports = {
  runSignalHunt,
  saveSignalLeads,
  loadSignalConfig,
  previewSignalHuntPlan,
  _test: {
    applySignalPlaybookToConfig,
    attachSignalPackageToSignalLead,
    signalPackageMissingFields,
    signalFamilyForType,
    buildSignalQueriesFromIcp,
    sourceAwareQueriesForCountry,
    titlesFromIcp,
    signalExtractionAgent,
    normaliseExtractedSignals,
    extractedSignalItems,
    deterministicPublicationSignals,
    deterministicHiringSignals,
    validSignalCompanyName,
    mergeExtractedSignalSets,
    signalQuerySetHash,
    signalQueryWindow,
    signalPaidBudgetSplit,
    signalProviderFanoutCaps,
    executableDiscoveryQueriesForBudget,
  },
};
