'use strict';

/**
 * Tenant Context — single read touchpoint for all 4 beavers.
 *
 * The only sanctioned way to access tenant profile data at runtime. Every
 * beaver (Research, Sales, Enforcer, Captain) calls `getTenantContext(authCtx,
 * { role, channel })` and receives a role-scoped projection: rendered prompt
 * text + structured constraints + tokenCount + content_version.
 *
 * Spec: MJxClaude/projects/beavrdam-rebuild/tenant-profile-schema-v1.md
 * DB:   server/db/migrations/072_tenant_profile.sql
 *
 * Safety:
 *   - `getTenantContext` REJECTS raw client_id strings at runtime. Callers
 *     must construct an AuthCtx via `createAuthContext(...)` OR pass req.tenant
 *     from authMiddleware (which sets __authCtx).
 *   - Profile data is loaded via `pool.withTenant(clientId, ...)` so RLS
 *     policies on `tenant_profiles` fire — beavrdam_app role is non-superuser
 *     and cannot bypass RLS.
 *
 * Transition contract:
 *   - When a tenant has no active profile (status='draft' or no row),
 *     getTenantContext returns `{ active: false, reason }`. Callers MUST check
 *     `active` and fall back to existing legacy code path. This makes the
 *     migration from scattered config → unified profile completely safe:
 *     beavers only switch behaviour when the tenant's profile is flipped to
 *     `status='active'`.
 */

const pool = require('../db/pool');
const { profileSchema } = require('./tenantProfileSchema');
const { normalizeBuyingSignalsForTenant } = require('../config/buyingSignals');

// ── AuthCtx construction + assertion ──────────────────────────────────────
// Soft-typed brand. Real type safety arrives with a TS port; runtime check
// catches accidental string passes today.

const AUTH_CTX_BRAND = Symbol.for('beavrdam.tenantContext.authCtx');

function createAuthContext({ clientId, source }) {
  if (!clientId || typeof clientId !== 'string') {
    throw new Error('createAuthContext: clientId required (string UUID)');
  }
  if (!source || !['http', 'cron', 'service'].includes(source)) {
    throw new Error(`createAuthContext: source must be one of http|cron|service (got: ${source})`);
  }
  return {
    __authCtx: AUTH_CTX_BRAND,
    clientId,
    source,
  };
}

function assertAuthCtx(ctx) {
  if (!ctx || ctx.__authCtx !== AUTH_CTX_BRAND || typeof ctx.clientId !== 'string') {
    throw new Error(
      'getTenantContext: authenticated context required, not a raw string. ' +
      'Use createAuthContext({ clientId, source }) or pass req.tenant from authMiddleware.'
    );
  }
}

// ── Role projection helpers ───────────────────────────────────────────────
// Each role gets a different slice of the profile. Token budget control +
// attention focus = better drafts. Constraints are returned structured (for
// Enforcer programmatic validation) AND embedded in the rendered prompt where
// appropriate.

function bulletList(arr, prefix = '- ') {
  if (!Array.isArray(arr) || arr.length === 0) return '(none)';
  return arr.map(s => `${prefix}${s}`).join('\n');
}

function numberedList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '(none)';
  return arr.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

function buildConstraints(profile, channel) {
  const c = profile.constraints || {};
  return {
    word_cap:       c.word_cap_by_channel?.[channel] ?? null,
    banned_phrases: Array.isArray(c.banned_phrases) ? c.banned_phrases : [],
    signoff:        c.signoff_by_channel?.[channel] ?? null,
    max_links:      typeof c.max_links === 'number' ? c.max_links : 1,
    allow_emoji:    Boolean(c.allow_emoji),
  };
}

// ── Research projection ───────────────────────────────────────────────────
// Research Beaver sources leads. It needs ICP rules + competitor exclusion +
// the tenant's company name (for self-reference filtering). It does NOT need
// voice, proof, constraints, sender_persona, or pricing.
function projectForResearch(profile) {
  const icp = profile.icp || {};
  const company = profile.identity?.company || '';

  const rendered = [
    `TENANT COMPANY: ${company}`,
    '',
    'ICP — INCLUDED:',
    `  Verticals: ${(icp.verticals || []).join(', ') || '(any)'}`,
    `  Personas:  ${(icp.personas || []).join(', ') || '(any)'}`,
    `  Geo:       ${(icp.geo || []).join(', ') || '(any)'}`,
    '',
    'ICP — EXCLUSIONS (hard-out):',
    bulletList(icp.exclusions),
    '',
    'COMPETITOR-OFFER OVERLAP (do not source — they sell what we sell):',
    bulletList(icp.competitor_offers),
  ].join('\n');

  return {
    rendered,
    constraints: null,
    fields: { identity: { company }, icp, buying_signals: normalizeBuyingSignalsForTenant(profile) },
  };
}

// ── Sales projection ──────────────────────────────────────────────────────
// Sales Beaver drafts. It needs identity (sender), offer (what to sell), ICP
// context (personas/verticals/geo — to anchor the angle), voice (how to sound),
// approved proof (what to cite). It does NOT need exclusions or competitor
// list (Research filtered those out upstream).
function projectForSales(profile, channel) {
  const identity = profile.identity || {};
  const sender   = identity.sender_persona || {};
  const offer    = profile.offer || {};
  const icp      = profile.icp || {};
  const buyingSignals = normalizeBuyingSignalsForTenant(profile);
  const voice    = profile.voice || {};
  const examples = voice.examples || {};
  const approvedProof = (profile.proof || []).filter(p => p && p.approved_for_outreach === true);
  const constraints = buildConstraints(profile, channel);

  const rendered = [
    `COMPANY: ${identity.company || ''}`,
    `BRAND VOICE: ${identity.brand_voice || ''}`,
    `SENDER PERSONA: ${sender.name || ''} (${sender.title || ''})${sender.email ? ` <${sender.email}>` : ''}`,
    '',
    `PRODUCT: ${offer.product || ''}`,
    `POSITIONING: ${offer.positioning || ''}`,
    offer.services?.length ? `SERVICES:\n${bulletList(offer.services)}` : null,
    '',
    'ICP CONTEXT (who we sell to):',
    `  Verticals: ${(icp.verticals || []).join(', ') || '(any)'}`,
    `  Personas:  ${(icp.personas || []).join(', ') || '(any)'}`,
    `  Geo:       ${(icp.geo || []).join(', ') || '(any)'}`,
    '',
    'APPROVED PROOF (you may cite ONLY these — never invent or paraphrase):',
    approvedProof.length === 0
      ? '(none yet — do not fabricate)'
      : approvedProof.map(p => `- ${p.claim} | ${p.metric} | source: ${p.source}`).join('\n'),
    '',
    'VOICE — TONE:',
    bulletList(voice.tone),
    'VOICE — DO:',
    bulletList(voice.do),
    "VOICE — DON'T:",
    bulletList(voice.dont),
    '',
    'EXAMPLES — GOOD (match this voice):',
    numberedList(examples.good),
    'EXAMPLES — BAD (avoid this voice):',
    numberedList(examples.bad),
    '',
    `CHANNEL: ${channel || '(unspecified)'}`,
    `WORD CAP: ${constraints.word_cap ?? 'no cap'}`,
    `SIGN-OFF: ${constraints.signoff ?? '(none for this channel)'}`,
    `BANNED PHRASES (never use): ${constraints.banned_phrases.join(' | ') || '(none)'}`,
    `MAX LINKS: ${constraints.max_links}`,
    `EMOJI: ${constraints.allow_emoji ? 'allowed' : 'forbidden'}`,
  ].filter(Boolean).join('\n');

  return {
    rendered,
    constraints,
    fields: {
      identity,
      offer,
      icp: { verticals: icp.verticals, personas: icp.personas, geo: icp.geo },
      buying_signals: buyingSignals,
      voice,
      proof: approvedProof,
    },
  };
}

// ── Enforcer projection ───────────────────────────────────────────────────
// Enforcer validates drafts. It needs constraints (structured) + voice examples
// for drift detection + the do/dont rules. It does NOT need offer/pricing/proof
// detail (Sales already wove them into the draft).
function projectForEnforcer(profile, channel) {
  const voice    = profile.voice || {};
  const examples = voice.examples || {};
  const constraints = buildConstraints(profile, channel);
  const buyingSignals = normalizeBuyingSignalsForTenant(profile);

  const rendered = [
    'CONSTRAINTS (hard rejection on violation):',
    `  Word cap (${channel || 'channel?'}): ${constraints.word_cap ?? 'no cap'}`,
    `  Banned phrases: ${constraints.banned_phrases.join(' | ') || '(none)'}`,
    `  Sign-off required (${channel || 'channel?'}): ${constraints.signoff ?? '(none)'}`,
    `  Max links: ${constraints.max_links}`,
    `  Emoji: ${constraints.allow_emoji ? 'allowed' : 'forbidden'}`,
    '',
    'VOICE GUIDANCE (soft — emit voice_drift if draft strays):',
    `  Tone: ${(voice.tone || []).join(', ') || '(any)'}`,
    '  Do:',
    bulletList(voice.do, '    - '),
    "  Don't:",
    bulletList(voice.dont, '    - '),
    '',
    'EXAMPLES — GOOD (draft should match this voice):',
    numberedList(examples.good),
    'EXAMPLES — BAD (draft should NOT match this voice):',
    numberedList(examples.bad),
  ].join('\n');

  return {
    rendered,
    constraints,
    fields: { voice, constraints, buying_signals: buyingSignals },
  };
}

// ── Captain projection ────────────────────────────────────────────────────
// Captain orchestrates. It needs the tenant name + a 1-line product summary +
// a 1-line ICP summary for status reporting (Telegram briefs, KPI checks). It
// does NOT need full offer detail, voice, proof, or constraints.
function projectForCaptain(profile) {
  const identity = profile.identity || {};
  const offer    = profile.offer || {};
  const icp      = profile.icp || {};
  const buyingSignals = normalizeBuyingSignalsForTenant(profile);

  const rendered = [
    `TENANT: ${identity.company || '(unknown)'}`,
    `PRODUCT: ${offer.product || '(unset)'}`,
    `ICP SUMMARY: ${(icp.personas || []).slice(0, 3).join(' / ')} in ${(icp.verticals || []).slice(0, 3).join(', ')} (${(icp.geo || []).join('/')})`,
  ].join('\n');

  return {
    rendered,
    constraints: null,
    fields: { identity: { company: identity.company }, offer: { product: offer.product }, buying_signals: buyingSignals },
  };
}

const PROJECTIONS = {
  research: projectForResearch,
  sales:    projectForSales,
  enforcer: projectForEnforcer,
  captain:  projectForCaptain,
};

// ── tokenCount ────────────────────────────────────────────────────────────
// Rough char/4 estimate. Good enough for budgeting; a real tokenizer can be
// wired later if budget tightens.
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ── DB load (via pool.withTenant for RLS) ─────────────────────────────────
async function loadActiveProfile(clientId) {
  return pool.withTenant(clientId, async (client) => {
    const res = await client.query(
      `SELECT schema_version, content_version, status, profile
         FROM tenant_profiles
        WHERE client_id = $1
        LIMIT 1`,
      [clientId]
    );
    if (res.rows.length === 0) {
      return { found: false, status: null };
    }
    const row = res.rows[0];
    return {
      found: true,
      status: row.status,
      schemaVersion: row.schema_version,
      contentVersion: row.content_version,
      profile: row.profile,
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * @param {object} authCtx              — constructed via createAuthContext or req.tenant
 * @param {object} opts
 * @param {'research'|'sales'|'enforcer'|'captain'} opts.role
 * @param {'email'|'linkedin_dm'|'linkedin_invite'} [opts.channel]
 * @returns {Promise<{active: true, rendered, constraints, fields, tokenCount, content_version, schema_version} | {active: false, reason: string}>}
 */
async function getTenantContext(authCtx, opts) {
  assertAuthCtx(authCtx);

  const { role, channel } = opts || {};
  if (!role || !PROJECTIONS[role]) {
    throw new Error(`getTenantContext: role must be one of ${Object.keys(PROJECTIONS).join('|')} (got: ${role})`);
  }

  const loaded = await loadActiveProfile(authCtx.clientId);

  if (!loaded.found) {
    return { active: false, reason: 'no_active_profile' };
  }
  if (loaded.status !== 'active') {
    return { active: false, reason: 'draft_only' };
  }

  // Validate the stored blob against current schema. If a stored profile
  // can't parse, that's a data integrity issue — surface, don't silently
  // render garbage.
  const parsed = profileSchema.safeParse(loaded.profile);
  if (!parsed.success) {
    const err = new Error(`tenant profile validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    err.code = 'profile_invalid';
    err.zodIssues = parsed.error.issues;
    throw err;
  }

  const projection = PROJECTIONS[role](parsed.data, channel);

  return {
    active: true,
    rendered:        projection.rendered,
    constraints:     projection.constraints,
    fields:          projection.fields,
    tokenCount:      estimateTokens(projection.rendered),
    content_version: loaded.contentVersion,
    schema_version:  loaded.schemaVersion,
  };
}

function legacyIcpFromProfile(profile) {
  const icp = profile?.icp || {};
  return {
    job_titles:  Array.isArray(icp.personas) ? icp.personas.join(', ') : '',
    industries:  Array.isArray(icp.verticals) ? icp.verticals.join(', ') : '',
    geographies: Array.isArray(icp.geo) ? icp.geo.join(', ') : '',
    exclusions:  Array.isArray(icp.exclusions) ? icp.exclusions : [],
    competitor_offers: Array.isArray(icp.competitor_offers) ? icp.competitor_offers : [],
    buying_signals: normalizeBuyingSignalsForTenant(profile),
    source: 'tenant_profiles',
  };
}

/**
 * Bridge for legacy JS beaver paths while tenant_profiles is rolled into every
 * caller. Prefer this over reading agent_memory/director/icp directly.
 */
async function getLegacyIcpForClient(clientId, { source = 'service', fallback = null } = {}) {
  const loaded = await loadActiveProfile(clientId);
  if (loaded.found && loaded.status === 'active') {
    const parsed = profileSchema.safeParse(loaded.profile);
    if (!parsed.success) {
      const err = new Error(`tenant profile validation failed: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      err.code = 'profile_invalid';
      err.zodIssues = parsed.error.issues;
      throw err;
    }
    return {
      ...legacyIcpFromProfile(parsed.data),
      content_version: loaded.contentVersion,
      schema_version: loaded.schemaVersion,
      auth_source: source,
    };
  }
  return fallback || null;
}

module.exports = {
  getTenantContext,
  getLegacyIcpForClient,
  createAuthContext,
  // Internal projections exported for unit/smoke testing only.
  // Production code uses getTenantContext.
  _internal: {
    projectForResearch,
    projectForSales,
    projectForEnforcer,
    projectForCaptain,
    estimateTokens,
    AUTH_CTX_BRAND,
  },
};
