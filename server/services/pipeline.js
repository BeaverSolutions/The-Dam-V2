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
 *   Step 3: extract pipeline.draft (Sales Beaver + email enrichment + dedup)
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
const { checkBudget, BudgetExceededError, isBudgetExceededError } = require('./budget');
const directivesSvc = require('./directives');
const repairPolicy = require('./repairPolicy');

// ─── Feature flag ──────────────────────────────────────────────────────────
// During Phase 2 migration both code paths coexist in the repo. Flip via
// Railway env var when each step has been validated. Default OFF — this
// commit ships the helpers but doesn't change runtime behavior.
const PIPELINE_V2_ENABLED = process.env.PIPELINE_V2_ENABLED === 'true';

function isV2Enabled() {
  return PIPELINE_V2_ENABLED;
}

function getMetadata(source = {}) {
  return source && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
    ? source.metadata
    : {};
}

function getSignalPackage(source = {}) {
  const meta = getMetadata(source);
  return source.signal_package
    || meta.signal_package
    || source.signalPackage
    || meta.signalPackage
    || null;
}

async function defaultRepairSignalPackage(clientId, payload) {
  const { repairLeadSignalPackage } = require('./researchEnrichment');
  return repairLeadSignalPackage(clientId, payload);
}

async function defaultReloadLead(clientId, leadId) {
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE client_id = $1 AND id = $2 AND deleted_at IS NULL LIMIT 1`,
    [clientId, leadId]
  );
  return rows[0] || null;
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
async function processLead(clientId, lead, ctx = {}) {
  // STEP 7 (final composition, 2026-05-16, Jules F-03): the unified per-lead
  // pipeline. processExistingLeadsPipeline (signal) and processLeadPipeline
  // (kickoff) both call this when PIPELINE_V2_ENABLED is true; with the flag
  // OFF (default) their existing inline loops run unchanged — so shipping this
  // changes nothing in production until the flag is flipped + validated.
  //
  // Rejection strategy: unified on the kickoff path's 2-attempt Sales-redraft
  // loop (the "sharpen the clone" coaching loop). If Sales still fails,
  // Captain writes the manual-review fallback; Enforcer remains the reviewer.
  //
  // Returns { outcome, messageId?, channel?, reason? }. The caller maps the
  // outcome onto its own counters / execStatus — processLead never touches
  // execStatus or diagnostics (those are kickoff-caller-local).
  //
  // agents.js functions are injected via ctx.deps to avoid a circular require.
  const {
    pipelinePath = 'kickoff_pipeline',
    kickoffId = null,
    command = null,
    allowPersonalisationSearch = true,
    deps = {},
  } = ctx;
  const {
    salesGenerate, rangerReview, rangerDraft, captainDraft, selectChannel,
    autoFixMessage, brandSafetyCheck, searchPersonalisationSignals,
    recordOutcome, attributionFromLead, stripEmDashes, applyIcpV2Filter,
    hunterService, channelHints = {},
    beaverState,
  } = deps;

  const trace = (stage, status, extra = {}) => pipelineTrace.traceStage(clientId, {
    lead_id: lead.id || null, kickoff_id: kickoffId, stage, status,
    pipeline_path: pipelinePath, ...extra,
  }).catch(() => {});

  // ── 1. Identity guard ──
  if (!lead.id || !lead.name || lead.name === 'Unknown Contact') {
    await trace('icp_rejected', 'identity_skip', { agent: 'director', reason: 'missing_name_or_unknown_contact', metadata: { lead_name: lead.name || null } });
    return { outcome: 'identity_skip' };
  }

  // ── 2. Per-lead draft-failure circuit breaker ──
  const { rows: failRows } = await pool.query(
    `SELECT COUNT(*)::int AS fails FROM pipeline_traces
     WHERE client_id = $1 AND lead_id = $2 AND stage = 'draft_failed'
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [clientId, lead.id]
  ).catch(() => ({ rows: [{ fails: 0 }] }));
  if (failRows[0].fails >= 3) {
    await trace('draft_failed', 'circuit_breaker_skip', { agent: 'director', metadata: { recent_failures: failRows[0].fails } });
    return { outcome: 'circuit_breaker_skip' };
  }

  try {
    // ── 3. Context build (superset of both paths' fields) ──
    const meta = lead.metadata || {};
    const contextParts = [
      `Name: ${lead.name}`, `Company: ${lead.company}`, `Title: ${lead.title || 'N/A'}`,
    ];
    if (lead.linkedin_url) contextParts.push(`LinkedIn: ${lead.linkedin_url}`);
    const about = lead.short_description || meta.short_description;
    if (about) contextParts.push(`About: ${about}`);
    if (meta.signal) contextParts.push(`Signal (why reaching out now): ${meta.signal}`);
    if (meta.angle) contextParts.push(`Angle to lead with: ${meta.angle}`);
    if (meta.why_now) contextParts.push(`Why now: ${meta.why_now}`);
    if (meta.friction) contextParts.push(`Friction point: ${meta.friction}`);
    if (meta.signal_type) contextParts.push(`Signal type: ${meta.signal_type}`);
    if (meta.notes) contextParts.push(`Personalisation hook: ${meta.notes}`);
    if (!meta.signal && meta.snippet) contextParts.push(`LinkedIn profile snippet: ${meta.snippet}`);
    if (meta.search_query) contextParts.push(`Search context: ${meta.search_query}`);
    if (command) contextParts.push(`Campaign intent: "${command}"`);

    if (typeof searchPersonalisationSignals === 'function' && allowPersonalisationSearch && getSignalPackage(lead)) {
      await assertLlmBudgetOpen(clientId);
      try {
        const signals = await searchPersonalisationSignals(lead);
        if (signals.length > 0) {
          contextParts.push('', 'RECENT SIGNALS (from web search — reference these if relevant):');
          for (const s of signals) {
            contextParts.push(`- ${s.text}${s.date ? ` (${s.date})` : ''} [source: ${s.source}]`);
          }
        }
      } catch (err) {
        console.warn(`[pipeline.processLead] personalisation search skipped for ${lead.name}:`, err.message);
      }
    } else if (typeof searchPersonalisationSignals === 'function') {
      console.log(`[pipeline.processLead] Skipping open-web personalization for ${lead.name}: ${allowPersonalisationSearch ? 'missing signal_package' : 'paid signal disabled'}`);
    }

    // ── 4. Email enrichment (Lusha -> Snov -> Hunter -> MillionVerifier) ──
    await enrichEmail(clientId, lead, {
      pipeline_path: pipelinePath,
      hunterService,
    });

    // ── 5. Channel selection ──
    let linkedinAlreadyTried = false;
    if (!lead.email && lead.linkedin_url) {
      const prev = await pool.query(
        `SELECT id FROM messages WHERE client_id = $1 AND lead_id = $2 AND channel = 'linkedin' AND status NOT IN ('deleted') LIMIT 1`,
        [clientId, lead.id]
      );
      linkedinAlreadyTried = prev.rows.length > 0;
    }
    const channelChoice = selectChannel(lead, { linkedinAlreadyTried });
    const channel = channelChoice.channel;
    const messageStatus = channelChoice.status;
    if (messageStatus === 'blocked_no_email') {
      await trace('skipped', 'blocked_no_email', { agent: 'director', reason: channelChoice.reason, metadata: { lead_name: lead.name, drop: 'channel_blocked' } });
    }
    if (channel === 'linkedin' && linkedinAlreadyTried) {
      await trace('skipped', 'linkedin_already_tried', { agent: 'director', reason: 'channel_exhausted', metadata: { lead_name: lead.name, channel, drop: 'channel_exhausted' } });
      return { outcome: 'channel_exhausted' };
    }

    // ── 6. Pre-draft readiness gate ──
    const readiness = leadReadinessGate(lead);
    if (!readiness.ready) {
      await logsService.createLog(clientId, {
        agent: 'director', action: 'lead_not_ready', target_type: 'lead', target_id: lead.id,
        metadata: { reason: readiness.reason, channel, path: pipelinePath },
      }).catch(() => {});
      await trace('icp_rejected', 'lead_not_ready', { agent: 'director', reason: readiness.reason, metadata: { lead_name: lead.name, lead_company: lead.company } });
      return { outcome: 'lead_not_ready', reason: readiness.reason };
    }

    // ── 7. Dedup guard (before burning Sonnet tokens) ──
    const existingActive = await checkActiveMessage(clientId, lead.id);
    if (existingActive) {
      await trace('skipped', 'dedup_guard', { agent: 'director', reason: 'dedup_guard', metadata: { channel, existing_message_id: existingActive.id || null, drop: 'draft_skipped' } });
      return { outcome: 'dedup_skip' };
    }

    // ── 8. Draft (Sales Beaver + Captain fallback) ──
    const hint = channelHints[channel];
    const draft = await draftWithFallback(clientId, {
      lead_id: lead.id, channel,
      context: contextParts.join('\n') + (hint ? `\n\nCHANNEL INSTRUCTIONS: ${hint}` : ''),
      salesGenerate, rangerDraft, captainDraft, enableEnforcerFallback: true, lead,
      leadAngle: meta.angle, leadFriction: meta.friction,
      pipeline_path: pipelinePath,
      kickoff_id: kickoffId,
      defaultDraftSource: 'sales_beaver',
    });
    if (!draft || !draft.body) {
      await trace('draft_failed', 'no_body', { agent: 'sales_beaver', reason: 'no_body', metadata: { channel, enrichment_eligible: !!(lead.company && lead.title) } });
      return { outcome: 'draft_failed' };
    }

    const draftRequiresManualReview = draft.manualReview === true || draft.draftSource === 'captain_fallback';
    const reviewLead = draft.lead && typeof draft.lead === 'object' ? draft.lead : lead;
    const reviewMeta = getMetadata(reviewLead);
    const effectiveSignalPackage = draft.signal_package || reviewMeta.signal_package || meta.signal_package || null;
    const effectiveResearchRepair = draft.research_repair || reviewMeta.research_repair || meta.research_repair || null;
    const effectiveSignal = reviewMeta.signal || meta.signal || null;
    const effectiveWhyNow = reviewMeta.why_now || meta.why_now || null;
    const evidenceMetadata = {
      ...(effectiveSignalPackage ? { signal_package: effectiveSignalPackage } : {}),
      ...(effectiveResearchRepair ? { research_repair: effectiveResearchRepair } : {}),
    };

    // ── 9. Persist draft ──
    const msg = await persistDraft(clientId, {
      lead_id: lead.id, channel, subject: draft.subject, body: draft.body,
      status: draftRequiresManualReview ? 'pending_approval' : messageStatus,
      draft_source: draft.draftSource || 'sales_beaver',
      prompt_variant: draft.prompt_variant, signal: effectiveSignal,
      metadata: {
        ...(draftRequiresManualReview ? { captain_fallback_reason: draft.reason || null } : {}),
        ...evidenceMetadata,
      },
      kickoff_id: kickoffId, pipeline_path: pipelinePath,
    });
    recordOutcome(clientId, {
      outcome: 'drafted', leadId: lead.id, messageId: msg.id, channel,
      ...attributionFromLead(lead),
      eventData: { source_path: pipelinePath, status: draftRequiresManualReview ? 'pending_approval' : messageStatus, draft_source: draft.draftSource },
    });
    if (draftRequiresManualReview) {
      await pool.query(
        `INSERT INTO approvals (client_id, message_id, requested_by, status) VALUES ($1, $2, 'captain_fallback', 'pending')`,
        [clientId, msg.id]
      ).catch(() => {});
      await logsService.createLog(clientId, {
        agent: 'captain_beaver', action: 'captain_fallback_draft', target_type: 'message', target_id: msg.id,
        metadata: { channel, lead_name: lead.name, reason: draft.reason || null, pipeline_path: pipelinePath },
      }).catch(() => {});
      await trace('reviewed', 'captain_fallback_manual_review', {
        message_id: msg.id, agent: 'captain_beaver', reason: draft.reason || 'research_repair_exhausted',
        metadata: { channel },
      });
      return { outcome: 'manual_review', messageId: msg.id, channel, viaCaptainFallback: true };
    }

    if (messageStatus === 'blocked_no_email') {
      return { outcome: 'blocked_no_email', messageId: msg.id, channel };
    }

    // ── 10. Auto-fix + brand safety ──
    const touchNumber = msg.touch_number || 0;
    const preFix = autoFixMessage(msg.body || '', { touchNumber, maxWords: 80 });
    let currentBody = preFix.body;
    let currentSubject = typeof stripEmDashes === 'function' ? stripEmDashes(msg.subject) : msg.subject;
    if (preFix.fixes.length > 0) {
      await pool.query(
        `UPDATE messages SET body = $1, metadata = jsonb_set(COALESCE(metadata, '{}'), '{autofix}', $2::jsonb) WHERE id = $3 AND client_id = $4`,
        [currentBody, JSON.stringify(preFix.fixes), msg.id, clientId]
      );
    }
    const safety = brandSafetyCheck(currentBody, {
      name: reviewLead.name || lead.name, company: reviewLead.company || lead.company, title: reviewLead.title || lead.title,
      signal: effectiveSignal, why_now: effectiveWhyNow,
    });
    if (!safety.safe) {
      await pool.query(
        `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
        [`Brand safety: ${safety.reason}`, msg.id, clientId]
      );
      await trace('rejected', 'brand_safety', { message_id: msg.id, agent: 'sales_beaver', reason: safety.reason, metadata: { company: lead.company, channel } });
      return { outcome: 'brand_safety_rejected', messageId: msg.id, channel };
    }

    // ── 11. Enforcer review ──
    let rangerResult;
    try {
      rangerResult = await rangerReview(clientId, {
        message_id: msg.id, message_body: currentBody,
        lead_context: {
          name: reviewLead.name || lead.name, company: reviewLead.company || lead.company, title: reviewLead.title || lead.title, email: reviewLead.email || lead.email,
          lead_id: lead.id, signal: effectiveSignal, angle: reviewMeta.angle || meta.angle, friction: reviewMeta.friction || meta.friction,
          why_now: effectiveWhyNow, touch_number: touchNumber,
          signal_package: effectiveSignalPackage,
          research_repair: effectiveResearchRepair,
          pipeline_path: pipelinePath,
        },
      });
      if (rangerResult?.body) currentBody = rangerResult.body;
    } catch (err) {
      rangerResult = { approved: false, decision: 'reject', score: 0, notes: 'Enforcer unavailable (Claude API failed) — manual review required', breakdown: null };
    }
    await trace('reviewed', rangerResult?.approved ? 'approved' : 'rejected', {
      message_id: msg.id, agent: 'enforcer_beaver', score: rangerResult?.score ?? null,
      reason: rangerResult?.notes || null, metadata: { channel },
    });

    // ── 12. Rejection → 2-attempt Sales redraft loop, then Captain fallback ──
    if (!rangerResult?.approved) {
      if (rangerResult?.repair_route === 'needs_research_repair') {
        if (rangerResult?.captain_fallback?.body) {
          currentBody = rangerResult.captain_fallback.body;
          currentSubject = rangerResult.captain_fallback.subject || currentSubject || `${lead.company}`;
          await pool.query(
            `UPDATE messages SET body = $1, subject = $2, status = 'pending_approval', ranger_score = 0, ranger_notes = $3, updated_at = NOW() WHERE id = $4 AND client_id = $5`,
            [currentBody, currentSubject, 'Captain fallback — Research repair already exhausted. Review before sending.', msg.id, clientId]
          );
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by, status) VALUES ($1, $2, 'captain_fallback', 'pending')`,
            [clientId, msg.id]
          ).catch(() => {});
          await logsService.createLog(clientId, {
            agent: 'captain_beaver', action: 'captain_fallback_draft', target_type: 'message', target_id: msg.id,
            metadata: { channel, lead_name: lead.name, reason: rangerResult?.notes || null },
          }).catch(() => {});
          return { outcome: 'manual_review', messageId: msg.id, channel, viaCaptainFallback: true };
        }
        await pool.query(
          `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
          [rangerResult?.required_repair || rangerResult?.notes || 'Routed to Research repair. No Sales redraft until Research repairs the lead.', msg.id, clientId]
        );
        return { outcome: 'needs_research_repair', messageId: msg.id, channel };
      }

      const attemptRow = await pool.query(
        `SELECT ranger_attempt_count FROM messages WHERE id = $1 AND client_id = $2`, [msg.id, clientId]
      );
      const attemptCount = attemptRow.rows[0]?.ranger_attempt_count || 0;

      if (attemptCount < 2) {
        const rejectionFeedback = rangerResult?.reject_reason || rangerResult?.notes || 'Message did not pass quality gates';
        const feedbackContext = [
          `Name: ${lead.name}`, `Company: ${lead.company}`, `Title: ${lead.title || 'N/A'}`,
          meta.signal ? `Signal: ${meta.signal}` : '', meta.angle ? `Angle: ${meta.angle}` : '',
          meta.friction ? `Friction: ${meta.friction}` : '',
          `\nPREVIOUS ATTEMPT REJECTED: ${rejectionFeedback}`,
          `Previous message that was rejected:\n${currentBody}`,
          `\nRewrite the message fixing the issue above. Do NOT repeat the same structure.`,
          `\nCRITICAL: Day 0 email body 50-60 words MAX (hard reject 81+). One sentence per section.`,
        ].filter(Boolean).join('\n');
        try {
          const redraft = await salesGenerate(clientId, { lead_id: lead.id, channel, context: feedbackContext });
          if (redraft?.body) {
            currentBody = typeof stripEmDashes === 'function' ? stripEmDashes(redraft.body) : redraft.body;
            currentSubject = redraft.subject || currentSubject;
            await pool.query(
              `UPDATE messages SET body = $1, subject = $2, ranger_attempt_count = $3, ranger_notes = $4, status = 'pending_ranger', updated_at = NOW() WHERE id = $5 AND client_id = $6`,
              [currentBody, currentSubject, attemptCount + 1, `Redraft ${attemptCount + 1}: fixing — ${rejectionFeedback}`, msg.id, clientId]
            );
            rangerResult = await rangerReview(clientId, {
              message_id: msg.id, message_body: currentBody,
              lead_context: {
                name: lead.name, company: lead.company, title: lead.title, email: lead.email,
                lead_id: lead.id, signal: effectiveSignal, angle: reviewMeta.angle || meta.angle, friction: reviewMeta.friction || meta.friction,
                why_now: effectiveWhyNow, signal_package: effectiveSignalPackage,
                research_repair: effectiveResearchRepair, pipeline_path: pipelinePath,
              },
            });
            if (beaverState && typeof beaverState.recordImprovementAfterFeedback === 'function') {
              beaverState.recordImprovementAfterFeedback(clientId, {
                lead_id: lead.id, original_message_id: msg.id, retry_message_id: msg.id,
                original_reject_reason: rejectionFeedback, retry_passed: rangerResult?.approved === true,
              }).catch(() => {});
            }
          }
        } catch (redraftErr) {
          console.warn('[pipeline.processLead] Sales redraft failed:', redraftErr.message);
          rangerResult = rangerResult || { approved: false };
          rangerResult.approved = false;
        }
      }

      if (!rangerResult?.approved && rangerResult?.repair_route === 'needs_research_repair') {
        if (rangerResult?.captain_fallback?.body) {
          currentBody = rangerResult.captain_fallback.body;
          currentSubject = rangerResult.captain_fallback.subject || currentSubject || `${lead.company}`;
          await pool.query(
            `UPDATE messages SET body = $1, subject = $2, status = 'pending_approval', ranger_score = 0, ranger_notes = $3, updated_at = NOW() WHERE id = $4 AND client_id = $5`,
            [currentBody, currentSubject, 'Captain fallback — Research repair already exhausted. Review before sending.', msg.id, clientId]
          );
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by, status) VALUES ($1, $2, 'captain_fallback', 'pending')`,
            [clientId, msg.id]
          ).catch(() => {});
          return { outcome: 'manual_review', messageId: msg.id, channel, viaCaptainFallback: true };
        }
        await pool.query(
          `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
          [rangerResult?.required_repair || rangerResult?.notes || 'Routed to Research repair after Sales redraft.', msg.id, clientId]
        );
        return { outcome: 'needs_research_repair', messageId: msg.id, channel };
      }

      // Still rejected -> Captain writes the manual-review fallback.
      if (!rangerResult?.approved) {
        const finalRejectReason = rangerResult?.notes || 'Sales Beaver failed after bounded redrafts';
        let captainResult = null;
        if (captainDraft) {
          captainResult = await captainDraft(clientId, {
            lead: reviewLead || lead,
            lead_id: lead.id,
            channel,
            context: '',
            signal_package: effectiveSignalPackage,
            reason: finalRejectReason,
            missing_fields: [],
            rejected_body: currentBody,
          }).catch((err) => {
            console.warn('[pipeline.processLead] Captain fallback failed:', err.message);
            return null;
          });
        }
        if (captainResult?.body && typeof captainResult.body === 'string') {
          currentBody = captainResult.body;
          currentSubject = captainResult.subject || currentSubject || `${lead.company}`;
          await pool.query(
            `UPDATE messages SET body = $1, subject = $2, status = 'pending_approval', ranger_score = 0, ranger_notes = $3, updated_at = NOW() WHERE id = $4 AND client_id = $5`,
            [currentBody, currentSubject, 'Captain fallback - Sales Beaver failed after bounded redrafts. Review before sending.', msg.id, clientId]
          );
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by, status) VALUES ($1, $2, 'captain_fallback', 'pending')`,
            [clientId, msg.id]
          ).catch(() => {});
          await logsService.createLog(clientId, {
            agent: 'captain_beaver', action: 'captain_fallback_draft', target_type: 'message', target_id: msg.id,
            metadata: { channel, lead_name: lead.name, original_rejection: finalRejectReason },
          }).catch(() => {});
          await trace('reviewed', 'captain_fallback_manual_review', { message_id: msg.id, agent: 'captain_beaver', score: 0, reason: finalRejectReason, metadata: { channel } });
          return { outcome: 'manual_review', messageId: msg.id, channel, viaCaptainFallback: true };
        }
        // Last resort - Sales failed and Captain fallback was unavailable.
        await pool.query(
          `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
          ['Sales failed after bounded redrafts and Captain fallback did not produce a draft. Manual message required.', msg.id, clientId]
        );
        await trace('rejected', 'captain_fallback_failed', { message_id: msg.id, agent: 'captain_beaver', score: rangerResult?.score ?? null, reason: finalRejectReason, metadata: { channel } });
        return { outcome: 'rejected', messageId: msg.id, channel };
      }
    }

    // ── 13. Final pre-save auto-fix safety net ──
    const finalFix = autoFixMessage(currentBody, { touchNumber, maxWords: 80 });
    if (finalFix.fixes.length > 0) currentBody = finalFix.body;

    // ── 14. Enforcer approved → shared auto-approve / borderline / manual decision ──
    await applyEnforcerDecision(clientId, {
      msg, lead: reviewLead, rangerResult, finalBody: currentBody, subject: currentSubject,
      kickoffId, pipelinePath, source: pipelinePath,
    });
    return { outcome: 'approved', messageId: msg.id, channel };
  } catch (err) {
    if (isBudgetExceededError(err)) {
      console.error(`[pipeline.processLead] Budget cap abort while processing ${lead.name}:`, err.message);
      await trace('draft_failed', 'budget_exceeded_abort', { agent: 'director', reason: err.message, metadata: { lead_name: lead.name } });
      throw err;
    }
    console.error(`[pipeline.processLead] Error processing ${lead.name}:`, err.message);
    await trace('draft_failed', 'unexpected_error', { agent: 'director', metadata: { lead_name: lead.name, error: err.message } });
    return { outcome: 'draft_failed', reason: err.message };
  }
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
 *   - ranger_score      Optional. Set when caller needs a manual-review score.
 *                       Otherwise null and review pass writes it via UPDATE.
 *   - ranger_notes      Optional, paired with ranger_score.
 *   - metadata          jsonb merged into the row's metadata column.
 *   - draft_source      'sales_beaver' | 'captain_fallback' (for trace + metadata).
 *   - prompt_variant    Sales Beaver prompt variant tag (or 'captain_fallback').
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
  //   source         — sales_beaver vs captain_fallback (matters for KPI calc)
  //   prompt_variant — for reply-rate-by-variant slicing (Wave 3 requirement)
  //   signal         — copy of lead's trigger, useful when joining traces
  //   blocked_reason — only when status = blocked_no_email
  const finalMetadata = {
    source: draft_source,
    prompt_variant: prompt_variant || (draft_source === 'captain_fallback' ? 'captain_fallback' : null),
    signal,
    kickoff_id,
    pipeline_path,
    ...(status === 'blocked_no_email' ? { blocked_reason: 'awaiting_email_enrichment' } : {}),
    ...metadata,
  };

  // Two SQL shapes: with ranger_score (manual-review path) vs without.
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
    agent: draft_source === 'captain_fallback' ? 'captain_beaver' : 'sales_beaver',
    score: ranger_score,
    pipeline_path,
    metadata: { channel, draft_source, signal },
  }).catch(() => {});

  return row;
}

// ─── STEP 3 (this commit): enrichment + draft helpers ──────────────────────
//
// Step 3 of the Phase 2 plan is "extract pipeline.draft (Sales Beaver + email
// enrichment + dedup) — ~150 lines moved". The literal one-shot extraction risks
// behaviour drift because the 4 call sites differ in real ways (signal has
// Captain fallback, kickoff injects CHANNEL_HINTS).
//
// Risk-correct path tonight: extract the two helpers with the highest
// line-for-line duplication and zero behaviour change:
//
//   - enrichEmail(clientId, lead, options)         — Lusha -> Snov -> Hunter -> MillionVerifier
//   - draftWithFallback(clientId, params)          — Sales Beaver + optional Captain fallback
//
// Caller wiring stays. Channel selection, dedup, Captain-validate, persistDraft
// remain in agents.js. Step 7 will compose pipeline.processLead from these
// helpers + persistDraft + checkActiveMessage.
//
// Both helpers take service functions via dependency injection to avoid the
// pipeline.js ↔ agents.js circular require. Caller passes:
//   - hunterService:      { findEmail }
//   - salesGenerate:      fn(clientId, {lead_id,channel,context}) -> {body,subject,prompt_variant}|null
//   - rangerDraft:        fn(clientId, {lead_name,...}) -> {body,subject}|null   (optional, for fallback)
//   - captainDraft:       fn(clientId, {lead,...}) -> {body,subject}|null       (bounded research fallback)

/**
 * Enrich a lead's email if missing. Mutates `lead` in place and writes to DB.
 *
 * Mirrors the email-enrichment blocks in agents.js:
 *   signal_pipeline: Lusha -> Snov -> Hunter -> MillionVerifier
 *   kickoff_pipeline: Lusha -> Snov -> Hunter -> MillionVerifier
 * Phase 3 signal execution contract: Research must provide company evidence
 * and decision-maker context before this email enrichment step runs. This
 * helper remains the shared contact-enrichment layer.
 *
 * @param {string} clientId
 * @param {object} lead    Has .id, .name, .company, .email, .quality_score
 * @param {object} options
 *   - pipeline_path:        'signal_pipeline' | 'kickoff_pipeline' (for log prefix)
 *   - hunterService:        legacy injected service; findEmail orchestrator owns provider order
 *
 * @returns {Promise<{ enriched: boolean, source: string|null, reason: string|null }>}
 *   Side-effect: lead.email / lead.email_source / lead.email_verified updated when found.
 */
async function enrichEmail(clientId, lead, options = {}) {
  const {
    pipeline_path = 'unknown',
  } = options;

  if (lead.email) {
    return { enriched: false, source: null, reason: 'already_has_email' };
  }

  const logPrefix = `[${pipeline_path}]`;

  // ── v2 (P0 2026-05-23): findEmail orchestrator ───────────────────────
  // VP is not part of autonomous Beaver sourcing. findEmail discovers
  // domain via Brave, tries Lusha -> Snov -> Hunter, scrapes/patterns
  // candidates, then verifies selected candidates via MillionVerifier.
  //
  // hunterService is legacy DI; the findEmail orchestrator owns the provider
  // order: public web evidence -> Lusha -> Snov -> Hunter -> MillionVerifier.
  //
  // Spend gate: all provider calls are finite and spendGuard-capped.
  // findEmail spends only within per-lead caps and uses MV as the final
  // deliverability authority.
  // Per-tenant daily cap upstream (deferred — for now, count via metadata
  // on inserts). Worst case: 3 verify calls per lead × 50 leads/day = 150
  // credits/day. At 500-credit free cap, that's ~3 days. Monitor + paid
  // top-up decision is MJ's.
  try {
    const { findEmail } = require('./emailEnrichment');
    const result = await findEmail({
      name: lead.name,
      company: lead.company,
      first_name: lead.first_name || null,
      last_name: lead.last_name || null,
      domain: lead.domain || null,
      clientId,
    });
    if (result?.email) {
      await pool.query(
        `UPDATE leads SET email = $1, email_verified = $2, email_source = $3, updated_at = NOW()
          WHERE id = $4 AND client_id = $5`,
        [result.email, result.status === 'deliverable', result.email_source || 'findemail', lead.id, clientId]
      );
      lead.email = result.email;
      lead.email_source = result.email_source || 'findemail';
      lead.email_verified = result.status === 'deliverable';
      lead.email_confidence = result.confidence;
      lead.email_is_catch_all = result.isCatchAll;
      console.log(`${logPrefix} findEmail sourced ${result.email} for ${lead.name} (status=${result.status}, conf=${result.confidence}, source=${result.email_source})`);
      return { enriched: true, source: result.email_source || 'findemail', reason: null };
    }
    return { enriched: false, source: null, reason: 'no_email_found' };
  } catch (err) {
    console.warn(`${logPrefix} findEmail failed for ${lead.name}: ${err.message}`);
    return { enriched: false, source: null, reason: 'findemail_error' };
  }
}

const TRUSTED_EMAIL_SOURCES = new Set([
  'hunter',
  'pattern+verify',
  'scrape+pattern',
  'scrape',
  'vibe_csv',
  'apollo_csv',
  'vibe_prospecting',
]);

function isVerifiedEmailReadyLead(lead = {}) {
  if (!lead?.email) return false;
  if (lead.email_verified === true) return true;
  const metadata = lead.metadata && typeof lead.metadata === 'object' ? lead.metadata : {};
  const source = String(
    lead.email_source
    || metadata.email_source
    || metadata.import_source
    || metadata.source
    || ''
  ).toLowerCase();
  return TRUSTED_EMAIL_SOURCES.has(source);
}

/**
 * Draft a message body via Sales Beaver, with optional Captain fallback if
 * Sales Beaver returns no body.
 *
 * Mirrors the Sales+fallback block in agents.js:
 *   signal_pipeline: lines 1746-1770   (with Captain fallback)
 *   kickoff_pipeline: lines 3061-3083  (no fallback — kickoff treats no-body as draft_failed)
 *
 * Returns null when both Sales Beaver and the optional Captain fallback fail.
 * Caller decides whether to log/trace draft_failed and continue.
 *
 * @param {string} clientId
 * @param {object} params
 *   - lead_id          required
 *   - channel          required ('email'|'linkedin'|...)
 *   - context          required, the prompt context string for Sales Beaver
 *   - salesGenerate    required, fn(clientId, {lead_id,channel,context}) -> {body,subject,prompt_variant}|null
 *   - rangerDraft      legacy optional, no longer used as a writer fallback.
 *   - captainDraft     optional, used after the bounded Research repair loop is exhausted.
 *   - enableEnforcerFallback  legacy flag. When true, Captain fallback is required.
 *   - lead             required if enableEnforcerFallback.
 *   - pipeline_path    default 'unknown', for log prefix
 *
 * @returns {Promise<{body,subject,draftSource,prompt_variant}|null>}
 *   draftSource = 'sales_beaver' (default) | 'captain_fallback'
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
    captainDraft = null,
    enableEnforcerFallback = false,
    lead = null,
    leadAngle = null,
    leadFriction = null,
    pipeline_path = 'unknown',
    kickoff_id = null,
    defaultDraftSource = 'sales_beaver',  // signal_pipeline historically used 'signal_hunt'
    recordRepairRoute: recordRepairRouteFn = recordRepairRoute,
    repairSignalPackage = defaultRepairSignalPackage,
    reloadLead = defaultReloadLead,
    inlineResearchRepair = true,
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
    const leadMeta = getMetadata(lead || {});
    return {
      body: salesResult.body,
      subject: salesResult.subject || null,
      draftSource: defaultDraftSource,
      prompt_variant: salesResult.prompt_variant || null,
      signal_package: salesResult.signal_package || getSignalPackage(lead || {}) || null,
      research_repair: salesResult.research_repair || leadMeta.research_repair || null,
      lead,
    };
  }

  if (salesResult?.status === 'needs_more_research') {
    console.warn(`${logPrefix} Sales routed lead ${lead_id} to Research repair: ${salesResult.reason || 'needs_more_research'}`);
    const signalPackage = salesResult.signal_package || getSignalPackage(lead || {}) || null;
    const repairAttempt = Number(salesResult.repair_attempt ?? salesResult.repairAttempt ?? 0) || 0;
    const maxRepairAttempts = Math.max(
      1,
      Number(salesResult.max_repair_attempts ?? salesResult.maxRepairAttempts ?? repairPolicy.DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS)
        || repairPolicy.DEFAULT_MAX_RESEARCH_REPAIR_ATTEMPTS
    );
    const repairExhausted = repairPolicy.researchRepairExhausted({ repairAttempt, maxRepairAttempts });
    const canInlineRepair = inlineResearchRepair && !repairExhausted && typeof repairSignalPackage === 'function';
    const repairPayload = repairPolicy.buildResearchRepairPayload({
      leadId: lead_id,
      kickoffId: kickoff_id,
      channel,
      pipelinePath: pipeline_path,
      failedRule: salesResult.reason || 'needs_more_research',
      reason: salesResult.required_repair || salesResult.reason || 'needs_more_research',
      missingFields: salesResult.missing_fields || [],
      requiredRepair: salesResult.required_repair || null,
      repairAttempt,
      maxRepairAttempts,
      signalPackage,
      sourceUrl: signalPackage?.source_url || null,
      sourceChannel: signalPackage?.source_channel || null,
      evidenceDecision: salesResult.evidence_decision || null,
    });
    await recordRepairRouteFn(clientId, {
      lead_id,
      kickoff_id,
      pipeline_path,
      agent: 'sales_beaver',
      source: 'sales_preflight',
      channel,
      repair_route: salesResult.repair_route || 'needs_research_repair',
      failed_rule: salesResult.reason || 'needs_more_research',
      reason: salesResult.required_repair || salesResult.reason || 'needs_more_research',
      repair_attempt: repairAttempt,
      max_repair_attempts: maxRepairAttempts,
      signal_package: signalPackage,
      write_directive: !canInlineRepair,
      metadata: {
        missing_fields: salesResult.missing_fields || [],
        status: salesResult.status,
        required_repair: salesResult.required_repair || null,
      },
    }).catch(() => {});

    if (canInlineRepair) {
      const repairResult = await repairSignalPackage(clientId, repairPayload).catch((err) => {
        console.warn(`${logPrefix} Inline Research repair failed for lead ${lead_id}: ${err.message}`);
        return { repaired: false, reason: err.message };
      });
      const repairedLead = typeof reloadLead === 'function'
        ? await reloadLead(clientId, lead_id).catch(() => null)
        : null;
      const leadForFallback = repairedLead || lead;

      if (repairResult?.repaired) {
        const retryResult = await salesGenerate(clientId, { lead_id, channel, context });
        if (retryResult?.body) {
          const leadMeta = getMetadata(leadForFallback || {});
          const retrySignalPackage = retryResult.signal_package
            || repairResult.signal_package
            || getSignalPackage(leadForFallback || {})
            || null;
          return {
            body: retryResult.body,
            subject: retryResult.subject || null,
            draftSource: defaultDraftSource,
            prompt_variant: retryResult.prompt_variant || null,
            signal_package: retrySignalPackage,
            research_repair: retryResult.research_repair || leadMeta.research_repair || null,
            lead: leadForFallback,
          };
        }
        if (retryResult?.status === 'needs_more_research') {
          await recordRepairRouteFn(clientId, {
            lead_id,
            kickoff_id,
            pipeline_path,
            agent: 'sales_beaver',
            source: 'sales_preflight_after_inline_repair',
            channel,
            repair_route: retryResult.repair_route || 'needs_research_repair',
            failed_rule: retryResult.reason || 'needs_more_research',
            reason: retryResult.required_repair || retryResult.reason || 'research_repair_exhausted',
            repair_attempt: maxRepairAttempts,
            max_repair_attempts: maxRepairAttempts,
            signal_package: retryResult.signal_package || repairResult.signal_package || getSignalPackage(leadForFallback || {}) || null,
            write_directive: false,
            metadata: {
              missing_fields: retryResult.missing_fields || [],
              status: retryResult.status,
              required_repair: retryResult.required_repair || null,
              inline_repair_result: repairResult.reason || 'repaired',
            },
          }).catch(() => {});
        }
      }

      if (captainDraft && leadForFallback) {
        const captainResult = await captainDraft(clientId, {
          lead: leadForFallback,
          lead_id,
          channel,
          context,
          signal_package: repairResult?.signal_package || getSignalPackage(leadForFallback || {}) || signalPackage,
          reason: repairResult?.repaired
            ? 'research_repair_retry_still_failed'
            : (repairResult?.reason || salesResult.required_repair || salesResult.reason || 'research_repair_failed'),
          missing_fields: repairResult?.missing_fields || salesResult.missing_fields || [],
        }).catch((err) => {
          console.warn(`${logPrefix} Captain fallback failed for lead ${lead_id}: ${err.message}`);
          return null;
        });
        if (captainResult?.body && typeof captainResult.body === 'string') {
          const leadMeta = getMetadata(leadForFallback || {});
          return {
            body: captainResult.body,
            subject: captainResult.subject || null,
            draftSource: 'captain_fallback',
            prompt_variant: 'captain_fallback',
            manualReview: true,
            reason: repairResult?.reason || salesResult.required_repair || salesResult.reason || 'research_repair_failed',
            signal_package: repairResult?.signal_package || getSignalPackage(leadForFallback || {}) || signalPackage,
            research_repair: leadMeta.research_repair || null,
            lead: leadForFallback,
          };
        }
      }
      return null;
    }

    if (repairExhausted && captainDraft && lead) {
      const captainResult = await captainDraft(clientId, {
        lead,
        lead_id,
        channel,
        context,
        signal_package: signalPackage,
        reason: salesResult.required_repair || salesResult.reason || 'research_repair_exhausted',
        missing_fields: salesResult.missing_fields || [],
      }).catch((err) => {
        console.warn(`${logPrefix} Captain fallback failed for lead ${lead_id}: ${err.message}`);
        return null;
      });
      if (captainResult?.body && typeof captainResult.body === 'string') {
        const leadMeta = getMetadata(lead || {});
        return {
          body: captainResult.body,
          subject: captainResult.subject || null,
          draftSource: 'captain_fallback',
          prompt_variant: 'captain_fallback',
          manualReview: true,
          reason: salesResult.required_repair || salesResult.reason || 'research_repair_exhausted',
          signal_package: signalPackage,
          research_repair: leadMeta.research_repair || null,
          lead,
        };
      }
    }
    return null;
  }

  if (!enableEnforcerFallback) {
    console.warn(`${logPrefix} Sales draft failed for lead ${lead_id} (${channel}): no body`);
    return null;
  }

  if (!lead) {
    throw new Error('draftWithFallback: lead is required when enableEnforcerFallback=true');
  }
  if (!captainDraft) {
    throw new Error('draftWithFallback: captainDraft is required when enableEnforcerFallback=true');
  }

  console.warn(`${logPrefix} Sales draft failed for ${lead.name} - Captain drafting fallback`);
  const captainResult = await captainDraft(clientId, {
    lead,
    lead_id,
    channel,
    context,
    signal_package: getSignalPackage(lead || {}) || null,
    reason: 'sales_returned_no_body',
    missing_fields: [],
    rejected_body: '',
  });

  if (!captainResult?.body || typeof captainResult.body !== 'string') {
    console.warn(`${logPrefix} Captain fallback also failed for ${lead.name} - skipping`);
    return null;
  }

  return {
    body: captainResult.body,
    subject: captainResult.subject || `${lead.company}`,
    draftSource: 'captain_fallback',
    prompt_variant: 'captain_fallback',
    manualReview: true,
    reason: 'sales_returned_no_body',
    signal_package: getSignalPackage(lead || {}) || null,
    research_repair: getMetadata(lead || {}).research_repair || null,
    lead,
  };
}

async function recordRepairRoute(clientId, {
  lead_id = null,
  message_id = null,
  kickoff_id = null,
  pipeline_path = 'unknown',
  agent = 'enforcer_beaver',
  source = 'enforcer_evidence_gate',
  channel = null,
  repair_route = 'manual_review',
  failed_rule = null,
  reason = null,
  repair_attempt = null,
  max_repair_attempts = null,
  signal_package = null,
  write_directive = true,
  metadata = {},
} = {}) {
  if (!clientId) return { recorded: false, reason: 'missing_client_id' };
  const repairState = repairPolicy.researchRepairState({
    repair_attempt,
    max_repair_attempts,
    metadata,
  });
  const repairExhausted = repairPolicy.researchRepairExhausted(repairState);
  const signalPackageHash = repairPolicy.signalPackageHash(signal_package);
  const repairMetadata = {
    ...metadata,
    repair_route,
    failed_rule,
    source,
    channel,
    repair_attempt: repairState.repairAttempt,
    max_repair_attempts: repairState.maxRepairAttempts,
    repair_exhausted: repairExhausted,
    signal_package_hash: signalPackageHash,
  };

  await logsService.createLog(clientId, {
    agent,
    action: 'repair_route_recorded',
    target_type: message_id ? 'message' : 'lead',
    target_id: message_id || lead_id,
    metadata: repairMetadata,
  }).catch(() => {});

  if (lead_id || message_id) {
    pipelineTrace.traceStage(clientId, {
      lead_id,
      message_id,
      kickoff_id,
      stage: 'repair_routed',
      status: repair_route || 'manual_review',
      agent,
      reason: reason || failed_rule || repair_route,
      pipeline_path,
      metadata: repairMetadata,
    }).catch(() => {});
  }

  let directiveWritten = false;
  if (write_directive && repair_route === 'needs_research_repair' && lead_id && !repairExhausted) {
    try {
      const directive = directivesSvc.buildRepairSignalPackageDirective({
        leadId: lead_id,
        messageId: message_id,
        kickoffId: kickoff_id,
        channel,
        pipelinePath: pipeline_path,
        failedRule: failed_rule,
        reason,
        missingFields: metadata.missing_fields || metadata.issues || [],
        requiredRepair: metadata.required_repair || reason,
        repairAttempt: repairState.repairAttempt,
        maxRepairAttempts: repairState.maxRepairAttempts,
        signalPackage: signal_package,
        sourceUrl: metadata.source_url || signal_package?.source_url || null,
        sourceChannel: metadata.source_channel || signal_package?.source_channel || null,
        querySetHash: metadata.query_set_hash || null,
        evidenceDecision: metadata.evidence_decision || null,
      });
      await directivesSvc.writeDirective(clientId, 'research_beaver', 'repair_signal_package', directive.payload, {
        reason: reason || failed_rule || 'Research must repair signal_package before Sales retries.',
        severity: 'high',
        expiresInHours: 12,
      });
      directiveWritten = true;
    } catch (err) {
      console.warn('[pipeline.repair-route] failed to write Research repair directive:', err.message);
    }
  }

  return { recorded: true, repair_route, repair_exhausted: repairExhausted, directive_written: directiveWritten };
}

// ─── STEP 4 (this commit): ICP gate (soft-delete shape) ────────────────────
//
// Step 4 of the Phase 2 plan is "extract pipeline.icpGate (applyIcpV2Filter +
// soft-delete + audit)". The "soft-delete" wording maps to the signal_pipeline
// re-audit shape (existing pool leads, UPDATE deleted_at). The kickoff fresh-
// research INSERT shape is a different operation (covered later when we
// audit cold-research path explicitly).
//
// Caller wiring stays. Caller passes applyIcpV2Filter via DI (it lives in
// agents.js, same circular-import constraint as Step 3).

const logsService = require('./logs');

const ICP_REJECT_STATUS_ALLOW_LIST = [
  'rejected_country', 'rejected_size', 'rejected_persona',
  'rejected_vertical', 'rejected_data_integrity', 'rejected_low_score',
];

/**
 * ICP gate for an *existing* pool lead. If verdict fails, soft-deletes the
 * lead row, writes the icp_v2_reject log, emits the icp_rejected trace.
 *
 * Mirrors agents.js processExistingLeadsPipeline lines 1617-1654 (the Phase
 * 5.5 draft-time re-audit added 2026-05-06).
 *
 * @param {string} clientId
 * @param {object} lead     Has .id, .name, .company, .title (used for log + trace metadata)
 * @param {object} options
 *   - applyIcpV2Filter:  required, fn(lead) -> {pass, status, reason}
 *   - kickoff_id:        optional, for the trace
 *   - pipeline_path:     'signal_pipeline' (default) | future paths
 *   - audit_source:      string, written to lead.metadata.audit_source
 *
 * @returns {Promise<{pass: true} | {pass: false, status: string, reason: string}>}
 */
async function icpGateSoftDelete(clientId, lead, options = {}) {
  const {
    applyIcpV2Filter,
    kickoff_id = null,
    pipeline_path = 'signal_pipeline',
    audit_source = 'pipeline_icp_gate',
  } = options;

  if (!applyIcpV2Filter) {
    throw new Error('icpGateSoftDelete: applyIcpV2Filter is required');
  }
  if (!clientId || !lead?.id) {
    throw new Error('icpGateSoftDelete: clientId and lead.id are required');
  }

  const verdict = applyIcpV2Filter(lead);
  if (verdict.pass) {
    pipelineTrace.traceStage(clientId, {
      lead_id: lead.id,
      kickoff_id,
      stage: 'icp_passed',
      status: 'pass',
      agent: 'director',
      pipeline_path,
      metadata: { company: lead.company, title: lead.title },
    }).catch(() => {});
    return { pass: true };
  }

  const safeStatus = ICP_REJECT_STATUS_ALLOW_LIST.includes(verdict.status)
    ? verdict.status
    : 'rejected_persona';

  // Soft-delete so the lead can't be re-picked next chat run.
  await pool.query(
    `UPDATE leads SET deleted_at = NOW(), status = $1,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $3 AND client_id = $4 AND deleted_at IS NULL`,
    [
      safeStatus,
      JSON.stringify({ icp_audit_reason: verdict.reason, audit_source }),
      lead.id,
      clientId,
    ]
  ).catch(() => {});

  // Audit log (legacy logs table — for backward-compat tooling).
  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'icp_v2_reject',
    target_type: 'lead',
    target_id: lead.id,
    metadata: {
      plan_id: kickoff_id,
      status: safeStatus,
      reason: verdict.reason,
      company: lead.company,
      title: lead.title,
    },
  }).catch(() => {});

  // Phase 1 (2026-05-08): canonical observability via pipeline_traces.
  pipelineTrace.traceStage(clientId, {
    lead_id: lead.id,
    kickoff_id,
    stage: 'icp_rejected',
    status: safeStatus,
    agent: 'director',
    reason: verdict.reason,
    pipeline_path,
    metadata: {
      company: lead.company,
      title: lead.title,
      audit_source,
    },
  }).catch(() => {});

  return { pass: false, status: safeStatus, reason: verdict.reason };
}

// ─── PHASE 3 PIVOT (this commit): Lead readiness gate (pre-draft) ──────────
//
// Per MJ direction 2026-05-08 (~23:50 MYT): "buying signal is over everything.
// Captain should be aligned with Enforcer." After audit, captainValidate's
// real job (lead-data integrity: name, company, contact-method) belongs
// PRE-draft, not post-draft. Its placeholder/empty-body checks duplicate
// Enforcer's rubric. Decision: move integrity checks pre-draft and remove
// captainValidate post-draft entirely, so both pipelines have identical
// post-draft flow (Enforcer only).
//
// This pulls Phase 3 ("Lead readiness gate", originally W3 May 26-30) ahead
// to tonight, and de-risks Phase 2 Step 5 (pipeline.review) from HIGH to LOW
// because both pipelines now converge on a single review shape.

const PLACEHOLDER_RE = /\[NAME\]|\[COMPANY\]|\{\{|\}\}/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pre-draft check: does this lead have enough metadata to be worth drafting?
 *
 * Pure function — no DB writes, no logs, no traces. Caller decides whether
 * to skip (silent), enrichment-retry, or soft-delete the lead. This is the
 * realised form of the legacy captainValidate checks 1-3 (lead-level) — moved
 * upstream so we don't burn LLM tokens on incomplete leads.
 *
 * Returns:
 *   { ready: true }
 * or
 *   { ready: false, reason: 'missing_name' | 'missing_company' | 'no_contact_method' }
 */
function leadReadinessGate(lead) {
  if (!lead) return { ready: false, reason: 'no_lead' };
  if (!lead.name || lead.name === 'Unknown Contact') {
    return { ready: false, reason: 'missing_name' };
  }
  if (!lead.company || lead.company === 'Unknown Company') {
    return { ready: false, reason: 'missing_company' };
  }
  const hasEmail = lead.email && EMAIL_RE.test(lead.email);
  const hasLinkedIn = !!lead.linkedin_url;
  if (!hasEmail && !hasLinkedIn) {
    return { ready: false, reason: 'no_contact_method' };
  }
  return { ready: true };
}

/**
 * applyEnforcerDecision — Phase 2 Step 6 (Jules F-11, 2026-05-16).
 *
 * Single source of truth for the post-Enforcer-approval decision: auto-approve
 * vs borderline-surface vs manual-queue, plus all persistence (messages UPDATE,
 * approvals INSERT, approval_audit INSERT, send-queue enqueue, trace, log).
 *
 * Previously this ~180-line block was duplicated in processExistingLeadsPipeline
 * (signal) and processLeadPipeline (kickoff). The two copies had DRIFTED in ~7
 * ways — signal didn't persist subject/ranger_breakdown, kickoff didn't emit an
 * 'approved' trace, provenance labels diverged. The DECISION logic (3 contract
 * gates, threshold, the 60-79 borderline band) was byte-identical; only the
 * peripherals drifted. This unifies them — reconciled toward the more-complete
 * behaviour (always persist subject + breakdown, always trace, client-scoped
 * WHERE). Provenance labels are preserved per `source` so analytics don't shift.
 *
 * @param {string} clientId
 * @param {object} p
 * @param {object} p.msg            — message row (needs id, channel)
 * @param {object} p.lead           — lead row (needs id)
 * @param {object} p.rangerResult   — Enforcer output (score, two_thoughts, notes, feedback, breakdown)
 * @param {string} p.finalBody      — the body to persist
 * @param {string|null} p.subject   — the subject to persist (LinkedIn = null)
 * @param {string|null} p.kickoffId — kickoff/plan id for the trace (nullable)
 * @param {string} p.pipelinePath   — 'signal_pipeline' | 'kickoff_pipeline'
 * @param {string} p.source         — 'signal_pipeline' | 'kickoff_pipeline' (drives provenance labels)
 * @returns {Promise<{autoApproved:boolean, isBorderline:boolean, rangerScore:number, nextMessageStatus:string}>}
 */
async function applyEnforcerDecision(clientId, { msg, lead, rangerResult, finalBody, subject, kickoffId, pipelinePath, source }) {
  const rawRangerScore = Number(rangerResult?.score);
  const rangerScore = Number.isFinite(rawRangerScore) ? rawRangerScore : 0;
  let autoApproved = false;
  let isBorderline = false;
  let gateFailReason = null;
  let nextMessageStatus = 'pending_approval';
  let approvalStatus = 'pending';
  let resolvedAt = null;

  const twoThoughts = rangerResult?.two_thoughts;
  const hasTwoThoughts = twoThoughts && Array.isArray(twoThoughts) && twoThoughts.length > 0;

  // Fix 5c: score 60-79 = borderline, surfaced to the founder, never auto-approved.
  if (rangerScore >= 60 && rangerScore < 80) {
    isBorderline = true;
    nextMessageStatus = 'pending_approval';
    console.log(`[pipeline.approve] BORDERLINE ${msg.id}: score ${rangerScore}, surfacing ${hasTwoThoughts ? `with ${twoThoughts.length} suggestions` : 'with feedback (no structured thoughts)'}`);
  } else {
    try {
      const { rows: [clientRow] } = await pool.query(
        `SELECT auto_approve_threshold FROM clients WHERE id = $1 LIMIT 1`,
        [clientId]
      );
      const threshold = clientRow?.auto_approve_threshold;
      if (threshold !== null && threshold !== undefined && rangerScore >= threshold) {
        // 2026-05-13: q2-plan.md auto-approve contract gates. Fail-safe — any
        // gate that errors falls through to manual approval.
        let gatesPass = true;
        gateFailReason = null;

        // Gate 1: AUTO_APPROVE_ENABLED env (Railway kill-switch).
        if (process.env.AUTO_APPROVE_ENABLED === 'false') {
          gatesPass = false;
          gateFailReason = 'AUTO_APPROVE_ENABLED=false (Railway kill-switch)';
        }

        // Gate 2: client onboarded >7 days ago (fresh tenants get MJ's eye only).
        if (gatesPass) {
          try {
            const { rows: [ageRow] } = await pool.query(
              `SELECT (NOW() - created_at) > INTERVAL '7 days' AS is_seasoned FROM clients WHERE id = $1`,
              [clientId]
            );
            if (!ageRow?.is_seasoned) {
              gatesPass = false;
              gateFailReason = 'client onboarded <7 days ago';
            }
          } catch (err) {
            console.warn('[pipeline.approve] onboarding-gate query failed (defaulting to manual):', err.message);
            gatesPass = false;
            gateFailReason = 'onboarding-gate query error';
          }
        }

        // Gate 3: no 'sent' message to this lead in last 30 days.
        if (gatesPass) {
          try {
            const { rows: [dupRow] } = await pool.query(
              `SELECT COUNT(*)::int AS recent FROM messages
                WHERE client_id = $1 AND lead_id = $2 AND id <> $3
                  AND status = 'sent'
                  AND sent_at IS NOT NULL AND sent_at > NOW() - INTERVAL '30 days'`,
              [clientId, lead.id, msg.id]
            );
            if (dupRow.recent > 0) {
              gatesPass = false;
              gateFailReason = `lead messaged within 30 days (${dupRow.recent} recent send(s))`;
            }
          } catch (err) {
            console.warn('[pipeline.approve] 30-day dedup query failed (defaulting to manual):', err.message);
            gatesPass = false;
            gateFailReason = '30-day dedup query error';
          }
        }

        // Gate 4: email auto-send must have a verified/trusted email source.
        // Score alone cannot turn a guessed address into something we can send.
        if (gatesPass && msg.channel === 'email' && !isVerifiedEmailReadyLead(lead)) {
          gatesPass = false;
          gateFailReason = 'email source is not verified or trusted';
        }

        if (gatesPass) {
          autoApproved = true;
          if (msg.channel === 'email') {
            nextMessageStatus = 'pending_send';
            approvalStatus = 'approved';
            resolvedAt = new Date();
          } else {
            // LinkedIn auto-approved → route to the Awaiting-Accept queue for
            // manual send. Previously landed at status='approved' with no
            // 'linkedin_requested' marker, so it was invisible in the LinkedIn
            // send tab (the approvals surfacing query needs notes + status to
            // both be 'linkedin_requested'). Mirrors the auto_approval LinkedIn
            // pattern in index.js / autonomous.js / followupSequence.js.
            nextMessageStatus = 'linkedin_requested';
            approvalStatus = 'pending';
            resolvedAt = null;
          }
          console.log(`[pipeline.approve] AUTO-APPROVED ${msg.id}: score ${rangerScore} >= threshold ${threshold} (channel=${msg.channel}, next=${nextMessageStatus})`);
        } else {
          console.log(`[pipeline.approve] AUTO-APPROVE BLOCKED ${msg.id}: score ${rangerScore} >= threshold ${threshold} but gate failed — ${gateFailReason} — routing to pending_approval`);
        }
      }
    } catch (err) {
      console.warn('[pipeline.approve] Failed to read auto_approve_threshold, defaulting to manual:', err.message);
    }
  }

  // ranger_notes — two thoughts visible for borderline drafts
  let rangerNotes;
  if (isBorderline && hasTwoThoughts) {
    const thoughtLines = twoThoughts.map((t, i) =>
      `${i + 1}. ${t.thought}: "${t.current_phrase}" → "${t.suggested_phrase}"`
    ).join('\n');
    rangerNotes = `Borderline (${rangerScore}/100) — two suggestions:\n${thoughtLines}`;
  } else if (isBorderline) {
    rangerNotes = `Borderline (${rangerScore}/100) — ${rangerResult?.notes || rangerResult?.feedback || 'Review recommended'}`;
  } else if (autoApproved) {
    rangerNotes = `Auto-approved (score ${rangerScore})`;
  } else {
    rangerNotes = rangerResult?.notes || 'Enforcer approved';
  }

  const rangerBreakdown = rangerResult?.breakdown || null;
  const suggestionsPayload = isBorderline
    ? (hasTwoThoughts
        ? twoThoughts
        : [{ thought: rangerResult?.notes || rangerResult?.feedback || 'Review recommended', current_phrase: '', suggested_phrase: '' }])
    : null;

  // Persist — always writes subject + ranger_breakdown, client-scoped WHERE.
  if (isBorderline) {
    await pool.query(
      `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
       ranger_breakdown = $5, status = $6,
       metadata = jsonb_set(jsonb_set(COALESCE(metadata, '{}'), '{borderline}', 'true'), '{enforcer_suggestions}', $7::jsonb),
       updated_at = NOW() WHERE id = $8 AND client_id = $9`,
      [finalBody, subject ?? null, rangerScore, rangerNotes,
       JSON.stringify(rangerBreakdown), nextMessageStatus,
       JSON.stringify(suggestionsPayload), msg.id, clientId]
    );
  } else {
    await pool.query(
      `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
       ranger_breakdown = $5, status = $6, updated_at = NOW() WHERE id = $7 AND client_id = $8`,
      [finalBody, subject ?? null, rangerScore, rangerNotes,
       JSON.stringify(rangerBreakdown), nextMessageStatus, msg.id, clientId]
    );
  }

  // Provenance labels preserved per source so existing analytics don't shift.
  const requestedBy = isBorderline
    ? 'enforcer_borderline'
    : (autoApproved ? 'auto_approval' : (source === 'signal_pipeline' ? 'signal_hunt' : 'system'));
  // LinkedIn auto-approvals carry the 'linkedin_requested' note so the
  // Awaiting-Accept tab surfaces them (query matches notes + message status).
  const approvalNotes = (autoApproved && msg.channel !== 'email') ? 'linkedin_requested' : null;
  await pool.query(
    `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [clientId, msg.id, requestedBy, approvalStatus, resolvedAt, approvalNotes]
  );

  const auditMethod = autoApproved ? 'auto_threshold' : (source === 'signal_pipeline' ? 'signal_hunt' : 'enforcer');
  pool.query(
    `INSERT INTO approval_audit (client_id, message_id, lead_id, decision, score, reasons, model, channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [clientId, msg.id, lead.id,
     isBorderline ? 'borderline_surfaced' : (autoApproved ? 'auto_approved' : 'manual_pending'),
     rangerScore,
     JSON.stringify({ method: auditMethod, borderline: isBorderline, gate_fail: gateFailReason || null }),
     process.env.MODEL_SONNET || 'claude-sonnet-4-20250514',
     msg.channel]
  ).catch(err => console.warn('[pipeline.approve] approval_audit write failed:', err.message));

  // If auto-approved, push to send queue. enqueueMessage's channel guard skips
  // LinkedIn / Instagram automatically (those need a manual founder send).
  if (autoApproved) {
    try {
      const { enqueueMessage } = require('./sendQueueWorker');
      const enqResult = await enqueueMessage(clientId, msg.id);
      if (enqResult?.enqueued) {
        console.log(`[pipeline.approve] Auto-approved ${msg.id} → enqueued for send`);
      }
    } catch (err) {
      console.warn(`[pipeline.approve] enqueueMessage failed for ${msg.id}:`, err.message);
    }
  }

  // pipeline_traces — always emit (the kickoff copy previously traced borderline only).
  pipelineTrace.traceStage(clientId, {
    lead_id: lead.id,
    message_id: msg.id,
    kickoff_id: kickoffId || null,
    stage: isBorderline ? 'reviewed' : 'approved',
    status: isBorderline ? 'borderline_surfaced' : (autoApproved ? 'auto_threshold' : 'pipeline_approved'),
    agent: 'enforcer_beaver',
    score: rangerScore,
    pipeline_path: pipelinePath,
    metadata: { channel: msg.channel, next_status: nextMessageStatus, borderline: isBorderline },
  }).catch(() => {});

  await logsService.createLog(clientId, {
    agent: 'enforcer_beaver',
    action: isBorderline ? 'message_borderline_surfaced' : (autoApproved ? 'message_auto_approved' : 'message_approved'),
    target_type: 'message',
    target_id: msg.id,
    metadata: {
      channel: msg.channel, score: rangerScore,
      method: isBorderline ? 'borderline_two_thoughts' : (autoApproved ? 'auto_threshold' : 'pipeline_approved'),
      borderline: isBorderline,
      thoughts: isBorderline ? twoThoughts : undefined,
    },
  }).catch(() => {});

  return { autoApproved, isBorderline, rangerScore, nextMessageStatus };
}

module.exports = {
  isV2Enabled,
  processLead,           // Step 7 — currently throws
  persistDraft,          // Step 1 — concrete
  checkActiveMessage,    // Step 1 — concrete
  enrichEmail,           // Step 3 — concrete (Hunter + optional VP)
  draftWithFallback,     // Step 3 - concrete (Sales Beaver + optional Captain fallback)
  recordRepairRoute,     // Phase 4 — concrete (repair route traces/logs)
  icpGateSoftDelete,     // Step 4 — concrete (applyIcpV2Filter + soft-delete + audit + trace)
  leadReadinessGate,     // Phase 3 pivot — concrete (pre-draft data-integrity check)
  applyEnforcerDecision, // Step 6 — concrete (auto-approve / borderline / manual + persistence)

  // Constants for callers (e.g. acceptance tests)
  PIPELINE_V2_ENABLED,
};
