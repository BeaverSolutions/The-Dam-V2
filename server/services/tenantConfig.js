'use strict';

/**
 * Tenant Config Service — Phase A of Research Beaver redesign.
 *
 * Reads per-tenant configuration that customizes a single shared
 * Research Beaver / Sales Beaver / Enforcer code path. Each tenant
 * has its own ICP rules, signal preferences, offering description,
 * quality weights, VP cost gates, and daily lead floor — that is
 * the entire "trained Beaver per tenant" specialization.
 *
 * Schema lives in clients table (migration 051).
 *
 * Phase A is read-only for behavior. Phases B-F start ACTING on the
 * values returned here. Until then, callers can use this service
 * but the existing hardcoded constants in services/agents.js still
 * drive runtime behavior.
 */

const pool = require('../db/pool');

/* ─── Defaults ─────────────────────────────────────────────────────── */

// These mirror what services/agents.js applyIcpV2Filter currently enforces
// in code. When a tenant has NULL icp_config, we fall back to these so
// nothing breaks. Beaver Solutions is seeded with these in migration 051.
const LEGACY_DEFAULT_ICP = Object.freeze({
  countries: ['Malaysia', 'Singapore', 'Indonesia', 'Philippines', 'Thailand', 'Vietnam'],
  titles: {
    senior_standalone: ['Founder', 'CEO', 'CTO', 'CMO', 'Co-founder', 'Owner', 'Director'],
    senior_leader: ['VP Marketing', 'VP Sales', 'Head of Marketing', 'Head of Sales', 'Marketing Director', 'Sales Director'],
    junior_ic_regex: '(specialist|coordinator|associate|intern|junior|assistant|executive)',
  },
  verticals: ['digital_marketing', 'digital_agency', 'marketing_services', 'advertising'],
  company_size: { min: 5, max: 50 },
  banned_regex: ['freelance', 'freelancer', 'self-employed', 'looking for opportunities'],
});

const LEGACY_DEFAULT_SIGNALS = Object.freeze({
  funding: 0.9,
  hiring_marketing: 0.7,
  hiring_sales: 0.7,
  exec_change: 0.6,
  product_launch: 0.5,
  scaling_pain: 0.8,
  expansion: 0.6,
  competitor_switch: 0.4,
});

// Equal weights with mild bias toward signal strength. These are starting
// points for a brand-new tenant — Phase D auto-tunes from outcome data.
const DEFAULT_QUALITY_WEIGHTS = Object.freeze({
  signal: 0.40,
  title: 0.25,
  reachability: 0.20,
  segment_history: 0.15,
});

const DEFAULT_VP_BUDGET_CREDITS = 25;
const DEFAULT_VP_THRESHOLD = 75;
const DEFAULT_DAILY_LEAD_FLOOR = 100;

function tenantProfileToLegacyConfig(profile) {
  const icp = profile?.icp || {};
  const personas = Array.isArray(icp.personas) ? icp.personas : [];
  const verticals = Array.isArray(icp.verticals) ? icp.verticals : [];
  const geo = Array.isArray(icp.geo) ? icp.geo : [];

  if (personas.length === 0 && verticals.length === 0 && geo.length === 0) return null;

  return {
    countries: geo,
    titles: {
      senior_standalone: personas.filter(p => /founder|owner|ceo|chief executive|managing director|president|principal|proprietor/i.test(String(p))),
      senior_leader: personas.filter(p => /head|vp|director|chief|gm|general manager/i.test(String(p))),
      junior_ic_regex: '(specialist|coordinator|associate|intern|junior|assistant|executive)',
    },
    verticals,
    company_size: { min: 2, max: 100 },
    banned_regex: Array.isArray(icp.exclusions) ? icp.exclusions : [],
    source: 'tenant_profiles',
  };
}

async function getActiveTenantProfileConfig(clientId) {
  try {
    const { rows } = await pool.query(
      `SELECT profile, content_version, updated_at
         FROM tenant_profiles
        WHERE client_id = $1 AND status = 'active'
        LIMIT 1`,
      [clientId]
    );
    const mapped = tenantProfileToLegacyConfig(rows[0]?.profile);
    if (!mapped) return null;
    return {
      icp_config: mapped,
      tenant_profile_content_version: rows[0].content_version,
      tenant_profile_updated_at: rows[0].updated_at,
    };
  } catch (err) {
    console.warn('[tenantConfig] tenant_profiles overlay failed:', err.message);
    return null;
  }
}

/* ─── Read full tenant config ──────────────────────────────────────── */

/**
 * Returns the full per-tenant config block, with NULL fields filled
 * by sensible defaults so callers never need to null-check downstream.
 *
 * @param {string} clientId — UUID of the tenant
 * @returns {Promise<TenantConfig|null>} null if tenant doesn't exist
 */
async function getTenantConfig(clientId) {
  const { rows } = await pool.query(
    `SELECT id, slug, name, is_active, onboarding_completed,
            icp_config, signal_preferences, offering, quality_weights,
            vp_daily_budget_credits, vp_threshold_score,
            vp_credits_used_today, vp_credits_used_total, vp_credits_reset_at,
            daily_quality_lead_floor, daily_budget_usd, auto_approve_threshold
     FROM clients
     WHERE id = $1`,
    [clientId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  const profileOverlay = await getActiveTenantProfileConfig(clientId);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    is_active: row.is_active,
    onboarding_completed: row.onboarding_completed,

    // Hybrid-default: if column is NULL, use legacy default and flag it.
    // Phase D will warn when a tenant runs on legacy defaults too long.
    icp_config:          profileOverlay?.icp_config || row.icp_config || LEGACY_DEFAULT_ICP,
    signal_preferences:  row.signal_preferences || LEGACY_DEFAULT_SIGNALS,
    offering:            row.offering           || null,
    quality_weights:     row.quality_weights    || DEFAULT_QUALITY_WEIGHTS,

    vp_daily_budget_credits: row.vp_daily_budget_credits ?? DEFAULT_VP_BUDGET_CREDITS,
    vp_threshold_score:      row.vp_threshold_score      ?? DEFAULT_VP_THRESHOLD,
    vp_credits_used_today:   row.vp_credits_used_today   || 0,
    vp_credits_used_total:   row.vp_credits_used_total   || 0,
    vp_credits_reset_at:     row.vp_credits_reset_at     || null,

    daily_quality_lead_floor: row.daily_quality_lead_floor ?? DEFAULT_DAILY_LEAD_FLOOR,
    daily_budget_usd:         Number(row.daily_budget_usd) || 10,
    auto_approve_threshold:   row.auto_approve_threshold ?? 75,

    // Tracks whether config is bootstrap-default vs onboarded
    using_default_icp:       !profileOverlay?.icp_config && !row.icp_config,
    using_tenant_profile_icp: !!profileOverlay?.icp_config,
    tenant_profile_content_version: profileOverlay?.tenant_profile_content_version || null,
    tenant_profile_updated_at: profileOverlay?.tenant_profile_updated_at || null,
    using_default_signals:   !row.signal_preferences,
    using_default_weights:   !row.quality_weights,
    has_offering:            !!row.offering,
  };
}

/**
 * Bulk-list configs for all active tenants. Used by Research Beaver's
 * morning loop to iterate every active tenant.
 */
async function listActiveTenantConfigs() {
  const { rows } = await pool.query(
    `SELECT id FROM clients WHERE is_active = true AND onboarding_completed = true ORDER BY name`
  );
  return Promise.all(rows.map(r => getTenantConfig(r.id)));
}

/* ─── Targeted updates (used by onboarding form + auto-tuning) ─────── */

async function setIcpConfig(clientId, icpConfig) {
  await pool.query(
    `UPDATE clients SET icp_config = $1, updated_at = NOW() WHERE id = $2`,
    [icpConfig, clientId]
  );
}

async function setSignalPreferences(clientId, signalPreferences) {
  await pool.query(
    `UPDATE clients SET signal_preferences = $1, updated_at = NOW() WHERE id = $2`,
    [signalPreferences, clientId]
  );
}

async function setOffering(clientId, offering) {
  await pool.query(
    `UPDATE clients SET offering = $1, updated_at = NOW() WHERE id = $2`,
    [offering, clientId]
  );
}

async function setQualityWeights(clientId, qualityWeights) {
  // Sanity check: weights should sum to ~1.0. Reject obvious garbage.
  const sum = Object.values(qualityWeights).reduce((a, b) => a + (Number(b) || 0), 0);
  if (sum < 0.95 || sum > 1.05) {
    throw new Error(`quality_weights must sum to 1.0 (±5%). Got: ${sum.toFixed(3)}`);
  }
  await pool.query(
    `UPDATE clients SET quality_weights = $1, updated_at = NOW() WHERE id = $2`,
    [qualityWeights, clientId]
  );
}

async function setVpThreshold(clientId, score) {
  if (score < 0 || score > 100) throw new Error('vp_threshold_score must be 0-100');
  await pool.query(
    `UPDATE clients SET vp_threshold_score = $1, updated_at = NOW() WHERE id = $2`,
    [score, clientId]
  );
}

async function setVpDailyBudget(clientId, credits) {
  if (credits < 0) throw new Error('vp_daily_budget_credits must be >= 0');
  await pool.query(
    `UPDATE clients SET vp_daily_budget_credits = $1, updated_at = NOW() WHERE id = $2`,
    [credits, clientId]
  );
}

async function setDailyQualityLeadFloor(clientId, floor) {
  if (floor < 0) throw new Error('daily_quality_lead_floor must be >= 0');
  await pool.query(
    `UPDATE clients SET daily_quality_lead_floor = $1, updated_at = NOW() WHERE id = $2`,
    [floor, clientId]
  );
}

async function setAutoApproveThreshold(clientId, score) {
  // 0 = never auto-approve. NULL is treated as "off" too. Cap at 100.
  // Captain's tuner uses this; manual admin set also goes through here.
  if (score !== null && (score < 0 || score > 100)) {
    throw new Error('auto_approve_threshold must be 0-100 or null');
  }
  await pool.query(
    `UPDATE clients SET auto_approve_threshold = $1, updated_at = NOW() WHERE id = $2`,
    [score, clientId]
  );
}

/* ─── VP credit ledger (atomic increments) ─────────────────────────── */

/**
 * Atomically increment VP credit counters. Resets daily counter if
 * vp_credits_reset_at is older than 24h (handles crossing midnight).
 *
 * @returns {{ allowed: boolean, used_today: number, daily_budget: number, reason?: string }}
 */
async function chargeVpCredits(clientId, credits) {
  if (credits <= 0) return { allowed: true, used_today: 0, daily_budget: 0 };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT vp_credits_used_today, vp_daily_budget_credits, vp_credits_reset_at
       FROM clients WHERE id = $1 FOR UPDATE`,
      [clientId]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return { allowed: false, reason: 'tenant_not_found' };
    }

    let usedToday = rows[0].vp_credits_used_today || 0;
    const budget = rows[0].vp_daily_budget_credits ?? DEFAULT_VP_BUDGET_CREDITS;
    const resetAt = rows[0].vp_credits_reset_at;
    const now = new Date();

    // Reset daily counter if 24h+ has passed since last reset
    if (!resetAt || (now - new Date(resetAt)) > 24 * 60 * 60 * 1000) {
      usedToday = 0;
    }

    if (usedToday + credits > budget) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        used_today: usedToday,
        daily_budget: budget,
        reason: 'daily_budget_exceeded',
      };
    }

    const newUsedToday = usedToday + credits;
    await client.query(
      `UPDATE clients
       SET vp_credits_used_today = $1,
           vp_credits_used_total = COALESCE(vp_credits_used_total, 0) + $2,
           vp_credits_reset_at = COALESCE(vp_credits_reset_at, NOW()),
           updated_at = NOW()
       WHERE id = $3`,
      [newUsedToday, credits, clientId]
    );
    await client.query('COMMIT');

    return {
      allowed: true,
      used_today: newUsedToday,
      daily_budget: budget,
      remaining_today: budget - newUsedToday,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ─── Defaults exposed for tests + onboarding form ─────────────────── */

module.exports = {
  // Read
  getTenantConfig,
  listActiveTenantConfigs,
  // Write
  setIcpConfig,
  setSignalPreferences,
  setOffering,
  setQualityWeights,
  setVpThreshold,
  setVpDailyBudget,
  setDailyQualityLeadFloor,
  setAutoApproveThreshold,
  // Cost ledger
  chargeVpCredits,
  // Defaults (read-only)
  LEGACY_DEFAULT_ICP,
  LEGACY_DEFAULT_SIGNALS,
  DEFAULT_QUALITY_WEIGHTS,
  DEFAULT_VP_BUDGET_CREDITS,
  DEFAULT_VP_THRESHOLD,
  DEFAULT_DAILY_LEAD_FLOOR,
};
