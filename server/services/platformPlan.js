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

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function excludedPlatformsFor(signalFamily, selectedPlatforms, allPlatforms) {
  const selected = new Set(selectedPlatforms.map(platform => platform.id));
  const available = new Set(allPlatforms.map(platform => platform.id));
  const excluded = [];

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
  const signal = firstActiveSignal(icp);
  const signalFamily = signal.family || signal.signal_family || 'hiring_capability_build';
  const signalId = signal.id || signal.signal_id || 'hiring_sales_roles';
  const geo = firstGeo(icp);
  const industry = activeIndustry(icp);
  const requested = positiveInteger(requestedCount, 5);
  const paidQueryLimit = positiveInteger(maxPaidQueries, requested);
  const allowed = allowedPlatforms ? new Set(allowedPlatforms) : null;
  const allPlatforms = registry.platformsFor({ signalFamily, geo });
  const platforms = allPlatforms
    .filter(platform => !allowed || allowed.has(platform.id))
    .slice(0, paidQueryLimit);

  const platformSequence = platforms.map((platform, index) => {
    const query = signalFamily === 'hiring_capability_build'
      ? hiringQueryForPlatform(platform.id, industry, geo)
      : `"${industry}" "${geo}" "${signalId}"`;
    const queryValidation = registry.validateQuery(query, platform.provider);
    return {
      order: index + 1,
      platform: platform.id,
      provider: platform.provider,
      source_channel: platform.source_channel,
      signal_id: signalId,
      signal_family: signalFamily,
      geo,
      parser: platform.parser,
      evidence_required: platform.evidenceRequired,
      query,
      query_validation: queryValidation,
      paid_units_estimate: queryValidation.valid ? 1 : 0,
      success_condition: `${platform.evidenceRequired.join(' + ')} present and ICP gate passes`,
      why: `${platform.label} is a configured ${geo} platform for ${signalFamily}`,
    };
  });

  const hashInput = platformPlanHashInput({
    client_id: clientId,
    mode,
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
    mode,
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
    excluded_platforms: excludedPlatformsFor(signalFamily, platforms, allPlatforms),
    query_set_hash: hashPlan(platformSequence.map(item => item.query)),
    plan_hash: planHash,
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

  const row = rows[0];
  return {
    ...row,
    platform_sequence: array(normalizeStoredJson(row.platform_sequence, [])),
    excluded_platforms: array(normalizeStoredJson(row.excluded_platforms, [])),
    stop_rule: normalizeStoredJson(row.stop_rule, {}) || {},
  };
}

module.exports = {
  buildPlatformPlan,
  hashPlan,
  loadApprovedPlatformPlan,
  stableJson,
  verifyPlatformPlanHash,
};
