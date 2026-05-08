'use strict';

/**
 * pipeline — Phase 2 of the BeavrDam rebuild (started 2026-05-08).
 *
 * Single source of truth for: ICP gate → channel select → drafting → review →
 * persistence. Replaces the 4 duplicated paths in `services/agents.js`:
 *
 *   1. processExistingLeadsPipeline  (signal_pipeline, ~line 1600)
 *   2. directorExecute cold-research (~lines 2700-3450)
 *   3. processLeadPipeline           (kickoff_pipeline inner, ~line 2904)
 *   4. runRangerPipeline             (~line 3225, called from kickoff path)
 *
 * Why this exists: corrections.md has 5+ entries about half-fix bugs ("patched
 * one site, missed the sibling"). The 2026-05-08 17:37 MYT incident — 95%
 * silent drop because Fix 2 instrumented kickoff_pipeline only — is the latest
 * example. Phase 1 made the bleeding visible. Phase 2 ensures every fix lands
 * in ONE place.
 *
 * Migration plan (per projects/beavrdam-rebuild/PLAN.md Phase 2):
 *
 *   Step 1 (this commit): persistDraft + checkActiveMessage extracted.
 *                         Feature flag PIPELINE_V2_ENABLED added (default OFF).
 *                         Old call sites unchanged. INSERTs still happen in agents.js.
 *
 *   Step 2: replace the 3+ INSERT INTO messages call sites in agents.js with
 *           calls to pipeline.persistDraft. Acceptance: grep "INSERT INTO messages"
 *           outside pipeline.js returns zero non-test hits.
 *
 *   Step 3: extract pipeline.draft (Sales Beaver + Hunter/VP enrichment + dedup)
 *   Step 4: extract pipeline.icpGate (applyIcpV2Filter + soft-delete + audit)
 *   Step 5: extract pipeline.review (autoFix + brandSafety + Enforcer + redraft)
 *   Step 6: extract pipeline.approve (auto_approve_threshold + INSERT approvals + enqueueMessage)
 *   Step 7: compose pipeline.processLead. Old functions become <20-line wrappers.
 *
 *   Each step is its own PR, gated by PIPELINE_V2_ENABLED. Acceptance test for
 *   "consolidation actually consolidates": deliberate one-line regression in
 *   pipeline.draft must surface in BOTH signal_pipeline and director_cold runs
 *   simultaneously. If only one, consolidation failed — find the second pipeline.
 *
 * Phase 1 (pipeline_traces) is the safety net throughout. Every stage in
 * pipeline.processLead emits a traceStage call. The 24 trace points shipped
 * in commits 2872c71 + 9a3b281 lift directly into this file as we extract;
 * payload shapes do not paraphrase.
 */

const pool = require('../db/pool');
const pipelineTrace = require('./pipelineTrace');

// ─── Feature flag ──────────────────────────────────────────────────────────
// During Phase 2 migration both code paths coexist in the repo. Flip via
// Railway env var when each step has been validated. Default OFF — this
// commit ships the helpers but doesn't change runtime behavior.
const PIPELINE_V2_ENABLED = process.env.PIPELINE_V2_ENABLED === 'true';

function isV2Enabled() {
  return PIPELINE_V2_ENABLED;
}

// ─── Stage signatures (skeleton — implementations land in subsequent steps) ──

/**
 * Phase 2 entry point. Replaces processLeadPipeline + processExistingLeadsPipeline
 * + runRangerPipeline.
 *
 * @param {string} clientId  Tenant UUID. Required.
 * @param {object} lead      Lead row (id, name, company, title, email, linkedin_url, ...)
 * @param {object} context   { source, kickoff_id, command, options }
 *   - source: 'signal_pipeline' | 'kickoff_pipeline' | 'director_cold' | 'followup'
 *   - kickoff_id: string|null  (== plan_id; named to match pipeline_traces.kickoff_id)
 *   - command: string|null     (campaign intent for Sales Beaver context)
 *   - options:
 *       skipIcpGate?: boolean        (true for director_cold — already gated upstream)
 *       enableVpEnrichment?: boolean (true for director_cold, false for signal)
 *       captainValidate?: boolean    (true for kickoff/director, false for signal)
 *       touchNumber?: number         (for follow-ups)
 *       channelHints?: object        (CHANNEL_HINTS map override)
 *
 * @returns {Promise<object>}
 *   {
 *     status: 'drafted'|'approved'|'rejected'|'blocked_no_email'|'skipped'|'icp_rejected',
 *     lead_id, message_id, channel,
 *     drafted: bool, approved: bool, rejected: bool, auto_approved: bool,
 *     ranger_score: number|null, draft_source: string, reason: string|null,
 *     trace_count: number,  // assertion target for consolidation acceptance test
 *   }
 */
async function processLead(clientId, lead, context = {}) {
  // STEP 7 (final composition): wires icpGate → channel → draft → review → approve.
  // Until then, this throws so any premature caller is loud, not silent.
  throw new Error(
    'pipeline.processLead not yet composed (Phase 2 step 7). ' +
    'Use individual stages (persistDraft, etc) until composition lands.'
  );
}

// ─── STEP 1 (this commit): persistence helpers ─────────────────────────────
//
// The 3+ INSERT INTO messages call sites in agents.js are the highest-leverage
// extraction point: every divergence above ultimately surfaces at the row write,
// and centralising it gives the one acceptance-criterion grep. Step 2 will
// replace the call sites; this step just ships the helpers.

/**
 * Race-condition dedup guard. Returns the existing active message if the lead
 * already has one, null otherwise. Currently duplicated at lines 1775 and 3106
 * in agents.js with identical SQL.
 *
 * "Active" = anywhere from pending_ranger through sent. ranger_rejected and
 * blocked_no_email leads can be re-drafted (they're not active outreach).
 */
async function checkActiveMessage(clientId, lead_id) {
  const result = await pool.query(
    `SELECT id FROM messages
     WHERE client_id = $1 AND lead_id = $2
       AND status IN ('pending_ranger', 'pending_approval', 'approved', 'pending_send', 'sent')
     LIMIT 1`,
    [clientId, lead_id]
  );
  return result.rows[0] || null;
}

/**
 * Persist a drafted message. Single source of truth for the row write.
 *
 * @param {string} clientId  Tenant UUID.
 * @param {object} params
 *   - lead_id           Lead UUID.
 *   - channel           'email' | 'linkedin' | etc.
 *   - subject           Email subject (null for LinkedIn).
 *   - body              Message body string.
 *   - status            'pending_ranger' | 'pending_approval' | 'blocked_no_email' | etc.
 *                       Constrained by messages_status_check.
 *   - ranger_score      Optional. Set when caller is the Enforcer fallback path
 *                       (fallback INSERT pre-scores at 70 because Enforcer drafted it).
 *                       Otherwise null and review pass writes it via UPDATE.
 *   - ranger_notes      Optional, paired with ranger_score.
 *   - metadata          jsonb merged into the row's metadata column.
 *   - draft_source      'sales_beaver' | 'enforcer_fallback' (for trace + metadata).
 *   - prompt_variant    Sales Beaver prompt variant tag (or 'enforcer_fallback').
 *   - signal            (optional) signal slug from the lead, for metadata.
 *   - kickoff_id        (optional) for the trace.
 *   - pipeline_path     'signal_pipeline' | 'kickoff_pipeline' for the trace.
 *
 * @returns the inserted message row.
 *
 * Emits pipeline_traces 'drafted' with status = the row's status (so
 * blocked_no_email is distinguishable from pending_ranger).
 */
async function persistDraft(clientId, params) {
  const {
    lead_id,
    channel,
    subject = null,
    body,
    status,
    ranger_score = null,
    ranger_notes = null,
    metadata = {},
    draft_source = 'sales_beaver',
    prompt_variant = null,
    signal = null,
    kickoff_id = null,
    pipeline_path = null,
  } = params;

  if (!clientId || !lead_id || !body || !status) {
    throw new Error('persistDraft: clientId, lead_id, body, status are required');
  }

  // Compose metadata. Keys we always tag for downstream analysis:
  //   source         — sales_beaver vs enforcer_fallback (matters for KPI calc)
  //   prompt_variant — for reply-rate-by-variant slicing (Wave 3 requirement)
  //   signal         — copy of lead's trigger, useful when joining traces
  //   blocked_reason — only when status = blocked_no_email
  const finalMetadata = {
    source: draft_source,
    prompt_variant: prompt_variant || (draft_source === 'enforcer_fallback' ? 'enforcer_fallback' : null),
    signal,
    ...(status === 'blocked_no_email' ? { blocked_reason: 'awaiting_email_enrichment' } : {}),
    ...metadata,
  };

  // Two SQL shapes: with ranger_score (Enforcer fallback path) vs without.
  // Keep this branch — splitting into two SQL strings is simpler than COALESCE
  // gymnastics and matches the existing sites verbatim.
  let row;
  if (ranger_score !== null) {
    const result = await pool.query(
      `INSERT INTO messages
        (client_id, lead_id, channel, subject, body, status, ranger_score, ranger_notes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [clientId, lead_id, channel, subject, body, status, ranger_score, ranger_notes, JSON.stringify(finalMetadata)]
    );
    row = result.rows[0];
  } else {
    const result = await pool.query(
      `INSERT INTO messages
        (client_id, lead_id, channel, subject, body, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [clientId, lead_id, channel, subject, body, status, JSON.stringify(finalMetadata)]
    );
    row = result.rows[0];
  }

  // Phase 1 trace — emit the same drafted shape both old call sites would emit,
  // so we can swap the sites in Step 2 without changing trace output.
  pipelineTrace.traceStage(clientId, {
    lead_id,
    message_id: row.id,
    kickoff_id,
    stage: 'drafted',
    status,
    agent: draft_source === 'enforcer_fallback' ? 'enforcer_beaver' : 'sales_beaver',
    score: ranger_score,
    pipeline_path,
    metadata: { channel, draft_source, signal },
  }).catch(() => {});

  return row;
}

// ─── STEP 3 (this commit): enrichment + draft helpers ──────────────────────
//
// Step 3 of the Phase 2 plan is "extract pipeline.draft (Sales Beaver + Hunter/VP
// enrichment + dedup) — ~150 lines moved". The literal one-shot extraction risks
// behaviour drift because the 4 call sites differ in real ways (signal has
// Enforcer fallback, kickoff has VP enrichment, kickoff injects CHANNEL_HINTS).
//
// Risk-correct path tonight: extract the two helpers with the highest
// line-for-line duplication and zero behaviour change:
//
//   - enrichEmail(clientId, lead, options)         — Hunter + optional VP
//   - draftWithFallback(clientId, params)          — Sales Beaver + optional Enforcer fallback
//
// Caller wiring stays. Channel selection, dedup, Captain-validate, persistDraft
// remain in agents.js. Step 7 will compose pipeline.processLead from these
// helpers + persistDraft + checkActiveMessage.
//
// Both helpers take service functions via dependency injection to avoid the
// pipeline.js ↔ agents.js circular require. Caller passes:
//   - hunterService:      { findEmail }
//   - vpService:          { findVerifiedEmail }       (optional)
//   - tenantConfigService:{ getTenantConfig, chargeVpCredits } (only with vpService)
//   - salesGenerate:      fn(clientId, {lead_id,channel,context}) -> {body,subject,prompt_variant}|null
//   - rangerDraft:        fn(clientId, {lead_name,...}) -> {body,subject}|null   (optional, for fallback)

/**
 * Enrich a lead's email if missing. Mutates `lead` in place and writes to DB.
 *
 * Mirrors the Hunter+VP blocks in agents.js:
 *   signal_pipeline: lines 1699-1723   (Hunter only, no VP)
 *   kickoff_pipeline: lines 2955-3030  (Hunter + VP threshold gate + credits)
 *
 * @param {string} clientId
 * @param {object} lead    Has .id, .name, .company, .email, .quality_score
 * @param {object} options
 *   - pipeline_path:        'signal_pipeline' | 'kickoff_pipeline' (for log prefix)
 *   - hunterService:        required, exposes .findEmail(clientId, {firstName,lastName,company})
 *   - enableVp:             default false. Kickoff sets true.
 *   - vpService:            required if enableVp. Exposes .findVerifiedEmail(clientId, {...})
 *   - tenantConfigService:  required if enableVp. Exposes .getTenantConfig(), .chargeVpCredits()
 *
 * @returns {Promise<{ enriched: boolean, source: 'hunter'|'vp'|null, reason: string|null }>}
 *   Side-effect: lead.email / lead.email_source / lead.email_verified updated when found.
 */
async function enrichEmail(clientId, lead, options = {}) {
  const {
    pipeline_path = 'unknown',
    hunterService,
    enableVp = false,
    vpService = null,
    tenantConfigService = null,
  } = options;

  if (lead.email) {
    return { enriched: false, source: null, reason: 'already_has_email' };
  }
  if (!hunterService) {
    throw new Error('enrichEmail: hunterService is required');
  }

  const logPrefix = `[${pipeline_path}]`;

  // ── Hunter (always tried first; Email-Priority Rule, MJ 2026-04-29) ─
  try {
    const nameParts = (lead.name || '').split(' ');
    const hunterResult = await hunterService.findEmail(clientId, {
      firstName: nameParts[0] || '',
      lastName: nameParts.slice(1).join(' ') || '',
      company: lead.company,
    });
    if (hunterResult?.email) {
      await pool.query(
        `UPDATE leads SET email = $1, email_verified = $2, email_source = 'hunter', updated_at = NOW()
          WHERE id = $3 AND client_id = $4`,
        [hunterResult.email, hunterResult.verified === true, lead.id, clientId]
      );
      lead.email = hunterResult.email;
      lead.email_source = 'hunter';
      lead.email_verified = hunterResult.verified === true;
      console.log(`${logPrefix} Hunter sourced email for ${lead.name}: ${hunterResult.email}`);
      return { enriched: true, source: 'hunter', reason: null };
    }
    console.log(`${logPrefix} Hunter found no email for ${lead.name} — will use LinkedIn`);
  } catch (err) {
    console.warn(`${logPrefix} Hunter lookup failed for ${lead.name}: ${err.message}`);
  }

  // ── Vibe Prospecting fallback (kickoff path only) ───────────────────
  // Fires when: (a) Hunter found nothing, (b) lead's quality_score >= tenant
  // vp_threshold_score (default 75), (c) daily VP credit budget not exhausted.
  if (enableVp && vpService && tenantConfigService) {
    try {
      const cfg = await tenantConfigService.getTenantConfig(clientId);
      const qScore = Number(lead.quality_score) || 0;
      const threshold = cfg.vp_threshold_score ?? 75;

      if (qScore < threshold) {
        console.log(`${logPrefix} VP skipped: quality_score ${qScore} < threshold ${threshold} for ${lead.name}`);
        return { enriched: false, source: null, reason: 'vp_below_threshold' };
      }
      if ((cfg.vp_credits_used_today || 0) >= (cfg.vp_daily_budget_credits || 0)) {
        console.log(`${logPrefix} VP skipped: daily budget exhausted (${cfg.vp_credits_used_today}/${cfg.vp_daily_budget_credits}) for ${lead.name}`);
        return { enriched: false, source: null, reason: 'vp_budget_exhausted' };
      }

      const nameParts = (lead.name || '').split(' ');
      const result = await vpService.findVerifiedEmail(clientId, {
        firstName: nameParts[0] || '',
        lastName:  nameParts.slice(1).join(' ') || '',
        company:   lead.company,
      });

      // Charge actual credits used (even on partial failure VP may have spent)
      if (result?.credits > 0) {
        await tenantConfigService.chargeVpCredits(clientId, result.credits).catch(() => {});
      }

      if (result?.ok && result.email) {
        await pool.query(
          `UPDATE leads SET email = $1, email_verified = $2, email_source = 'vp', updated_at = NOW()
            WHERE id = $3 AND client_id = $4`,
          [result.email, result.email_verified === true, lead.id, clientId]
        );
        lead.email          = result.email;
        lead.email_source   = 'vp';
        lead.email_verified = result.email_verified === true;
        console.log(`${logPrefix} VP enrichment: ${result.email} (verified=${lead.email_verified}, ${result.credits}c) for ${lead.name}`);
        return { enriched: true, source: 'vp', reason: null };
      }
      console.log(`${logPrefix} VP enrichment no match for ${lead.name}: ${result?.error || 'unknown'} (${result?.credits || 0}c)`);
      return { enriched: false, source: null, reason: 'vp_no_match' };
    } catch (err) {
      console.warn(`${logPrefix} VP enrichment failed for ${lead.name}: ${err.message}`);
      return { enriched: false, source: null, reason: 'vp_error' };
    }
  }

  return { enriched: false, source: null, reason: 'no_email_found' };
}

/**
 * Draft a message body via Sales Beaver, with optional Enforcer fallback if
 * Sales Beaver returns no body.
 *
 * Mirrors the Sales+fallback block in agents.js:
 *   signal_pipeline: lines 1746-1770   (with Enforcer fallback)
 *   kickoff_pipeline: lines 3061-3083  (no fallback — kickoff treats no-body as draft_failed)
 *
 * Returns null when both Sales Beaver and the optional Enforcer fallback fail.
 * Caller decides whether to log/trace draft_failed and continue.
 *
 * @param {string} clientId
 * @param {object} params
 *   - lead_id          required
 *   - channel          required ('email'|'linkedin'|...)
 *   - context          required, the prompt context string for Sales Beaver
 *   - salesGenerate    required, fn(clientId, {lead_id,channel,context}) -> {body,subject,prompt_variant}|null
 *   - rangerDraft      optional, fn(clientId, {lead_name,...}) -> {body,subject}|null. Required if enableEnforcerFallback.
 *   - enableEnforcerFallback  default false (kickoff/director_cold). signal_pipeline passes true.
 *   - lead             required if enableEnforcerFallback (rangerDraft needs name/company/title)
 *   - leadAngle, leadFriction  optional metadata for rangerDraft
 *   - pipeline_path    default 'unknown', for log prefix
 *
 * @returns {Promise<{body,subject,draftSource,prompt_variant}|null>}
 *   draftSource = 'sales_beaver' (default) | 'enforcer_fallback'
 *   Caller's callers historically used 'signal_hunt' for default — we preserve
 *   that via params.defaultDraftSource if the caller wants the legacy label.
 */
async function draftWithFallback(clientId, params) {
  const {
    lead_id,
    channel,
    context,
    salesGenerate,
    rangerDraft = null,
    enableEnforcerFallback = false,
    lead = null,
    leadAngle = null,
    leadFriction = null,
    pipeline_path = 'unknown',
    defaultDraftSource = 'sales_beaver',  // signal_pipeline historically used 'signal_hunt'
  } = params;

  if (!salesGenerate) {
    throw new Error('draftWithFallback: salesGenerate is required');
  }
  if (!lead_id || !channel || !context) {
    throw new Error('draftWithFallback: lead_id, channel, context are required');
  }

  const logPrefix = `[${pipeline_path}]`;

  const salesResult = await salesGenerate(clientId, { lead_id, channel, context });

  if (salesResult?.body) {
    return {
      body: salesResult.body,
      subject: salesResult.subject || null,
      draftSource: defaultDraftSource,
      prompt_variant: salesResult.prompt_variant || null,
    };
  }

  if (!enableEnforcerFallback) {
    console.warn(`${logPrefix} Sales draft failed for lead ${lead_id} (${channel}): no body`);
    return null;
  }

  // Enforcer fallback path (signal_pipeline behaviour).
  if (!rangerDraft) {
    throw new Error('draftWithFallback: rangerDraft is required when enableEnforcerFallback=true');
  }
  if (!lead) {
    throw new Error('draftWithFallback: lead is required when enableEnforcerFallback=true');
  }

  console.warn(`${logPrefix} Sales draft failed for ${lead.name} — Enforcer drafting fallback`);
  const enforcerDraft = await rangerDraft(clientId, {
    lead_name: lead.name,
    lead_company: lead.company,
    lead_title: lead.title,
    lead_angle: leadAngle,
    lead_friction: leadFriction,
    rejected_body: '',
  });

  if (!enforcerDraft?.body || typeof enforcerDraft.body !== 'string') {
    console.warn(`${logPrefix} Enforcer fallback also failed for ${lead.name} — skipping`);
    return null;
  }

  return {
    body: enforcerDraft.body,
    subject: enforcerDraft.subject || `${lead.company}`,
    draftSource: 'enforcer_fallback',
    prompt_variant: null,
  };
}

module.exports = {
  isV2Enabled,
  processLead,           // Step 7 — currently throws
  persistDraft,          // Step 1 — concrete
  checkActiveMessage,    // Step 1 — concrete
  enrichEmail,           // Step 3 — concrete (Hunter + optional VP)
  draftWithFallback,     // Step 3 — concrete (Sales Beaver + optional Enforcer fallback)

  // Constants for callers (e.g. acceptance tests)
  PIPELINE_V2_ENABLED,
};
