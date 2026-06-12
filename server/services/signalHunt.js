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
 *   5. Enrich with Anymail -> Icypeas -> Snov -> Hunter sourcing, then MillionVerifier verification
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
const platformRegistry = require('./platformRegistry');
const {
  resolveCompanyEvidence,
  resolveCompanyIdentity,
  isAggregatorUrl,
  companyNameFromDomain,
} = require('./companyEvidenceResolver');
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
// Vertical-first discovery searches SEO-ranked web for vertical terms. The
// top-3 results are almost always the biggest/most-authoritative players (the
// giants the ICP gate then correctly rejects). Widen the result window for
// vertical-first runs so the SME long-tail past the top-3 also enters the
// funnel — the candidate-side cost is free (regex + cheap homepage fetch);
// only gate-passing candidates spend the paid decision-maker budget.
const MAX_VERTICAL_RESULTS_PER_QUERY = envInt('SIGNAL_HUNT_VERTICAL_RESULTS_PER_QUERY', 12);
// BUMP THIS whenever extraction, normalisation, or proof-gate logic changes.
// The repeated-zero guard keys zero-output memory by this version — a parsing
// fix shipped without a bump stays blocked by the OLD code's zero results
// (2026-06-12: 4cf68e9 job-board proof gate shipped on v3, retest 409'd on
// the pre-patch zero key until v4).
const SIGNAL_HUNT_PARSER_VERSION = 'universal_signal_planner_v4';

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

function signalPaidBudgetSplit(maxPaidQueries = null, maxLeads = 1, { verticalFirst = false } = {}) {
  if (maxPaidQueries === null || maxPaidQueries === undefined || maxPaidQueries === '') {
    return { total: null, discovery: null, lookup: null };
  }

  const n = Number(maxPaidQueries);
  if (!Number.isFinite(n) || n <= 0) {
    return { total: 0, discovery: 0, lookup: 0 };
  }

  const total = Math.max(0, Math.floor(n));
  const target = Math.max(1, Math.ceil(Number(maxLeads) || 1));
  // Vertical-first widens discovery (Commit 1) → more candidates pass the
  // cheap gate → more paid decision-maker lookups needed. Reserve a bigger
  // lookup share so the survivor set isn't starved by discovery + the first
  // few lookups. Cap at 60% of total so discovery still gets meaningful
  // breadth. The decision-maker fallback can consume an extra unit per
  // survivor, so target*2 is the realistic ceiling.
  const lookup = verticalFirst
    ? Math.max(1, Math.min(target * 2, Math.ceil(total * 0.6)))
    : Math.max(1, Math.min(target, Math.floor(total / 2)));
  return {
    total,
    discovery: Math.max(0, total - lookup),
    lookup,
  };
}

function platformFunnelKeyFor(step = {}) {
  const platform = String(step.platform || step.source_channel || 'unknown').trim() || 'unknown';
  const queryHash = platformRegistry.hashQuery(step.query || '');
  return `${platform}|${queryHash}`;
}

function platformFromLead(lead = {}) {
  return String(
    lead?.metadata?.platform
    || lead?.metadata?.signal_package?.platform
    || lead?.metadata?.source_platform
    || lead?.platform
    || ''
  ).trim();
}

function createPlatformFunnelTracker({ mode = 'proof', planId = null } = {}) {
  const rows = new Map();

  const ensure = (step = {}) => {
    const key = platformFunnelKeyFor(step);
    if (!rows.has(key)) {
      const provider = step.provider || 'brave';
      const validation = platformRegistry.validateQuery(step.query || '', provider);
      rows.set(key, {
        plan_id: step.platform_plan_id || step.plan_id || planId || null,
        platform: String(step.platform || step.source_channel || 'unknown').trim() || 'unknown',
        provider,
        mode: step.mode || mode || 'proof',
        signal_id: step.signal_id || step.signal_type || null,
        signal_family: step.signal_family || signalFamilyForType(step.signal_id || step.signal_type),
        source_channel: step.source_channel || null,
        geo: step.geo || step.country || null,
        query: step.query || null,
        query_hash: validation.query_hash,
        query_chars: validation.chars,
        query_words: validation.words,
        query_valid: validation.valid,
        paid_units: 0,
        raw_results: 0,
        extracted_signals: 0,
        vertical_verified: 0,
        saved_leads: 0,
        blocker: null,
        error_code: null,
        metadata: {},
      });
    }
    return rows.get(key);
  };

  const recordSearch = (step, results = []) => {
    const row = ensure(step);
    row.paid_units += 1;
    row.raw_results += Array.isArray(results) ? results.length : 0;
    return row;
  };

  const recordExtraction = (step, count = 0) => {
    const row = ensure(step);
    row.extracted_signals += Math.max(0, Number(count) || 0);
    return row;
  };

  const recordBlocked = (step, blocker, validation = null) => {
    const row = ensure(step);
    row.blocker = blocker || row.blocker || 'platform_query_blocked';
    row.error_code = row.error_code || row.blocker;
    if (validation) {
      row.query_hash = validation.query_hash || row.query_hash;
      row.query_chars = validation.chars ?? row.query_chars;
      row.query_words = validation.words ?? row.query_words;
      row.query_valid = validation.valid !== false;
    }
    return row;
  };

  const recordVerticalVerified = (signal = {}) => {
    const platform = platformFromLead(signal) || String(signal.platform || signal.source_channel || '').trim();
    const queryHash = signal.query ? platformRegistry.hashQuery(signal.query) : null;
    const row = [...rows.values()].find(item => {
      if (platform && item.platform !== platform) return false;
      return !queryHash || item.query_hash === queryHash;
    });
    if (row) row.vertical_verified += 1;
    return row || null;
  };

  const events = () => [...rows.values()].map(row => ({ ...row, metadata: { ...(row.metadata || {}) } }));

  const withSavedLeads = (savedLeads = []) => {
    const savedByPlatform = new Map();
    for (const lead of Array.isArray(savedLeads) ? savedLeads : []) {
      const platform = platformFromLead(lead);
      if (!platform) continue;
      savedByPlatform.set(platform, (savedByPlatform.get(platform) || 0) + 1);
    }
    return events().map(row => ({
      ...row,
      saved_leads: savedByPlatform.get(row.platform) || 0,
    }));
  };

  return {
    recordSearch,
    recordExtraction,
    recordBlocked,
    recordVerticalVerified,
    events,
    withSavedLeads,
  };
}

function attachPlatformFunnelToSignalHuntResult(leads, platformFunnel = []) {
  const result = Array.isArray(leads) ? leads : [];
  Object.defineProperty(result, 'platform_funnel', {
    value: Array.isArray(platformFunnel) ? platformFunnel : [],
    enumerable: false,
    configurable: true,
  });
  return result;
}

function platformFunnelFromSignalHuntResult(result = []) {
  return Array.isArray(result) && Array.isArray(result.platform_funnel)
    ? result.platform_funnel
    : [];
}

function signalProviderFanoutCaps(maxPaidQueries = null, maxLeads = 1) {
  const paidQueryBudget = signalPaidBudgetSplit(maxPaidQueries, maxLeads);
  const target = Math.max(1, Math.ceil(Number(maxLeads) || 1));
  const lookup = paidQueryBudget.lookup === null || paidQueryBudget.lookup === undefined
    ? target
    : Math.max(0, Math.min(target, Math.floor(Number(paidQueryBudget.lookup) || 0)));
  const perLeadPaidEnrichment = lookup > 0 ? 1 : 0;
  const perLeadVerifierAttempts = lookup > 0 ? 3 : 0;

  return {
    maxDomainSearchesPerLead: 0,
    maxAnymailCallsPerLead: perLeadPaidEnrichment,
    maxIcypeasCallsPerLead: perLeadPaidEnrichment,
    maxSnovCallsPerLead: perLeadPaidEnrichment,
    maxHunterCallsPerLead: perLeadPaidEnrichment,
    maxVerifierCallsPerLead: perLeadVerifierAttempts,
    maxEnrichmentLeads: lookup,
  };
}

function providerFanoutCapsLog(caps) {
  return {
    max_domain_searches_per_lead: caps.maxDomainSearchesPerLead,
    max_anymail_calls_per_lead: caps.maxAnymailCallsPerLead,
    max_icypeas_calls_per_lead: caps.maxIcypeasCallsPerLead,
    max_snov_calls_per_lead: caps.maxSnovCallsPerLead,
    max_hunter_calls_per_lead: caps.maxHunterCallsPerLead,
    max_verifier_calls_per_lead: caps.maxVerifierCallsPerLead,
    max_enrichment_leads: caps.maxEnrichmentLeads,
  };
}

function initSignalHuntStageStats() {
  return {
    raw_results_total: 0,
    raw_candidates_total: 0,
    companies_extracted: 0,
    icp_passed: 0,
    decision_makers_found: 0,
    contacts_found: 0,
    saved: 0,
  };
}

function signalIdentity(signal = {}) {
  const signalId = signal.signal_id || signal.signal_type || signal.signal || 'unknown_signal';
  return {
    signal_id: signalId,
    signal_family: signal.signal_family || signalFamilyForType(signalId),
    source_channel: signal.source_channel || 'web_search',
  };
}

function signalHuntCompleteMetadata({
  planId = null,
  config = {},
  queriesRun = 0,
  paidQueryBudget = {},
  providerFanoutCaps = {},
  paidQueriesRemaining = null,
  rawSample = [],
  blocker = null,
  stageStats = initSignalHuntStageStats(),
  tiers = {},
} = {}) {
  return {
    plan_id: planId,
    query_source: config.query_source,
    queries_run: queriesRun,
    discovery_query_budget: paidQueryBudget.discovery,
    lookup_query_budget: paidQueryBudget.lookup,
    provider_fanout_caps: providerFanoutCapsLog(providerFanoutCaps),
    queries_preview: Array.isArray(config.queries) ? config.queries.slice(0, queriesRun).map(q => q.query) : [],
    paid_query_budget_remaining: paidQueriesRemaining,
    raw_sample: rawSample,
    blocker,
    ...stageStats,
    total_signals: stageStats.raw_candidates_total,
    unique_companies: stageStats.companies_extracted,
    leads_with_contacts: stageStats.contacts_found,
    tiers,
  };
}

async function logSignalHuntMiss(clientId, {
  signal = {},
  blocker,
  reason = null,
  metadata = {},
} = {}) {
  if (!clientId || !blocker) return;
  const identity = signalIdentity(signal);
  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'research_blocker',
    target_type: 'research',
    metadata: {
      source: 'signal_hunt',
      ...identity,
      blocker,
      reason,
      lead_company: signal.company || metadata.lead_company || null,
      source_url: signal.source_url || metadata.source_url || null,
      ...metadata,
    },
  }).catch(() => {});
}

function missingSignalPackageSaveMetadata(lead = {}, missingPackageFields = []) {
  const companyFit = lead.metadata?.signal_package?.company_icp_fit;
  const hasEmptyCompanyIcpEvidence =
    missingPackageFields.includes('company_icp_fit') &&
    companyFit &&
    !String(companyFit.vertical_match || '').trim() &&
    (!Array.isArray(companyFit.icp_evidence) || companyFit.icp_evidence.filter(Boolean).length === 0);
  return {
    blocker: hasEmptyCompanyIcpEvidence ? 'icp_zero_after_company_extract' : 'contact_zero',
    reason: hasEmptyCompanyIcpEvidence ? 'empty_company_icp_evidence' : 'missing_signal_package_before_signal_save',
    missing_fields: missingPackageFields,
    lead_name: lead.name || null,
    lead_company: lead.company || null,
    source: 'signal_hunt',
  };
}

function executableDiscoveryQueriesForBudget(queries = [], paidQueryBudget = {}) {
  if (!Array.isArray(queries)) return [];
  const discovery = paidQueryBudget?.discovery;
  if (discovery === null || discovery === undefined) return queries;
  const limit = Math.max(0, Math.floor(Number(discovery) || 0));
  return queries.slice(0, limit);
}

function shouldStopSignalDiscovery({
  discoveryQueriesRun = 0,
  paidQueryBudget = {},
} = {}) {
  const discovery = paidQueryBudget?.discovery;
  if (discovery === null || discovery === undefined) return false;
  const limit = Math.max(0, Math.floor(Number(discovery) || 0));
  return discoveryQueriesRun >= limit;
}

async function blockedByRepeatedZeroQuerySet(clientId, queries = []) {
  const hash = signalQuerySetHash(queries);
  const key = `signal_hunt_zero_query_set_${klDateString()}_${SIGNAL_HUNT_PARSER_VERSION}_${hash}`;
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
    ...listFrom(icp.active_industries),
  ];
  const base = industries.length > 0 ? industries : [];
  const seen = new Set();
  return base
    .filter(value => {
      const key = String(value || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

function normalizedEvidenceText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceTextForSignal(signal = {}) {
  const metadata = signal.metadata || {};
  return [
    signal.company,
    signal.signal_summary,
    signal.raw_snippet,
    signal.why_now,
    signal.angle,
    signal.source_url,
    signal.description,
    signal.company_description,
    signal.industry,
    signal.segment,
    metadata.signal_summary,
    metadata.raw_snippet,
    metadata.why_now,
    metadata.evidence,
    metadata.industry,
    metadata.segment,
  ].filter(Boolean).join(' ');
}

function isMarketingAgencyVertical(normalizedTerm = '') {
  return /\b(agenc(y|ies)|studio|studios|firm|firms)\b/.test(normalizedTerm)
    && /\b(marketing|digital|creative|pr|communications?|advertising|media|content|public relations)\b/.test(normalizedTerm);
}

function marketingAgencyEvidenceMatches(normalizedText = '') {
  if (/\b(recruit|recruitment|staffing|headhunt|headhunting|employment agency|talent acquisition)\b/.test(normalizedText)) {
    return false;
  }
  const hasAgencyShape = /\b(agenc(y|ies)|studio|studios|firm|firms)\b/.test(normalizedText);
  const hasQualifier = /\b(marketing|digital|creative|pr|communications?|advertising|media|content|brand|branding|social media|public relations)\b/.test(normalizedText);
  return hasAgencyShape && hasQualifier;
}

function isCorporateTrainingVertical(normalizedTerm = '') {
  return /\b(training|learning|coaching|skill|skills|upskill|upskilling|l and d|development)\b/.test(normalizedTerm);
}

function corporateTrainingEvidenceMatches(normalizedText = '') {
  return /\b(corporate training|professional training|workplace training|employee training|training provider|training company|training firm|training consultancy|learning and development|l and d|executive coaching|leadership coaching|sales coaching|skills development|skill development|upskill|upskilling|workforce development)\b/.test(normalizedText);
}

// Competitor wording that describes a company's OWN service offering (agency /
// service / consultancy shape). A company whose page reads this way IS a
// competitor regardless of its claimed vertical — always disqualifies.
function competitorServiceWordingMatches(text = '') {
  const normalizedText = normalizedEvidenceText(text);
  if (!normalizedText) return [];
  const patterns = [
    ['outbound agency', /\boutbound\s+(agency|agencies|service|services|consulting|consultancy|firm|firms)\b/],
    ['lead generation agency', /\b(lead\s*(gen|generation)|leadgen)\s+(agency|agencies|service|services|consulting|consultancy|firm|firms|provider|providers)\b/],
    ['cold email/outreach agency', /\bcold\s+(email|outreach|calling)\s+(agency|agencies|service|services|consulting|consultancy|firm|firms|provider|providers|specialist|specialists)\b/],
    ['SDR-as-a-service', /\b(sdr|bdr)\s+(as\s+a\s+)?service\b/],
    ['appointment setting', /\bappointment\s+setting\b/],
    ['demand generation agency', /\bdemand\s*(gen|generation)\s+(agency|agencies|service|services|consulting|consultancy|firm|firms|provider|providers)\b/],
    ['GTM agency', /\b(gtm|go to market)\s+(agency|agencies|service|services|consulting|consultancy|firm|firms)\b/],
    ['AI sales/outbound brand', /\bai\s+(sales|outbound|sdr|lead\s*(gen|generation)|gtm)\b/],
    ['LinkedIn outreach agency', /\blinkedin\s+(outreach|lead\s*(gen|generation)|appointment|automation)\b/],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(normalizedText))
    .map(([label]) => label);
}

// Bare topic wording (cold email, lead gen) with NO agency/service context.
// On a confirmed in-ICP vertical (e.g. a corporate training provider that
// teaches cold outreach, or an agency that ran a lead-gen campaign for a
// client) this is a topic mention, not the company's own competitor offer —
// so it only disqualifies when the company's vertical is NOT confirmed.
function competitorTopicWordingMatches(text = '') {
  const normalizedText = normalizedEvidenceText(text);
  if (!normalizedText) return [];
  const patterns = [
    ['lead generation', /\b(lead\s*(gen|generation)|leadgen)\b/],
    ['cold email outreach', /\bcold\s+(email|outreach)\b/],
    ['demand generation', /\bdemand\s*(gen|generation)\b/],
  ];
  return patterns
    .filter(([, pattern]) => pattern.test(normalizedText))
    .map(([label]) => label);
}

function termMatchesText(term = '', text = '', { allowRegex = false, flexible = false } = {}) {
  const rawTerm = String(term || '').trim();
  if (!rawTerm) return false;
  const normalizedTerm = normalizedEvidenceText(rawTerm);
  const normalizedText = normalizedEvidenceText(text);
  if (!normalizedTerm || !normalizedText) return false;
  if (allowRegex) {
    try {
      if (new RegExp(rawTerm, 'i').test(text)) return true;
    } catch { /* fall through to literal matching */ }
  }
  if (flexible && isMarketingAgencyVertical(normalizedTerm)) {
    return marketingAgencyEvidenceMatches(normalizedText);
  }
  if (flexible && isCorporateTrainingVertical(normalizedTerm)) {
    return corporateTrainingEvidenceMatches(normalizedText);
  }
  if (normalizedText.includes(normalizedTerm)) return true;
  if (!flexible) return false;

  const generic = new Set([
    'b2b', 'sales', 'business', 'development', 'provider', 'providers',
    'service', 'services', 'professional', 'company', 'companies',
    'digital', 'marketing', 'solutions',
  ]);
  const keywords = new Set(
    normalizedTerm
      .split(' ')
      .map(token => token.replace(/ies$/, 'y').replace(/s$/, ''))
      .filter(token => token.length >= 3 && !generic.has(token))
  );
  if (/\btraining\b/.test(normalizedTerm)) keywords.add('training');
  if (/\bupskill/.test(normalizedTerm)) keywords.add('upskill');
  if (/\bskills?\b/.test(normalizedTerm)) keywords.add('skill');
  if (/\b(coach|coaching)\b/.test(normalizedTerm)) keywords.add('coach');
  if (/\bagenc(y|ies)\b/.test(normalizedTerm)) keywords.add('agency');
  if (/\bstudios?\b/.test(normalizedTerm)) keywords.add('studio');
  if (/\brecruit/.test(normalizedTerm)) keywords.add('recruit');
  if (/\bl\s+and\s+d\b|\blearning\b/.test(normalizedTerm)) keywords.add('learning');
  if (/\bpr\b|public relations/.test(normalizedTerm)) keywords.add('pr');

  return [...keywords].some(keyword => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedText);
  });
}

function matchedTerms(terms = [], text = '', options = {}) {
  const seen = new Set();
  return listFrom(terms).filter(term => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return termMatchesText(term, text, options);
  });
}

function icpVerticalTerms(icp = {}) {
  return [
    ...listFrom(icp.active_industries),
  ];
}

function evaluateSignalCompanyIcpGate(signal = {}, icp = {}) {
  const text = evidenceTextForSignal(signal);
  const exclusionMatches = matchedTerms([
    ...listFrom(icp.exclusions),
    ...listFrom(icp.banned_regex),
    ...listFrom(signal.exclusions),
    ...listFrom(signal.banned_regex),
  ], text, { allowRegex: true });
  if (exclusionMatches.length > 0) {
    return {
      pass: false,
      blocker: 'icp_zero_after_company_extract',
      reason: 'tenant_exclusion_matched',
      matched_terms: exclusionMatches,
      reject_rules_checked: ['tenant_exclusions'],
    };
  }

  // Hard competitor signals — disqualify regardless of vertical:
  //   1. configured competitor_offers (brand names: Apollo, Lemlist, …)
  //   2. service-shaped wording (the company describes its OWN offer as
  //      outbound/lead-gen/cold-email/SDR agency).
  const hardCompetitorMatches = [...new Set([
    ...matchedTerms([
      ...listFrom(icp.competitor_offers),
      ...listFrom(signal.competitor_offers),
      ...listFrom(signal.reject_rules?.competitor_offers),
    ], text),
    ...competitorServiceWordingMatches(text),
  ])];
  if (hardCompetitorMatches.length > 0) {
    return {
      pass: false,
      blocker: 'competitor_offer_disqualified',
      reason: 'competitor_offer_matched',
      matched_terms: hardCompetitorMatches,
      reject_rules_checked: ['tenant_exclusions', 'competitor_offers'],
    };
  }

  const verticals = icpVerticalTerms(icp);
  if (verticals.length === 0) {
    return {
      pass: false,
      blocker: 'icp_no_active_verticals_configured',
      reason: 'tenant_active_industries_not_set',
      expected_verticals: [],
      reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
    };
  }

  // Confirm the company's vertical BEFORE the bare-topic competitor check.
  // A confirmed in-ICP vertical (corporate training provider / marketing
  // agency) that merely mentions "cold email" or "lead generation" as a
  // course topic or client outcome is a TARGET, not a competitor.
  const verticalMatches = matchedTerms(verticals, text, { flexible: true });
  if (verticalMatches.length === 0) {
    // Vertical unconfirmed — bare competitor-topic wording now disqualifies
    // (a generic page heavy on lead-gen/cold-email language with no proven
    // in-ICP vertical is most likely a competitor or irrelevant).
    const topicMatches = competitorTopicWordingMatches(text);
    if (topicMatches.length > 0) {
      return {
        pass: false,
        blocker: 'competitor_offer_disqualified',
        reason: 'competitor_offer_matched',
        matched_terms: topicMatches,
        reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
      };
    }
    return {
      pass: false,
      blocker: 'icp_zero_after_company_extract',
      reason: 'missing_company_icp_evidence',
      expected_verticals: verticals,
      reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
    };
  }

  return {
    pass: true,
    vertical_match: verticalMatches[0],
    icp_evidence: verticalMatches,
    reject_rules_checked: ['tenant_exclusions', 'competitor_offers', 'company_icp_evidence'],
  };
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
  void country;
  void industries;
  return [];
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

  return queries;
}

function hasIcpSearchScope(icp = {}) {
  return [
    ...listFrom(icp.active_industries),
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
  const activeIndustries = listFrom(icp.active_industries);
  return {
    icp: {
      ...icp,
      active_industries: diversifyIndustriesForQueryRun(activeIndustries),
      verticals: diversifyIndustriesForQueryRun(activeIndustries),
      geo: listFrom(icp.geo).length > 0
        ? listFrom(icp.geo)
        : [...listFrom(icp.geographies), ...listFrom(icp.countries), ...listFrom(icp.locations), ...listFrom(icp.target_markets)],
      competitor_offers: listFrom(icp.competitor_offers),
      exclusions: listFrom(icp.exclusions),
    },
    buying_signals: Array.isArray(icp.buying_signals) ? icp.buying_signals : undefined,
  };
}

function allowBuyingSignalDefaultsForIcp(icp = {}) {
  return icp.source !== 'tenant_profiles'
    && !icp.content_version
    && !icp.tenant_profile_content_version;
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
    reject_rules: plan.rejectRules || {},
  };
}

function signalHuntQueryFromPlatformStep(step = {}) {
  const country = String(step.geo || countryCodeFromText(step.query) || 'MY').toUpperCase();
  const signalId = step.signal_id || step.signalId || 'approved_platform_plan';
  return {
    query: String(step.query || '').trim(),
    provider: step.provider || 'brave',
    platform: step.platform || step.source_channel || 'unknown',
    signal_type: step.signal_type || step.type || signalId,
    signal_id: signalId,
    signal_family: step.signal_family || step.signalFamily || signalFamilyForType(signalId),
    source_channel: step.source_channel || step.sourceChannel || step.platform || 'web_search',
    tier: step.tier || 'P1',
    country,
    cost_class: step.cost_class || step.costClass || 'paid_search',
    expected_evidence: step.evidence_required || step.expected_evidence || step.expectedEvidence || [],
    industry: step.industry || null,
    term: step.term || step.source_term || null,
    source_term: step.source_term || step.term || null,
    parser: step.parser || null,
    discovery_mode: step.discovery_mode || step.discoveryMode || null,
  };
}

function applyApprovedPlatformPlanToConfig(config = {}, platformPlan = null) {
  if (!platformPlan || typeof platformPlan !== 'object') return config;
  const plannedQueries = Array.isArray(platformPlan.platform_sequence)
    ? platformPlan.platform_sequence
      .map(signalHuntQueryFromPlatformStep)
      .filter(q => q.query)
    : [];
  if (plannedQueries.length === 0) return config;

  // Detect vertical-first at apply time so we can lift the results cap for
  // the SME long-tail. Mirrors isVerticalFirstPlatformPlan (declared below)
  // without taking a forward reference.
  const modeCandidates = [
    platformPlan.discovery_mode,
    platformPlan.discoveryMode,
    platformPlan.requested_mode,
    platformPlan.requestedMode,
    platformPlan.mode,
  ].map(value => String(value || '').toLowerCase());
  const stepIsVerticalFirst = Array.isArray(platformPlan.platform_sequence)
    && platformPlan.platform_sequence.some(step => String(step?.discovery_mode || step?.discoveryMode || '').toLowerCase() === 'vertical_first');
  const isVerticalFirst = modeCandidates.includes('vertical_first') || stepIsVerticalFirst;

  // Plan-level override wins if explicitly set; otherwise vertical-first gets
  // the wider cap, signal-first keeps the existing signal-hunt cap.
  const planLevelMax = Number(platformPlan.max_results_per_query);
  const verticalCap = Number.isFinite(planLevelMax) && planLevelMax > 0
    ? Math.min(planLevelMax, MAX_VERTICAL_RESULTS_PER_QUERY)
    : MAX_VERTICAL_RESULTS_PER_QUERY;
  const maxResultsPerQuery = isVerticalFirst
    ? verticalCap
    : (config.max_results_per_query || MAX_SIGNAL_RESULTS_PER_QUERY);

  return {
    ...config,
    queries: plannedQueries,
    query_source: 'approved_platform_plan',
    max_results_per_query: maxResultsPerQuery,
    approved_platform_plan: {
      id: platformPlan.id || platformPlan.plan_id || null,
      plan_hash: platformPlan.plan_hash || null,
      query_set_hash: platformPlan.query_set_hash || null,
      mode: platformPlan.mode || null,
      requested_mode: platformPlan.requested_mode || null,
      discovery_mode: platformPlan.discovery_mode || null,
      stop_rule: platformPlan.stop_rule || {},
    },
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
  const signals = normalizeBuyingSignalsForTenant(tenant, {
    allowDefaults: allowBuyingSignalDefaultsForIcp(icp),
  }).filter(signal => signal.enabled !== false);
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
  const seen = new Set();
  return queries.filter(q => {
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
  const signalLite = metadata.signal_lite === true || lead.signal_lite === true;
  const discoveryLane = metadata.discovery_lane || lead.discovery_lane || null;
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

  const packaged = attachSignalPackageToLead({
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
        vertical_match: metadata.industry_match || metadata.vertical_match || metadata.industry || metadata.segment || null,
        geo_match: metadata.country || lead.country || null,
        size_signal: metadata.size_signal || null,
        icp_evidence: metadata.icp_evidence || [],
        reject_rules_checked: Array.isArray(metadata.reject_rules_checked) ? metadata.reject_rules_checked : [],
      },
      decision_maker: decisionMaker,
      contact,
      why_now: whyNow,
      sales_angle: metadata.sales_angle || metadata.angle || `${signalType}: ${whyNow || evidence || 'signal-backed outreach angle'}`,
    },
  }, options);
  packaged.metadata.signal_package = {
    ...(packaged.metadata.signal_package || {}),
    ...(signalLite ? { signal_lite: true } : {}),
    ...(discoveryLane ? { discovery_lane: discoveryLane } : {}),
    ...(metadata.platform ? { platform: metadata.platform } : {}),
    ...(metadata.provider ? { provider: metadata.provider } : {}),
    ...(metadata.platform_plan_id ? { platform_plan_id: metadata.platform_plan_id } : {}),
  };
  return packaged;
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

function profileContentVersion(icp = {}) {
  const version = Number(
    icp.content_version
      || icp.tenant_profile_content_version
      || icp.profile_content_version
      || 0
  );
  return Number.isFinite(version) && version > 0 ? version : null;
}

function trustedSignalHuntConfigContent(content = {}, icp = {}) {
  if (!content || typeof content !== 'object') return false;
  if (content.trusted === true || content.trusted_signal_hunt_config === true) return true;
  const profileVersion = profileContentVersion(icp);
  const configVersion = Number(
    content.tenant_profile_content_version
      || content.profile_content_version
      || content.content_version
      || 0
  );
  return !!profileVersion && Number.isFinite(configVersion) && configVersion === profileVersion;
}

function isActiveTenantProfileIcp(icp = {}) {
  return icp.source === 'tenant_profiles' || !!profileContentVersion(icp);
}

function querySourceForSignalConfig(icp = {}, {
  icpQueryCount = 0,
  configuredQueryCount = 0,
  tenantProfileBlocked = false,
} = {}) {
  if (tenantProfileBlocked) return 'tenant_profile_blocked';
  if (icpQueryCount > 0) {
    return isActiveTenantProfileIcp(icp)
      ? 'active_tenant_profile_buying_signals'
      : 'legacy_current_icp_signal_planner';
  }
  if (configuredQueryCount > 0) return 'stored_config';
  return 'default';
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

  const storedQueries = queriesFromConfigContent(content);
  const trustedConfig = trustedSignalHuntConfigContent(content, icp);
  const configuredQueries = trustedConfig ? storedQueries : [];
  const rejectedConfigSource = storedQueries.length > 0 && !trustedConfig
    ? {
        key: SIGNAL_HUNT_CONFIG_KEY,
        reason: 'stale_signal_hunt_config',
        profile_content_version: profileContentVersion(icp),
        config_content_version: content?.tenant_profile_content_version || content?.profile_content_version || content?.content_version || null,
      }
    : null;
  if (rejectedConfigSource) {
    console.warn('[signalHunt] Rejected stale signal_hunt_config:', rejectedConfigSource);
    await logsService.createLog(clientId, {
      agent: 'research_beaver',
      action: 'signal_hunt_config_rejected',
      target_type: 'config',
      metadata: rejectedConfigSource,
    }).catch(() => {});
  }
  const icpQueries = hasIcpSearchScope(icp) ? buildSignalQueriesFromIcp(icp) : [];
  const tenantProfileBlocked = isActiveTenantProfileIcp(icp)
    && hasIcpSearchScope(icp)
    && icpQueries.length === 0;
  const fallbackQueries = tenantProfileBlocked
    ? []
    : (icpQueries.length > 0
    ? icpQueries
    : (configuredQueries.length > 0 ? configuredQueries : DEFAULT_SIGNAL_QUERIES));
  const querySource = querySourceForSignalConfig(icp, {
    icpQueryCount: icpQueries.length,
    configuredQueryCount: configuredQueries.length,
    tenantProfileBlocked,
  });
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
  const trustedContent = trustedConfig ? content : null;
  const requestedResults = Number(trustedContent?.max_results_per_query || MAX_SIGNAL_RESULTS_PER_QUERY);

  return {
    ...(trustedContent || {}),
    queries,
    query_source: querySource,
    rejected_config_source: rejectedConfigSource,
    query_window: queryWindow,
    max_results_per_query: Number.isFinite(requestedResults) && requestedResults > 0
      ? Math.min(requestedResults, MAX_SIGNAL_RESULTS_PER_QUERY)
      : MAX_SIGNAL_RESULTS_PER_QUERY,
  };
}

async function previewSignalHuntPlan(clientId, { icp = {}, maxPaidQueries = null, maxLeads = 20, signalPlaybook = null, platformPlan = null } = {}) {
  let config = await loadSignalConfig(clientId, icp, { maxPaidQueries });
  config = applySignalPlaybookToConfig(config, signalPlaybook);
  config = applyApprovedPlatformPlanToConfig(config, platformPlan);
  const verticalFirstPlan = isVerticalFirstPlatformPlan(platformPlan, config);
  const paidQueryBudget = signalPaidBudgetSplit(maxPaidQueries, maxLeads, { verticalFirst: verticalFirstPlan });
  const executableDiscoveryQueries = executableDiscoveryQueriesForBudget(config.queries, paidQueryBudget);
  const hash = signalQuerySetHash(executableDiscoveryQueries);
  const key = `signal_hunt_zero_query_set_${klDateString()}_${SIGNAL_HUNT_PARSER_VERSION}_${hash}`;
  const executableQueryCount = executableDiscoveryQueries.length;
  const { rows } = await pool.query(
    `SELECT content FROM agent_memory
     WHERE client_id = $1 AND agent = 'research_beaver' AND key = $2
     LIMIT 1`,
    [clientId, key]
  );
  const shapeQuery = q => ({
    query: q.query,
    provider: q.provider || 'brave',
    platform: q.platform || null,
    signal_type: q.signal_type,
    signal_family: q.signal_family || null,
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
  if (sourceChannel === 'industry_publication' || /publication/.test(signalType)) {
    return `
Industry-publication extraction guidance:
- Extract the company that has the configured signal evidence, not a surrounding brand, publisher, event organizer, or unrelated partner.
- Treat current, named company events as candidate buying signals only when they match the requested signal family and tenant ICP.
- Do not treat the source publication itself as the lead company.
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
  const signalFamily = String(query.signal_family || '').toLowerCase();
  const sourceChannel = String(query.source_channel || '').toLowerCase();
  if (
    sourceChannel === 'industry_publication'
    || (
      ['press', 'company_news', 'news'].includes(sourceChannel)
      && /expansion|growth|leadership|org_change|capital|budget/.test(`${signalType} ${signalFamily}`)
    )
    || /publication|training_growth/.test(signalType)
  ) {
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
    }))
    .filter(item => jobBoardProofGate(item, { signal_type: fallbackSignalType }).ok);
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
  const signalFamily = String(query.signal_family || '').toLowerCase();
  const sourceChannel = String(query.source_channel || '').toLowerCase();
  return sourceChannel === 'industry_publication'
    || (
      ['press', 'company_news', 'news'].includes(sourceChannel)
      && /expansion|growth|leadership|org_change|capital|budget/.test(`${signalType} ${signalFamily}`)
    )
    || /publication|training_growth/.test(signalType);
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
        signal_type: query.signal_type || query.signal_id || 'industry_publication_signal',
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
  if (/^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+20\d{2}$/i.test(company)) return false;
  if (/^(?:at\s+)?least\s+\d+\s+(?:months?|years?)$/i.test(company)) return false;
  if (/^(?:for|and|or|the|of|in|to|with|by|from)$/i.test(company)) return false;
  if (/^(?:hays\b.*|michael page\b.*|jobstreet\b.*|indeed\b.*|glassdoor\b.*|linkedin\b.*|hiredly\b.*)$/i.test(company)) return false;
  if (/^(?:resume\s*box|resume[-\s]*library|cv[-\s]*library|foundit|wobb|naukri|jobsdb)\b/i.test(company)) return false;
  if (/^(?:shah alam|petaling jaya|cyberjaya|kuala lumpur|subang jaya|klang|putrajaya|johor bahru|penang|greater kuala lumpur|klang valley)$/i.test(company)) return false;
  if (/\b(?:job board|job portal|career portal|career platform|resume database|cv database|salary guide)\b/i.test(company)) return false;
  if (/^(?:easy apply|top applicants|full[- ]time|on[- ]site|remote|hybrid)$/i.test(company)) return false;
  if (/\b(?:roofing|roofer|commercial roofing)\b/i.test(company)
    && /\b(?:estimator|project manager|sales manager|sales representative|sales rep|salesperson|laborer|installer|superintendent|foreman|crew|worker)\b/i.test(company)
    && !/\b(?:inc|llc|ltd|limited|corp|corporation|company|co\.?|services|contractors)\s*(?:inc|llc|ltd|limited|corp|corporation|company|co\.?)?\b/i.test(company)) {
    return false;
  }
  return true;
}

function jobBoardUrlDetails(url = '') {
  const sourceUrl = String(url || '').trim();
  if (!sourceUrl) return { host: '', path: '', search: '', knownJobBoard: false };
  try {
    const parsed = new URL(sourceUrl);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    return {
      host,
      path: parsed.pathname.toLowerCase(),
      search: parsed.search.toLowerCase(),
      knownJobBoard: /(indeed\.com|linkedin\.com|ziprecruiter\.com|glassdoor\.com|simplyhired\.com|talent\.com)/i.test(host),
    };
  } catch {
    return { host: '', path: sourceUrl.toLowerCase(), search: '', knownJobBoard: false };
  }
}

function isHiringSignalDescriptor(source = {}, fallbackSignalType = '') {
  const text = [
    fallbackSignalType,
    source.signal_type,
    source.signal_id,
    source.signal_family,
    source.source_channel,
  ].filter(Boolean).join(' ').toLowerCase();
  return /hiring|sales_roles|vacancy|job/.test(text)
    || ['linkedin_jobs', 'company_careers', 'job_boards'].includes(String(source.source_channel || '').toLowerCase());
}

function isSpecificHiringProofUrl(url = '') {
  const details = jobBoardUrlDetails(url);
  if (!details.host && !details.path) return false;
  if (/indeed\.com$/i.test(details.host)) {
    return details.path.includes('/viewjob') || /[?&]jk=/.test(details.search);
  }
  if (/linkedin\.com$/i.test(details.host)) {
    return /^\/jobs\/view\/[^/]+/i.test(details.path);
  }
  if (/ziprecruiter\.com$/i.test(details.host)) {
    return /^\/c\/[^/]+\/job\/[^/]+/i.test(details.path);
  }
  return !details.knownJobBoard;
}

function genericJobBoardPageReason(url = '') {
  const details = jobBoardUrlDetails(url);
  if (!details.knownJobBoard) return null;
  if (isSpecificHiringProofUrl(url)) return null;
  if (/indeed\.com$/i.test(details.host) && /^\/q-/.test(details.path)) return 'generic_indeed_query_page';
  if (/linkedin\.com$/i.test(details.host) && /^\/jobs\//.test(details.path)) return 'generic_linkedin_jobs_page';
  if (/ziprecruiter\.com$/i.test(details.host) && /^\/jobs\//i.test(details.path)) return 'generic_ziprecruiter_jobs_page';
  return 'generic_job_board_page';
}

function jobBoardProofGate(source = {}, query = {}) {
  const fallbackSignalType = query.signal_type || query.signal_id || query.signal || '';
  if (!isHiringSignalDescriptor(source, fallbackSignalType)) return { ok: true };
  const sourceUrl = source.source_url || source.url || source.link || '';
  if (!sourceUrl) {
    return { ok: false, blocker: 'job_post_detail_missing', reason: 'missing_hiring_source_url' };
  }
  const genericReason = genericJobBoardPageReason(sourceUrl);
  if (genericReason) {
    return { ok: false, blocker: 'generic_job_board_page', reason: genericReason };
  }
  return { ok: true };
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
    .filter(result => jobBoardProofGate({
      source_url: result.link || result.url || '',
      source_channel: query.source_channel,
      signal_type: query.signal_type || query.signal_id,
    }, query).ok)
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

function isVerticalFirstPlatformPlan(platformPlan = null, config = {}) {
  const plan = platformPlan && typeof platformPlan === 'object' ? platformPlan : {};
  const approved = config?.approved_platform_plan || {};
  const modeCandidates = [
    plan.discovery_mode,
    plan.discoveryMode,
    plan.requested_mode,
    plan.requestedMode,
    plan.mode,
    approved.discovery_mode,
    approved.discoveryMode,
    approved.requested_mode,
    approved.mode,
  ].map(value => String(value || '').toLowerCase());
  if (modeCandidates.includes('vertical_first')) return true;
  return Array.isArray(plan.platform_sequence)
    && plan.platform_sequence.some(step => String(step?.discovery_mode || step?.discoveryMode || '').toLowerCase() === 'vertical_first');
}

function isVerticalFirstQuery(query = {}) {
  return String(query.discovery_mode || query.discoveryMode || '').toLowerCase() === 'vertical_first'
    || String(query.signal_id || query.signal_type || query.signal_family || '').toLowerCase() === 'vertical_first_discovery';
}

function escapeRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withProtocol(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(raw)) return `https://${raw}`;
  return null;
}

function originFor(value = '') {
  const raw = withProtocol(value);
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { return null; }
}

function hostFromUrl(value = '') {
  const raw = withProtocol(value);
  if (!raw) return null;
  try { return new URL(raw).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function cleanVerticalFirstCompanyName(value = '', query = {}) {
  let company = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+\|\s+.*$/i, '')
    .replace(/\s+[-–]\s+(?:marketing|digital|creative|pr|corporate training|training|learning|sales).+$/i, '')
    .replace(/\s+\b(?:Malaysia|Singapore|Kuala Lumpur|Selangor|Klang Valley)\b\s*$/i, '')
    .replace(/^[,\s-]+|[,\s-]+$/g, '')
    .trim();

  const sourceTerm = String(query.source_term || query.term || query.industry || '').trim();
  if (sourceTerm) {
    company = company
      .replace(new RegExp(`\\s+[-–]?\\s*${escapeRegex(sourceTerm)}\\b.*$`, 'i'), '')
      .trim();
  }

  company = company
    .replace(/\s+\b(?:marketing agency|digital agency|creative agency|pr agency|corporate training provider|training provider|training company)\b.*$/i, '')
    .trim();

  if (!validSignalCompanyName(company)) return '';
  return company;
}

function verticalFirstCompanyFromResult(result = {}, query = {}) {
  const title = String(result.title || result.name || '').trim();
  const snippet = String(result.snippet || result.description || '').trim();
  const titleCompany = cleanVerticalFirstCompanyName(title, query);
  if (titleCompany) return titleCompany;

  const snippetPatterns = [
    /\b([A-Z][A-Za-z0-9&.'() ,-]{2,80})\s+is\s+(?:a|an)\s+(?:Malaysia\s+)?(?:marketing|digital|creative|PR|corporate training|training|learning)/i,
    /\b(?:provider|agency|company):\s*([A-Z][A-Za-z0-9&.'() ,-]{2,80})\b/i,
  ];
  for (const pattern of snippetPatterns) {
    const match = snippet.match(pattern);
    const company = cleanVerticalFirstCompanyName(match?.[1], query);
    if (company) return company;
  }
  return '';
}

function verticalFirstSignalsFromResults(results = [], query = {}) {
  const country = query.country || countryCodeFromText(query.query) || 'MY';
  const platform = query.platform || query.source_channel || 'vertical_web';
  const sourceChannel = query.source_channel || platform || 'vertical_web';
  const seenDomains = new Set();
  return (Array.isArray(results) ? results : [])
    .map(result => {
      const sourceUrl = result.link || result.url || '';
      // Anchor on the result domain, not the scraped page title. Skip
      // listicles / directories / SEO ranking pages — they are not companies.
      if (isAggregatorUrl(sourceUrl)) return null;
      const origin = originFor(sourceUrl);
      const host = hostFromUrl(sourceUrl);
      // Dedup by company domain (multiple results from the same site = one company).
      if (host) {
        if (seenDomains.has(host)) return null;
        seenDomains.add(host);
      }
      // Provisional name from the title; resolveCompanyIdentity upgrades it to
      // the canonical og:site_name downstream. Domain is the stable fallback
      // when the title is an SEO headline rather than a company.
      const company = verticalFirstCompanyFromResult(result, query) || companyNameFromDomain(sourceUrl);
      if (!company) return null;
      const title = String(result.title || result.name || '').trim();
      const snippet = String(result.snippet || result.description || title).trim();
      const evidence = snippet || title || `${company} matched vertical-first discovery.`;
      return {
        company,
        company_website: origin || sourceUrl || null,
        domain: host || null,
        signal_type: query.signal_type || query.signal_id || 'vertical_first_discovery',
        signal_id: query.signal_id || 'vertical_first_discovery',
        signal_family: query.signal_family || 'vertical_first_discovery',
        source_channel: sourceChannel,
        platform,
        provider: query.provider || 'brave',
        platform_plan_id: query.platform_plan_id || query.plan_id || null,
        source_url: sourceUrl,
        signal_summary: `Signal-lite vertical-first company discovery for ${company}: ${title || evidence}.`,
        why_now: `${company} matched the tenant vertical in a vertical-first discovery source; use a cold-outreach-no-signal opener unless a richer signal is attached later.`,
        angle: `Open on the relevant vertical and ask how ${company} is building outbound pipeline this quarter.`,
        raw_snippet: evidence,
        company_description: evidence,
        signal_lite: true,
        discovery_lane: 'vertical_first',
        signal_date: result.date || '',
        confidence: 0.6,
        country,
        expected_industry: query.industry || null,
        expected_evidence: query.expected_evidence || [],
        source_term: query.source_term || query.term || null,
        query: query.query || null,
        metadata: {
          signal_lite: true,
          discovery_lane: 'vertical_first',
          platform,
          provider: query.provider || 'brave',
          platform_plan_id: query.platform_plan_id || query.plan_id || null,
          source_channel: sourceChannel,
          source_url: sourceUrl,
          evidence,
          source_term: query.source_term || query.term || null,
        },
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
- Extract the company with the configured signal evidence; do not infer a lead company from unrelated brand or partner mentions
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
    // The LLM extractor failed. We still fall back to deterministic regex so
    // signal-first doesn't hard-stop, but the degradation must be VISIBLE — a
    // broken provider silently dropping to regex is the failure mode that hid
    // the "research does no reasoning" defect. Log it explicitly.
    console.warn('[signalHunt] budgeted signal parsing failed — DEGRADED to deterministic regex:', err.message);
    if (clientId) {
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'research_beaver_llm_degraded',
        metadata: { stage: 'extract_signals_from_results', error: err.message, fell_back_to: 'deterministic_regex' },
      }).catch(() => {});
    }
  }

  return deterministicSignals;

}

function regexEscape(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decisionMakerTitleAlternatives(icpTitles = []) {
  const titles = icpTitles.length > 0 ? icpTitles.slice(0, 4) : ['founder', 'CEO', 'managing director', 'head of sales', 'director'];
  return titles
    .map(title => String(title || '').trim())
    .filter(Boolean)
    .map(regexEscape)
    .join('|');
}

function validDecisionMakerName(value = '') {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length < 5 || name.length > 80) return false;
  if (/[.!?]/.test(name)) return false;
  if (/\b(?:compare|pay|salary|jobs?|months?|agreed|least|insights|business)\b/i.test(name)) return false;
  if (/^(?:for|and|or|the|of|in|to|with|by|from)\b/i.test(name)) return false;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return false;
  return parts.every(part => /^[A-Z][A-Za-z'’`-]+$/.test(part));
}

function decisionMakerFromPublicEvidence(results = [], icpTitles = [], sourceLabel = 'decision_maker_public_evidence') {
  const titleAlternatives = decisionMakerTitleAlternatives(icpTitles);
  const titleRegex = new RegExp(`\\b(${titleAlternatives})\\b`, 'i');
  const namePattern = '([A-Z][A-Za-z.\'-]+(?:\\s+[A-Z][A-Za-z.\'-]+){1,3})';
  const patterns = [
    new RegExp(`${namePattern}\\s*(?:-|\\u2013|\\u2014|,|\\|)\\s*(${titleAlternatives})\\b`, 'i'),
    new RegExp(`\\b(${titleAlternatives})\\s*(?:-|\\u2013|\\u2014|,|:)?\\s*${namePattern}`, 'i'),
    new RegExp(`${namePattern}\\s+(?:is|as|serves as|named|appointed)\\s+(?:the\\s+)?(${titleAlternatives})\\b`, 'i'),
  ];

  for (const result of Array.isArray(results) ? results : []) {
    const sourceUrl = result.link || result.url || '';
    const text = `${result.title || ''}. ${result.snippet || ''}`.replace(/\s+/g, ' ').trim();
    if (!text || !titleRegex.test(text)) continue;
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const first = match[1] || '';
      const second = match[2] || '';
      const titleFirst = titleRegex.test(first);
      const name = titleFirst ? second : first;
      const title = titleFirst ? first : second;
      if (!name || !title || titleRegex.test(name)) continue;
      if (!validDecisionMakerName(name)) continue;
      return {
        name: name.trim(),
        title: title.trim(),
        source_url: sourceUrl,
        linkedin_url: /linkedin\.com\/in\//i.test(sourceUrl) ? sourceUrl : null,
        source: sourceLabel,
      };
    }
  }
  return null;
}

/**
 * For a company with a signal, find the best decision-maker from public
 * website/search evidence first, then LinkedIn-style profile evidence.
 * Returns { name, title, source_url, linkedin_url } or null.
 */
async function findDecisionMaker(companyName, icpTitles = [], country = 'MY', options = {}) {
  if (!companyName) return null;

  const titleHints = icpTitles.length > 0 ? icpTitles.slice(0, 3).join(' OR ') : 'founder OR CEO OR director';
  const query = `"${companyName}" (${titleHints})`;
  const clientId = options.clientId || null;
  const publicEvidenceSource = 'decision_maker_public_evidence';
  const consumeFallbackSearch = typeof options.consumeFallbackSearch === 'function'
    ? options.consumeFallbackSearch
    : () => true;

  try {
    const publicQuery = `"${companyName}" (${titleHints}) ("team" OR "about" OR "leadership" OR "founder")`;
    const publicResults = await searchOpenWeb(publicQuery, 3, { country, clientId });
    const publicPerson = decisionMakerFromPublicEvidence(publicResults, icpTitles, publicEvidenceSource);
    if (publicPerson) return publicPerson;
  } catch (err) {
    console.warn(`[signalHunt] public decision-maker lookup failed for ${companyName}:`, err.message);
  }

  if (!consumeFallbackSearch()) return null;

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
      .filter(p => validDecisionMakerName(p.name) && p.linkedin_url)
      .sort((a, b) => seniorityRank(b.title) - seniorityRank(a.title));

    const top = sorted[0] || null;
    return top ? {
      ...top,
      source_url: top.linkedin_url || null,
      source: 'decision_maker_linkedin_evidence',
    } : null;
  } catch (err) {
    console.warn(`[signalHunt] findDecisionMaker failed for ${companyName}:`, err.message);
    return null;
  }
}

/**
 * Research Beaver READS a company's web page and judges ICP fit — the core of
 * actual research, replacing the regex tower for the vertical-first lane.
 * Runs on the OpenAI-backed `research_beaver` agent (gpt-4.1-mini). Given the
 * already-fetched page text + the tenant ICP, it decides: real company (not a
 * directory)? in-ICP vertical? 5-50 size? right geo? competitor? — and pulls a
 * decision-maker if the page shows one. This is the one thing a regex can't do:
 * tell a directory from a company, a real name from a page title, and
 * "serves government clients" from "is a government agency".
 *
 * Returns { qualified, company_name, vertical_match, employee_band, geo_ok,
 * is_competitor, is_directory, decision_maker, reason } — or { error } on LLM
 * failure (caller surfaces it; we do NOT silently fall back to regex).
 */
async function qualifyCompanyByReading({ clientId, company, url, pageText, icp, callAgentImpl = callAgent } = {}) {
  const text = String(pageText || '').replace(/\s+/g, ' ').trim().slice(0, 3000);
  if (!text) return { qualified: false, reason: 'no_page_text_to_read' };

  const verticals = icpVerticalTerms(icp);
  const geo = (listFrom(icp?.geo).length > 0 ? listFrom(icp.geo) : ['MY']).join(', ');
  const prompt = `You are Research Beaver qualifying a company for B2B outreach. Read the company's web page text and decide if it fits the ICP.

PROVISIONAL COMPANY NAME: ${company || 'unknown'}
URL: ${url || 'n/a'}
TARGET VERTICALS: ${verticals.join(' OR ') || 'B2B services'}
TARGET GEO: ${geo}
TARGET SIZE: 5-50 employees (SMEs). Reject global / enterprise brands and large agency networks.
REJECT: directories/listicles/aggregators (a page that LISTS many companies rather than being one company); universities/colleges/schools; government/NGO bodies; and competitors whose OWN offer is outbound / lead-gen / cold-email / appointment-setting / SDR-as-a-service.
IMPORTANT: a company that SERVES government clients, or that TEACHES a "cold email" or "sales" course, is NOT itself a government agency or a competitor. Judge what the company IS, not who or what it mentions.

PAGE TEXT:
${text}

Return ONLY this JSON object:
{
  "is_real_company": true or false,
  "company_name": "the actual company name read from the page (never a page title or listicle headline)",
  "in_icp_vertical": true or false,
  "vertical_match": "which target vertical it matches, or null",
  "employee_band": "1-10" or "11-50" or "51-200" or "200+" or "unknown",
  "geo_ok": true or false,
  "is_competitor": true or false,
  "is_directory": true or false,
  "decision_maker": { "name": "full name visible on the page or null", "title": "their title or null" },
  "reason": "one short sentence explaining the verdict"
}`;

  let parsed;
  try {
    parsed = await callAgentImpl('research_beaver', prompt, { clientId });
  } catch (err) {
    if (isBudgetExceededError(err)) throw err;
    return { error: `research_beaver_read_failed: ${err.message}` };
  }

  let v = parsed && typeof parsed === 'object' && !('raw' in parsed) ? parsed : null;
  if (!v && typeof parsed?.raw === 'string') {
    try { v = JSON.parse(parsed.raw); } catch { v = null; }
  }
  if (!v || typeof v !== 'object') return { error: 'research_beaver_unparseable_verdict' };

  const sizeOk = ['1-10', '11-50', 'unknown'].includes(String(v.employee_band || 'unknown'));
  const qualified = !!v.is_real_company
    && !v.is_directory
    && !!v.in_icp_vertical
    && v.geo_ok !== false
    && !v.is_competitor
    && sizeOk;

  return {
    qualified,
    company_name: typeof v.company_name === 'string' && v.company_name.trim() ? v.company_name.trim() : null,
    vertical_match: v.vertical_match || null,
    employee_band: v.employee_band || 'unknown',
    geo_ok: v.geo_ok !== false,
    is_competitor: !!v.is_competitor,
    is_directory: !!v.is_directory,
    decision_maker: (v.decision_maker && typeof v.decision_maker === 'object') ? v.decision_maker : null,
    reason: typeof v.reason === 'string' ? v.reason : (qualified ? 'qualified' : 'not_in_icp'),
  };
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
async function runSignalHunt(clientId, { maxLeads = 20, icp = {}, maxPaidQueries = null, signalPlaybook = null, platformPlan = null, plan_id = null } = {}) {
  console.log(`[signalHunt] Starting signal hunt for client ${clientId} (target: ${maxLeads})`);
  await assertLlmBudgetOpen(clientId);

  let config = await loadSignalConfig(clientId, icp, { maxPaidQueries });
  config = applySignalPlaybookToConfig(config, signalPlaybook);
  config = applyApprovedPlatformPlanToConfig(config, platformPlan);
  const activePlanId = platformPlan?.id || platformPlan?.plan_id || plan_id;
  const verticalFirstExecution = isVerticalFirstPlatformPlan(platformPlan, config);
  // Vertical-first decision-maker lookup wants a Brave + Google CSE pair; with
  // google_cse cap=0 the lookup falls back to Brave only, sharing the same
  // pool as discovery. Surface this UPFRONT so MJ sees it before the proof
  // runs instead of buried inside a mid-run provider_blocked log.
  let decisionMakerProviders = null;
  if (verticalFirstExecution) {
    try {
      const { CAPS: providerCaps } = require('./spendGuard');
      const googleCseCap = Number(providerCaps?.google_cse) || 0;
      const braveCap = Number(providerCaps?.brave) || 0;
      decisionMakerProviders = { brave_cap: braveCap, google_cse_cap: googleCseCap };
      if (googleCseCap <= 0) {
        console.warn(`[signalHunt] Vertical-first run starting with google_cse cap=0; decision-maker lookup will rely on Brave only (shares discovery pool). Top up GOOGLE_CSE_DAILY_QUERY_CAP if you want a parallel lookup channel.`);
        await logsService.createLog(clientId, {
          agent: 'research_beaver',
          action: 'provider_capacity_warning',
          metadata: {
            reason: 'google_cse_cap_zero_for_vertical_first',
            provider: 'google_cse',
            cap: googleCseCap,
            fallback: 'brave_only',
            plan_id: activePlanId,
          },
        }).catch(() => {});
      }
    } catch { /* spendGuard import optional — never block the run */ }
  }
  const paidQueryBudget = signalPaidBudgetSplit(maxPaidQueries, maxLeads, { verticalFirst: verticalFirstExecution });
  const providerFanoutCaps = signalProviderFanoutCaps(maxPaidQueries, maxLeads);
  const executableDiscoveryQueries = executableDiscoveryQueriesForBudget(config.queries, paidQueryBudget);
  const zeroSet = await blockedByRepeatedZeroQuerySet(clientId, executableDiscoveryQueries);
  const platformFunnelTracker = createPlatformFunnelTracker({
    mode: platformPlan?.mode || 'proof',
    planId: activePlanId,
  });
  if (zeroSet.blocked) {
    console.log('[signalHunt] Blocking repeated zero-output query set for today');
    for (const q of executableDiscoveryQueries) {
      platformFunnelTracker.recordBlocked(q, 'repeated_zero_query_set');
    }
    return attachPlatformFunnelToSignalHuntResult([], platformFunnelTracker.events());
  }

  const allSignals = [];
  const leads = [];
  const rawSample = [];
  let queriesRun = 0;
  let rawResultsTotal = 0;
  const stageStats = initSignalHuntStageStats();
  if (decisionMakerProviders) stageStats.decision_maker_providers = decisionMakerProviders;
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
    if (shouldStopSignalDiscovery({ discoveryQueriesRun, paidQueryBudget })) {
      console.log('[signalHunt] Discovery-query budget reached; reserving paid budget for decision-maker lookup');
      break;
    }

    await assertLlmBudgetOpen(clientId);
    const provider = q.provider || 'brave';
    const validation = platformRegistry.validateQuery(q.query, provider);
    if (!validation.valid) {
      const queryBlocker = validation.blocker || 'provider_query_limit_exceeded';
      platformFunnelTracker.recordBlocked(q, queryBlocker, validation);
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'signal_query_blocked',
        target_type: 'system',
        metadata: {
          blocker: queryBlocker,
          plan_id: activePlanId || null,
          platform: q.platform || null,
          provider,
          query_hash: validation.query_hash,
          query_chars: validation.chars,
          query_words: validation.words,
          limits: validation.limits || null,
        },
      }).catch(() => {});
      await rememberZeroQuerySet(clientId, {
        key: zeroSet.key,
        hash: zeroSet.hash,
        queries: executableDiscoveryQueries,
        queriesRun,
        rawResultsTotal,
        blocker: queryBlocker,
      }).catch(() => {});
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'signal_hunt_complete',
        metadata: signalHuntCompleteMetadata({
          planId: activePlanId,
          config,
          queriesRun,
          paidQueryBudget,
          providerFanoutCaps,
          paidQueriesRemaining,
          rawSample,
          blocker: queryBlocker,
          stageStats,
        }),
      }).catch(() => {});
      console.log(`[signalHunt] Query blocked before provider call: ${queryBlocker}`);
      return attachPlatformFunnelToSignalHuntResult([], platformFunnelTracker.events());
    }

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
      platformFunnelTracker.recordSearch(q, safeResults);
      rawResultsTotal += safeResults.length;
      stageStats.raw_results_total = rawResultsTotal;
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

      const extracted = (verticalFirstExecution || isVerticalFirstQuery(q))
        ? verticalFirstSignalsFromResults(safeResults, { ...q, platform_plan_id: activePlanId || q.platform_plan_id || null })
        : await extractSignalsFromResults(clientId, safeResults, q, geoText);
      const validSignals = extracted.filter(s => s.company && validSignalCompanyName(s.company) && s.confidence >= 0.5);
      platformFunnelTracker.recordExtraction(q, validSignals.length);

      // Assign tier from the query config
      validSignals.forEach(s => {
        s.tier = q.tier || 'P2';
        s.country = country;
        s.signal_id = q.signal_id || q.signal_type;
        s.signal_family = q.signal_family || signalFamilyForType(q.signal_id || q.signal_type);
        s.source_channel = q.source_channel || 'web_search';
        s.platform = q.platform || q.source_channel || null;
        s.provider = provider;
        s.platform_plan_id = activePlanId || null;
        s.expected_industry = q.industry || s.expected_industry || null;
        s.expected_evidence = q.expected_evidence || s.expected_evidence || [];
        s.source_term = q.source_term || q.term || s.source_term || null;
        s.reject_rules = q.reject_rules || s.reject_rules || {};
        s.discovery_mode = q.discovery_mode || s.discovery_mode || null;
        s.discovery_lane = s.discovery_lane || s.metadata?.discovery_lane || null;
        s.signal_lite = s.signal_lite === true || s.metadata?.signal_lite === true;
        s.metadata = {
          ...(s.metadata || {}),
          ...(s.signal_lite ? { signal_lite: true } : {}),
          ...(s.discovery_lane ? { discovery_lane: s.discovery_lane } : {}),
          ...(s.discovery_mode ? { discovery_mode: s.discovery_mode } : {}),
        };
        s.query = q.query;
      });
      allSignals.push(...validSignals);

      console.log(`[signalHunt] Query "${q.signal_type}" extracted ${validSignals.length} signals`);
    } catch (err) {
      platformFunnelTracker.recordBlocked(q, 'provider_query_error');
      console.warn(`[signalHunt] Query failed: ${err.message}`);
    }
  }

  console.log(`[signalHunt] Total signals extracted: ${allSignals.length}`);
  stageStats.raw_results_total = rawResultsTotal;
  stageStats.raw_candidates_total = allSignals.length;

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
      metadata: signalHuntCompleteMetadata({
        planId: activePlanId,
        config,
        queriesRun,
        paidQueryBudget,
        providerFanoutCaps,
        paidQueriesRemaining,
        rawSample,
        blocker,
        stageStats,
      }),
    }).catch(() => {});
    return attachPlatformFunnelToSignalHuntResult([], platformFunnelTracker.events());
  }

  // Step 2: Dedupe by company name
  const seenCompanies = new Set();
  const uniqueSignals = allSignals.filter(s => {
    const key = (s.company || '').toLowerCase().trim();
    if (!key || seenCompanies.has(key)) return false;
    seenCompanies.add(key);
    return true;
  });
  stageStats.companies_extracted = uniqueSignals.length;

  // Step 3: Sort P1 first
  uniqueSignals.sort((a, b) => {
    const rank = { P1: 3, P2: 2, P3: 1 };
    return (rank[b.tier] || 0) - (rank[a.tier] || 0);
  });

  // Step 4: For each signal, find the decision-maker
  const icpTitles = titlesFromIcp(icp);

  // Vertical-first runs surface a wider candidate set (raised results-per-query)
  // because the ICP gate correctly rejects the top-ranked giants; we need
  // enough loop budget to reach the SME long-tail beneath them. The cheap
  // resolver + gate run for free before any paid lookup, so widening here
  // does not spend more paid budget per non-matching candidate.
  const candidateLoopCap = verticalFirstExecution
    ? Math.max(maxLeads * 4, 12)
    : maxLeads * 2;
  for (const signal of uniqueSignals.slice(0, candidateLoopCap)) {
    if (leads.length >= maxLeads) break;

    const country = signal.country || countryCodeFromText(signal.raw_snippet || signal.signal_summary || '') || 'MY';
    const countryName = countryNameFromCode(country);

    const isVerticalFirstCandidate = signal.discovery_lane === 'vertical_first'
      || signal.signal_lite === true
      || isVerticalFirstQuery(signal);

    let companyGate = null;
    let llmDecisionMaker = null;

    if (isVerticalFirstCandidate) {
      // ── Vertical-first: Research Beaver READS the page and judges. ──────────
      // Fetch the homepage (resolveCompanyIdentity), then hand the page text to
      // gpt-4.1-mini to decide real-company / in-ICP / 5-50 size / geo /
      // competitor / directory and pull a decision-maker if visible. This one
      // read replaces the title-scrape + aggregator host-list + keyword vertical
      // match + shape regex — the regex tower that saved directories, used page
      // titles as names, and false-rejected SMEs on homepage prose.
      const identity = await resolveCompanyIdentity(signal, {}).catch(() => null);
      let pageText = signal.raw_snippet || '';
      if (identity) {
        if (identity.company && identity.company !== signal.company) {
          signal.metadata = { ...(signal.metadata || {}), provisional_company: signal.company, company_identity_source: identity.source };
          signal.company = identity.company;
        }
        if (identity.website && !signal.company_website) signal.company_website = identity.website;
        if (identity.page_text) {
          pageText = identity.page_text;
          signal.company_description = [signal.company_description, identity.page_text].filter(Boolean).join(' ');
        }
      }

      const verdict = await qualifyCompanyByReading({
        clientId,
        company: signal.company,
        url: signal.company_website || signal.source_url || null,
        pageText: pageText || signal.company_description || signal.signal_summary,
        icp,
      });

      if (verdict.error) {
        // Commit 2: surface LLM failure — do NOT silently degrade to regex.
        stageStats.research_beaver_errors = (stageStats.research_beaver_errors || 0) + 1;
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: 'research_beaver_llm_failed',
          reason: verdict.error,
          metadata: { agent: 'research_beaver', stage: 'qualify_by_reading' },
        });
        console.warn(`[signalHunt] Research Beaver read FAILED for ${signal.company}: ${verdict.error}`);
        continue;
      }
      if (!verdict.qualified) {
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: 'research_beaver_disqualified',
          reason: verdict.reason || 'not_in_icp',
          metadata: {
            employee_band: verdict.employee_band,
            geo_ok: verdict.geo_ok,
            is_competitor: verdict.is_competitor,
            is_directory: verdict.is_directory,
            vertical_match: verdict.vertical_match,
          },
        });
        console.log(`[signalHunt] Research Beaver dropped ${signal.company}: ${verdict.reason}`);
        continue;
      }

      if (verdict.company_name) signal.company = verdict.company_name;
      companyGate = {
        pass: true,
        vertical_match: verdict.vertical_match,
        icp_evidence: verdict.vertical_match ? [verdict.vertical_match] : [],
        reject_rules_checked: ['research_beaver_read'],
      };
      signal.metadata = {
        ...(signal.metadata || {}),
        company_evidence_resolver: {
          company: signal.company,
          vertical_match: verdict.vertical_match,
          source: 'research_beaver_read',
          confidence: 0.9,
        },
        research_beaver_verdict: {
          employee_band: verdict.employee_band,
          geo_ok: verdict.geo_ok,
          reason: verdict.reason,
        },
      };
      if (verdict.decision_maker?.name && validDecisionMakerName(verdict.decision_maker.name)) {
        llmDecisionMaker = {
          name: verdict.decision_maker.name,
          title: verdict.decision_maker.title || '',
          source: 'research_beaver_read',
          source_url: signal.company_website || null,
        };
      }
      stageStats.icp_passed++;
      platformFunnelTracker.recordVerticalVerified(signal);
    } else {
      const proofGate = jobBoardProofGate(signal, signal);
      if (!proofGate.ok) {
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: proofGate.blocker,
          reason: proofGate.reason,
        });
        platformFunnelTracker.recordBlocked(signal, proofGate.blocker);
        console.log(`[signalHunt] Job-board proof blocked ${signal.company}: ${proofGate.reason}`);
        continue;
      }

      // ── Signal-first: existing regex evidence + ICP gate (unchanged). ──────
      const companyEvidence = await resolveCompanyEvidence(signal, icp).catch(err => ({
        company: signal.company,
        vertical_match: null,
        evidence: [],
        source: 'resolver_error',
        confidence: 0,
        error: err.message,
      }));
      if (!companyEvidence?.vertical_match) {
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: 'company_vertical_unproven',
          reason: 'company_vertical_unproven',
          metadata: {
            expected_verticals: icpVerticalTerms(icp),
            resolver_source: companyEvidence?.source || null,
            resolver_confidence: companyEvidence?.confidence ?? null,
            resolver_error: companyEvidence?.error || null,
          },
        });
        console.log(`[signalHunt] Company evidence resolver blocked ${signal.company}: vertical unproven`);
        continue;
      }
      const resolverEvidenceText = (companyEvidence.evidence || [])
        .map(item => item?.text || item)
        .filter(Boolean)
        .join(' ');
      signal.company_description = [
        signal.company_description,
        resolverEvidenceText,
      ].filter(Boolean).join(' ');
      signal.metadata = {
        ...(signal.metadata || {}),
        company_evidence_resolver: companyEvidence,
      };
      companyGate = evaluateSignalCompanyIcpGate(signal, icp);
      if (!companyGate.pass) {
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: companyGate.blocker || 'icp_zero_after_company_extract',
          reason: companyGate.reason || 'company_icp_gate_failed',
          metadata: {
            matched_terms: companyGate.matched_terms || [],
            expected_verticals: companyGate.expected_verticals || [],
            reject_rules_checked: companyGate.reject_rules_checked || [],
          },
        });
        console.log(`[signalHunt] Company ICP gate blocked ${signal.company}: ${companyGate.reason}`);
        continue;
      }
      stageStats.icp_passed++;
      platformFunnelTracker.recordVerticalVerified(signal);

      // Cheap pre-lookup company-shape gate (name + snippet only) for the
      // signal-first lane. Vertical-first relies on the Research Beaver read.
      const { companyShapeRejection } = require('./agents');
      const shapeRejection = companyShapeRejection([signal.company, signal.raw_snippet, signal.signal_summary].filter(Boolean).join(' '));
      if (shapeRejection) {
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: 'company_shape_pre_lookup',
          reason: shapeRejection.reason,
          metadata: { rejected_status: shapeRejection.status, matched_on: 'name_and_snippet' },
        });
        console.log(`[signalHunt] Pre-lookup company-shape block on ${signal.company}: ${shapeRejection.reason}`);
        continue;
      }
    }

    // signal.company is now canonical (vertical-first identity resolver or
    // signal-first company evidence resolver). Skip duplicates here so we
    // don't burn the decision-maker lookup + Anymail/Icypeas/Snov/Hunter/
    // MillionVerifier waterfall re-enriching a lead already in the pool.
    if (signal.company) {
      const existing = await pool.query(
        `SELECT id FROM leads
         WHERE client_id = $1
           AND lower(company) = lower($2)
           AND deleted_at IS NULL
         LIMIT 1`,
        [clientId, signal.company]
      );
      if (existing.rows.length > 0) {
        stageStats.duplicate_company_pre_enrichment = (stageStats.duplicate_company_pre_enrichment || 0) + 1;
        await logsService.createLog(clientId, {
          agent: 'research_beaver',
          action: 'signal_lead_duplicate_skipped',
          target_type: 'lead',
          target_id: existing.rows[0].id,
          metadata: {
            source: 'signal_hunt',
            stage: 'pre_enrichment',
            lead_company: signal.company,
            signal_id: signal.signal_id || null,
          },
        }).catch(() => {});
        console.log(`[signalHunt] Pre-enrichment dedup skip: ${signal.company} already in pool`);
        continue;
      }
    }

    // ── Decision-maker. Use the one Research Beaver read off the page (free,
    // no extra paid query); otherwise fall back to the paid lookup. ──────────
    let person = llmDecisionMaker;
    if (!person) {
      await assertLlmBudgetOpen(clientId);
      if (!consumePaidQuery(1)) {
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: 'provider_cap_closed',
          reason: 'paid_query_budget_exhausted_before_decision_maker_lookup',
        });
        console.log('[signalHunt] Paid-query budget exhausted before decision-maker lookup');
        break;
      }
      let decisionMakerFallbackBlocked = false;
      person = await findDecisionMaker(signal.company, icpTitles, country, {
        clientId,
        consumeFallbackSearch: () => {
          const allowed = consumePaidQuery(1);
          if (!allowed) decisionMakerFallbackBlocked = true;
          return allowed;
        },
      });
      if (!person || !person.name) {
        await logSignalHuntMiss(clientId, {
          signal,
          blocker: decisionMakerFallbackBlocked ? 'provider_cap_closed' : 'decision_maker_zero',
          reason: decisionMakerFallbackBlocked ? 'paid_query_budget_exhausted_before_linkedin_decision_maker_lookup' : 'decision_maker_not_found',
        });
        console.log(`[signalHunt] No decision-maker found for ${signal.company}`);
        continue;
      }
    }
    stageStats.decision_makers_found++;

    const { applyIcpV2Filter } = require('./agents');
    const gate = applyIcpV2Filter({
      name: person.name,
      company: signal.company,
      title: person.title || '',
      country: countryName,
      // Final safety net runs on the ORIGINAL Brave snippet, not the scraped
      // homepage prose — prose over-matches gov/edu/global terms and
      // false-rejects real SMEs (e.g. one that "trains government clients").
      snippet: signal.raw_snippet || '',
      score: signal.tier === 'P1' ? 90 : 70,
      metadata: {
        country: countryName,
        company_icp_fit: {
          vertical_match: companyGate.vertical_match || null,
          geo_match: countryName,
          size_signal: null,
          icp_evidence: companyGate.icp_evidence || [],
          reject_rules_checked: companyGate.reject_rules_checked || [],
        },
      },
    });
    if (!gate.pass) {
      await logSignalHuntMiss(clientId, {
        signal,
        blocker: gate.reason === 'competitor_offer_disqualified' ? 'competitor_offer_disqualified' : 'icp_zero_after_company_extract',
        reason: gate.reason || 'person_icp_gate_failed',
        metadata: {
          person_name: person.name,
          person_title: person.title || null,
        },
      });
      console.log(`[signalHunt] ICP gate blocked ${person.name} / ${signal.company}: ${gate.reason}`);
      continue;
    }

    // Step 5: email enrichment. Sources via Anymail -> Icypeas -> Snov -> Hunter, then
    // trusts only MillionVerifier for deliverability.
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
        maxAnymailCalls: providerFanoutCaps.maxAnymailCallsPerLead,
        maxIcypeasCalls: providerFanoutCaps.maxIcypeasCallsPerLead,
        maxSnovCalls: providerFanoutCaps.maxSnovCallsPerLead,
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
      linkedin_url: person.linkedin_url || null,
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
        platform: signal.platform || null,
        provider: signal.provider || null,
        platform_plan_id: signal.platform_plan_id || null,
        discovery_mode: signal.discovery_mode || null,
        discovery_lane: signal.discovery_lane || signal.metadata?.discovery_lane || null,
        signal_lite: signal.signal_lite === true || signal.metadata?.signal_lite === true,
        source_url: signal.source_url,
        evidence: signal.signal_summary || signal.raw_snippet || signal.why_now,
        signal: signal.signal_summary,
        why_now: signal.why_now,
        angle: signal.angle,
        signal_type: signal.signal_type,
        signal_source_url: signal.source_url,
        signal_confidence: signal.confidence,
        decision_maker_source_url: person.source_url || person.linkedin_url || null,
        decision_maker: {
          name: person.name,
          title: person.title || '',
          source_url: person.source_url || person.linkedin_url || null,
          source: person.source || null,
        },
        country: countryName,
        industry_match: companyGate.vertical_match || null,
        icp_evidence: companyGate.icp_evidence || [],
        reject_rules_checked: companyGate.reject_rules_checked || [],
        expected_industry: signal.expected_industry || null,
        expected_evidence: signal.expected_evidence || [],
        source_term: signal.source_term || null,
        tier: signal.tier,
        source: 'signal_hunt',
      },
    }, {
      evidenceDate: signal.signal_date || undefined,
      source_channel: signal.source_channel || 'web_search',
    }));
    stageStats.contacts_found++;
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'signal_hunt_complete',
    metadata: signalHuntCompleteMetadata({
      planId: activePlanId,
      config,
      queriesRun,
      paidQueryBudget,
      providerFanoutCaps,
      paidQueriesRemaining,
      rawSample,
      blocker: leads.length === 0 ? 'contact_zero' : null,
      stageStats,
      tiers: leads.reduce((acc, l) => {
        acc[l.signal_tier] = (acc[l.signal_tier] || 0) + 1;
        return acc;
      }, {}),
    }),
  }).catch(() => {});

  if (leads.length === 0) {
    await rememberZeroQuerySet(clientId, {
      key: zeroSet.key,
      hash: zeroSet.hash,
      queries: executableDiscoveryQueries,
      queriesRun,
      rawResultsTotal,
      blocker: 'contact_zero',
    }).catch(() => {});
  }

  console.log(`[signalHunt] Returning ${leads.length} leads with decision-makers`);
  return attachPlatformFunnelToSignalHuntResult(leads, platformFunnelTracker.events());
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
        metadata: missingSignalPackageSaveMetadata(lead, missingPackageFields),
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
      await logSignalHuntMiss(clientId, {
        signal: lead.metadata?.signal_package || lead.metadata || lead,
        blocker: 'contact_zero',
        reason: gateResult.missReason || 'contact_gate_blocked',
        metadata: {
          lead_name: lead.name || null,
          lead_company: lead.company || null,
          contact_gate: gateResult,
        },
      });
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
        const pkg = lead.metadata?.signal_package || {};
        await logsService.createLog(clientId, {
          agent: 'research_beaver',
          action: 'signal_hunt_save_complete',
          target_type: 'lead',
          target_id: res.rows[0].id,
          metadata: {
            source: 'signal_hunt',
            ...signalIdentity(pkg),
            lead_name: lead.name || null,
            lead_company: lead.company || null,
            saved: 1,
            contacts_found: 1,
            lead_tier: leadTier,
          },
        }).catch(() => {});
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
  platformFunnelFromSignalHuntResult,
  _test: {
    applySignalPlaybookToConfig,
    applyApprovedPlatformPlanToConfig,
    qualifyCompanyByReading,
    MAX_SIGNAL_RESULTS_PER_QUERY,
    MAX_VERTICAL_RESULTS_PER_QUERY,
    attachSignalPackageToSignalLead,
    signalPackageMissingFields,
    signalFamilyForType,
    buildSignalQueriesFromIcp,
    sourceAwareQueriesForCountry,
    titlesFromIcp,
    evaluateSignalCompanyIcpGate,
    signalExtractionAgent,
    normaliseExtractedSignals,
    extractedSignalItems,
    deterministicPublicationSignals,
    deterministicHiringSignals,
    jobBoardProofGate,
    genericJobBoardPageReason,
    isSpecificHiringProofUrl,
    isVerticalFirstPlatformPlan,
    verticalFirstSignalsFromResults,
    missingSignalPackageSaveMetadata,
    validSignalCompanyName,
    validDecisionMakerName,
    mergeExtractedSignalSets,
    signalQuerySetHash,
    signalQueryWindow,
    signalPaidBudgetSplit,
    signalProviderFanoutCaps,
    createPlatformFunnelTracker,
    platformFunnelFromSignalHuntResult,
    executableDiscoveryQueriesForBudget,
    shouldStopSignalDiscovery,
    trustedSignalHuntConfigContent,
    querySourceForSignalConfig,
  },
};
