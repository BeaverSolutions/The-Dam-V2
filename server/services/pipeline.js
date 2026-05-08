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

module.exports = {
  isV2Enabled,
  processLead,         // Step 7 — currently throws
  persistDraft,        // Step 1 — concrete
  checkActiveMessage,  // Step 1 — concrete

  // Constants for callers (e.g. acceptance tests)
  PIPELINE_V2_ENABLED,
};
