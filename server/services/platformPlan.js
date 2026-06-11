'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');
const registry = require('./platformRegistry');

function list(value) {
  return Array.isArray(value) ? value.map(item => String(item).trim()).filter(Boolean) : [];
}

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = sortObject(value[key]);
    return acc;
  }, {});
}

function stableJson(value) {
  return JSON.stringify(sortObject(value));
}

function hashPlan(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

function platformPlanHashInput(plan = {}) {
  return {
    client_id: plan.client_id,
    mode: plan.mode,
    discovery_mode: plan.discovery_mode || null,
    objective: plan.objective,
    requested_count: Number(plan.requested_count),
    max_paid_queries: Number(plan.max_paid_queries),
    platform_sequence: array(plan.platform_sequence).map(item => ({
      platform: item.platform,
      query: item.query,
      signal_id: item.signal_id,
      geo: item.geo,
    })),
  };
}

function verifyPlatformPlanHash(plan = {}) {
  if (!plan || typeof plan !== 'object' || !plan.plan_hash) return false;
  return hashPlan(platformPlanHashInput(plan)) === plan.plan_hash;
}

function signalCandidates(icp = {}) {
  return [
    ...array(icp.icp?.buying_signals),
    ...array(icp.buying_signals),
  ];
}

function firstActiveSignal(icp = {}) {
  return signalCandidates(icp).find(signal => signal.enabled !== false) || {
    id: 'hiring_sales_roles',
    family: 'hiring_capability_build',
  };
}

function hasConfiguredBuyingSignals(icp = {}) {
  return signalCandidates(icp).some(signal => signal && signal.enabled !== false);
}

function hasVerticalFirstDiscoverySignal(icp = {}) {
  return signalCandidates(icp)
    .filter(signal => signal && signal.enabled !== false)
    .some(signal => (
      signal.family === 'vertical_first_discovery'
      || signal.signal_family === 'vertical_first_discovery'
      || signal.id === 'vertical_first_discovery'
      || signal.signal_id === 'vertical_first_discovery'
      || (Array.isArray(signal.source_channels) && signal.source_channels.includes('vertical_first'))
    ));
}

function firstGeo(icp = {}) {
  const candidates = [
    ...list(icp.icp?.geographies),
    ...list(icp.icp?.geo),
    ...list(icp.geographies),
    ...list(icp.geo),
  ];
  return String(candidates[0] || 'MY').toUpperCase();
}

function activeIndustry(icp = {}) {
  const candidates = [
    ...list(icp.icp?.active_industries),
    ...list(icp.icp?.verticals),
    ...list(icp.active_industries),
    ...list(icp.verticals),
  ];
  return candidates[0] || 'corporate training';
}

function configuredActiveIndustries(icp = {}) {
  const candidates = [
    ...list(icp.icp?.active_industries),
    ...list(icp.icp?.verticals),
    ...list(icp.active_industries),
    ...list(icp.verticals),
  ];
  const seen = new Set();
  const unique = candidates.filter(item => {
    const key = item.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique;
}

function activeIndustries(icp = {}) {
  const unique = configuredActiveIndustries(icp);
  return unique.length > 0 ? unique : [activeIndustry(icp)];
}

function hiringLocation(geo) {
  if (geo === 'MY') return 'Malaysia';
  if (geo === 'SG') return 'Singapore';
  return geo;
}

const HIRING_ROLES = '("sales executive" OR "business development" OR "account manager")';

function hiringQueryForPlatform(platformId, industry, geo) {
  const location = hiringLocation(geo);
  if (platformId === 'jobstreet_my') return `site:my.jobstreet.com ${HIRING_ROLES} ${location}`;
  if (platformId === 'hiredly_my') return `site:hiredly.com ${HIRING_ROLES} ${location}`;
  if (platformId === 'linkedin_jobs') return `site:linkedin.com/jobs/view ${HIRING_ROLES} ${location}`;
  if (platformId === 'company_careers') return `("careers" OR "jobs") ${HIRING_ROLES} ${location}`;
  return `${HIRING_ROLES} ${location}`;
}

function planModeForRequest(mode) {
  return String(mode || 'proof') === 'vertical_first' ? 'proof' : String(mode || 'proof');
}

function discoveryModeForRequest(mode) {
  return String(mode || '') === 'vertical_first' ? 'vertical_first' : 'signal_first';
}

function sourcingLaneDefaultForPlan(icp = {}, requestedMode = 'proof') {
  if (discoveryModeForRequest(requestedMode) === 'vertical_first') return null;
  const industries = configuredActiveIndustries(icp);
  if (industries.length === 0) return null;
  if (hasVerticalFirstDiscoverySignal(icp)) return null;
  if (hasConfiguredBuyingSignals(icp)) {
    return {
      from: 'signal_first',
      to: 'vertical_first',
      reason: 'tenant_vertical_icp_generic_signals',
      active_industries: industries,
    };
  }
  return {
    from: 'signal_first',
    to: 'vertical_first',
    reason: 'tenant_buying_signals_empty_vertical_icp',
    active_industries: industries,
  };
}

function verticalQueryTerm(industry = '') {
  const value = String(industry || '').trim();
  if (/corporate training|professional training|l&d|learning|coaching|skills development/i.test(value)) {
    return 'corporate training';
  }
  if (/marketing|digital|creative|advertising|media|content|pr|communications?/i.test(value)) {
    return 'marketing agency';
  }
  return value || 'B2B services';
}

// Geo-expanded locality phrase for vertical-first discovery. Bare country
// names ("Malaysia") concentrate the SEO ranking on the biggest national
// players; pairing the country with major MY/SG cities widens recall toward
// regional SMEs that rank higher for city-scoped queries.
function verticalLocation(geo) {
  if (geo === 'MY') return '("Malaysia" OR "Kuala Lumpur" OR "Petaling Jaya" OR "Selangor" OR "Penang" OR "Johor")';
  if (geo === 'SG') return '("Singapore" OR "Tanjong Pagar" OR "Raffles Place")';
  return `"${hiringLocation(geo)}"`;
}

// Cheap negative exclusions for the highest-frequency global-network brands.
// Mirrors (a subset of) the tenant exclusion list, but applied AT QUERY TIME
// so giants are filtered by Brave before ever entering the funnel. Keeps
// query length comfortably under the 400-char / 50-word limit. The
// pre-lookup enterprise/global gate (signalHunt) catches the rest from
// homepage text.
const GLOBAL_BRAND_NEGATIVES = '-"WPP" -"Publicis" -"Dentsu" -"Omnicom" -"Fortune 500" -"global network"';

function verticalFirstQueryForPlatform(platformId, industry, geo) {
  const location = verticalLocation(geo);
  const term = verticalQueryTerm(industry);
  const isAgency = /agency|marketing|digital|creative|advertising|media|content|pr/i.test(term);
  const isTraining = /training|learning|coaching|skill/i.test(term);

  let base;
  if (platformId === 'agency_directory') {
    base = isAgency
      ? `("marketing agency" OR "digital agency" OR "creative agency" OR "PR agency") ${location}`
      : `("${term}" OR "${term} provider" OR "${term} company") ${location}`;
  } else if (platformId === 'training_directory') {
    base = isTraining
      ? `("corporate training provider" OR "training company" OR "learning and development provider") ${location}`
      : `("${term}" OR "${term} firm" OR "${term} company") ${location}`;
  } else {
    base = `"${term}" ${location} (company OR provider OR agency)`;
  }
  return `${base} ${GLOBAL_BRAND_NEGATIVES}`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function excludedPlatformsFor(signalFamily, selectedPlatforms, allPlatforms, discoveryMode = 'signal_first') {
  const selected = new Set(selectedPlatforms.map(platform => platform.id));
  const available = new Set(allPlatforms.map(platform => platform.id));
  const excluded = [];

  if (discoveryMode === 'vertical_first') {
    return ['jobstreet_my', 'hiredly_my', 'linkedin_jobs', 'company_careers'].map(platform => ({
      platform,
      reason: 'vertical-first discovery sources company vertical directly; hiring platforms stay secondary',
    }));
  }

  if (
    signalFamily === 'hiring_capability_build'
    && available.has('press_news')
    && !selected.has('press_news')
  ) {
    excluded.push({
      platform: 'press_news',
      reason: 'lower precision for hiring proof; stronger job platforms are available first',
    });
  }

  return excluded;
}

function buildPlatformPlan({
  clientId,
  icp = {},
  objective = 'find in-ICP approval-ready leads',
  requestedCount = 5,
  maxPaidQueries = 5,
  mode = 'proof',
  allowedPlatforms = null,
} = {}) {
  const requestedMode = String(mode || 'proof');
  const planMode = planModeForRequest(requestedMode);
  const sourcingLaneDefaulted = sourcingLaneDefaultForPlan(icp, requestedMode);
  const discoveryMode = sourcingLaneDefaulted
    ? 'vertical_first'
    : discoveryModeForRequest(requestedMode);
  const signal = firstActiveSignal(icp);
  const signalFamily = discoveryMode === 'vertical_first'
    ? 'vertical_first_discovery'
    : (signal.family || signal.signal_family || 'hiring_capability_build');
  const signalId = discoveryMode === 'vertical_first'
    ? 'vertical_first_discovery'
    : (signal.id || signal.signal_id || 'hiring_sales_roles');
  const geo = firstGeo(icp);
  const industry = activeIndustry(icp);
  const industries = activeIndustries(icp);
  const requested = positiveInteger(requestedCount, 5);
  const paidQueryLimit = positiveInteger(maxPaidQueries, requested);
  const allowed = allowedPlatforms ? new Set(allowedPlatforms) : null;
  const allPlatforms = discoveryMode === 'vertical_first'
    ? registry.platformsFor({ discoveryMode, geo })
    : registry.platformsFor({ signalFamily, geo });
  const platformInputs = discoveryMode === 'vertical_first'
    ? industries.flatMap(sourceIndustry => allPlatforms.map(platform => ({ platform, industry: sourceIndustry })))
    : allPlatforms.map(platform => ({ platform, industry }));
  const selectedInputs = platformInputs
    .filter(item => !allowed || allowed.has(item.platform.id))
    .slice(0, paidQueryLimit);

  const platformSequence = selectedInputs.map(({ platform, industry: sourceIndustry }, index) => {
    const query = discoveryMode === 'vertical_first'
      ? verticalFirstQueryForPlatform(platform.id, sourceIndustry, geo)
      : (signalFamily === 'hiring_capability_build'
        ? hiringQueryForPlatform(platform.id, sourceIndustry, geo)
        : `"${sourceIndustry}" "${geo}" "${signalId}"`);
    const queryValidation = registry.validateQuery(query, platform.provider);
    return {
      order: index + 1,
      platform: platform.id,
      provider: platform.provider,
      source_channel: platform.source_channel,
      signal_id: signalId,
      signal_family: signalFamily,
      discovery_mode: discoveryMode,
      geo,
      source_term: sourceIndustry,
      parser: platform.parser,
      evidence_required: platform.evidenceRequired,
      query,
      query_validation: queryValidation,
      paid_units_estimate: queryValidation.valid ? 1 : 0,
      success_condition: `${platform.evidenceRequired.join(' + ')} present and ICP gate passes`,
      why: discoveryMode === 'vertical_first'
        ? `${platform.label} discovers ${sourceIndustry} companies in ${geo} before attaching a signal`
        : `${platform.label} is a configured ${geo} platform for ${signalFamily}`,
    };
  });

  const hashInput = platformPlanHashInput({
    client_id: clientId,
    mode: planMode,
    discovery_mode: discoveryMode,
    objective,
    requested_count: requested,
    max_paid_queries: paidQueryLimit,
    platform_sequence: platformSequence.map(item => ({
      platform: item.platform,
      query: item.query,
      signal_id: item.signal_id,
      geo: item.geo,
    })),
  });
  const planHash = hashPlan(hashInput);

  return {
    client_id: clientId,
    mode: planMode,
    requested_mode: requestedMode,
    discovery_mode: discoveryMode,
    objective,
    requested_count: requested,
    max_paid_queries: paidQueryLimit,
    approval_required: mode !== 'trusted_scheduled',
    stop_rule: {
      min_yield_pct: 30,
      stop_on_zero_candidates: true,
      stop_on_invalid_query: true,
      stop_on_provider_error_for_primary_platform: true,
    },
    platform_sequence: platformSequence,
    excluded_platforms: excludedPlatformsFor(
      signalFamily,
      selectedInputs.map(item => item.platform),
      allPlatforms,
      discoveryMode
    ),
    query_set_hash: hashPlan(platformSequence.map(item => item.query)),
    plan_hash: planHash,
    sourcing_lane_defaulted: sourcingLaneDefaulted,
    required_confirmation: `Approve this exact platform plan by confirming plan_hash=${planHash}.`,
  };
}

function normalizeStoredJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePlatformPlanRow(row = {}) {
  return {
    ...row,
    platform_sequence: array(normalizeStoredJson(row.platform_sequence, [])),
    excluded_platforms: array(normalizeStoredJson(row.excluded_platforms, [])),
    stop_rule: normalizeStoredJson(row.stop_rule, {}) || {},
  };
}

async function loadApprovedPlatformPlan(clientId, planId, planHash) {
  if (!clientId || !planId || !planHash) {
    const err = new Error('Approved platform plan is required before paid signal execution');
    err.code = 'platform_plan_required';
    throw err;
  }

  const { rows } = await pool.query(
    `SELECT id, client_id, status, mode, objective, requested_count, max_paid_queries,
            budget_cap_usd, platform_sequence, excluded_platforms, stop_rule,
            query_set_hash, plan_hash, approved_by, approved_at, expires_at
       FROM platform_plans
      WHERE client_id = $1
        AND id = $2
        AND plan_hash = $3
        AND status = 'approved'
        AND expires_at > NOW()
      LIMIT 1`,
    [clientId, planId, planHash]
  );

  if (rows.length === 0) {
    const err = new Error('Approved platform plan is required before paid signal execution');
    err.code = 'platform_plan_required';
    throw err;
  }

  return normalizePlatformPlanRow(rows[0]);
}

async function loadLatestApprovedPlatformPlan(clientId, { discoveryMode = null } = {}) {
  if (!clientId) return null;
  const { rows } = await pool.query(
    `SELECT id, client_id, status, mode, objective, requested_count, max_paid_queries,
            budget_cap_usd, platform_sequence, excluded_platforms, stop_rule,
            query_set_hash, plan_hash, approved_by, approved_at, expires_at, created_at
       FROM platform_plans
      WHERE client_id = $1
        AND status = 'approved'
        AND expires_at > NOW()
      ORDER BY approved_at DESC NULLS LAST, created_at DESC
      LIMIT 10`,
    [clientId]
  );
  const plans = rows.map(normalizePlatformPlanRow);
  if (!discoveryMode) return plans[0] || null;
  return plans.find(plan => (
    Array.isArray(plan.platform_sequence)
    && plan.platform_sequence.some(step => step.discovery_mode === discoveryMode)
  )) || null;
}

module.exports = {
  buildPlatformPlan,
  hashPlan,
  loadApprovedPlatformPlan,
  loadLatestApprovedPlatformPlan,
  stableJson,
  verifyPlatformPlanHash,
};
