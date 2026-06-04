'use strict';

// ─── Sprint 9: Agent Intelligence Upgrade ─────────────────────
// Memory injection added: cross-agent reads, mistake logging.
// Last updated: 2026-04-03

const { v4: uuidv4 } = require('uuid');
const logsService = require('./logs');
const pipelineTrace = require('./pipelineTrace');
const pipeline = require('./pipeline');
const pool = require('../db/pool');
const apolloService = require('./apollo');
const hunterService = require('./hunter');
const researchModule = require('./research');
const { getClientConfig, buildClientContext } = require('./clientConfig');
const { evaluateLeadQuality } = require('../utils/leadQuality');
const { recordOutcome, attributionFromLead } = require('./outcomeTracker');
const { LEAD_SELECTION_REJECTION_SQL, leadSelectionFeedbackExclusionSql } = require('./founderFeedbackSignals');
const { checkBudget, BudgetExceededError, isBudgetExceededError } = require('./budget');
const repairPolicy = require('./repairPolicy');
const { todayInMalaysia } = require('../utils/businessDay');
const { parseRequestedLeadCount } = require('../utils/requestedLeadCount');

// Channel-specific drafting instructions injected into the Sales Beaver prompt.
// Module scope (2026-05-16, Jules F-03): was a local const inside
// processLeadPipeline only — so the signal pipeline drafted with no channel
// instructions and produced lower-quality drafts for the best leads. Both
// pipeline paths now reference this single definition.
const CHANNEL_HINTS = {
  email: 'Write a cold email following the MANDATORY DAY 0 TEMPLATE exactly. Must have: subject line "{company_name} x {lead_company}", "Hi {first_name}," greeting, congratulation/hook paragraph, pain bridge paragraph, one question. Do NOT write your own sign-off — end the body at the question; the system appends the "Regards," / sender-name close deterministically. Under 80 words body.',
  linkedin: 'Write a SHORT LinkedIn DM (NOT an email). Exactly 3 lines, under 50 words total. No subject line. Start line 1 with "Hi {first_name}, saw you {specific signal}." Line 2 is short outbound context. Line 3 is one diagnostic question. No sign-off (no "Regards,", no name at end). End on the question.',
  instagram: 'Write a casual Instagram DM. 1-2 sentences, under 30 words. No greeting, no sign-off. Reference something about their company. End with a casual question. Most informal channel.',
};

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

// ICP+channel patches per MJ direction 2026-04-29
// ─── ICP v2: Beaver Solutions tenant — MY+SG+US, sales/BD/revenue persona ───
// 2026-05-28: locked to current tenant ICP geography. Do not use stale MY/SG-only
// logic, and do not admit AU/UK unless the tenant ICP is deliberately expanded.
// - Persona: sales/BD/revenue/commercial only. Marketing/growth/brand/comms/
//   partnerships/operations REMOVED — BeavrDam's buyer is the head of OUTBOUND
//   (CRO / Head of Sales / VP BD / Founder doing outbound at SMB level), not
//   the marketing team. Marketing-leaning ICP is Emplifive's territory, not ours.
// - CMO removed from standalone — was a Beaver-irrelevant exception slipping leads.
// When Emplifive onboards as a BeavrDam tenant, these constants split per-tenant.
const ICP_ALLOWED_COUNTRIES = new Set([
  'malaysia','singapore',
  'my','sg',
  'united states',
  'us','usa',
]);

// 2026-05-23: explicit deny list — fires BEFORE the allow check. Defensive
// against paths that bypass agent_memory.icp.geographies (e.g. Director Chat
// where user-typed prompts can surface out-of-ICP leads). MJ flagged that
// India recommendations were leaking through. Even with India absent from
// the allow set, an explicit deny gives a clear rejection reason in logs.
const ICP_DENIED_COUNTRIES = new Set([
  'india','in','bharat','भारत',
]);

// Senior decision-maker titles. If any matches standalone, lead passes title gate.
// Founder/Co-founder/CEO/MD/CRO/COO/CFO/CTO/President/Owner/Principal/Managing Partner
// stand alone. Director/Head/VP/GM/Chief must combine with a sales/BD/revenue function
// (handled in applyIcpV2Filter — these regexes are component-level).
//
// 2026-05-14: REMOVED 'cmo' from standalone (marketing is not Beaver's buyer).
//   Added 'cro' explicitly (Chief Revenue Officer — primary Beaver buyer).
const ICP_SENIOR_STANDALONE = /\b(founder|co-?founder|ceo|chief executive|\bcro\b|chief revenue|coo|cfo|cto|managing director|managing partner|president|owner|principal|proprietor|\bmd\b|chairman|chairwoman)\b/i;
const ICP_SENIOR_LEADER = /\b(director|head\s+of|vp|vice\s+president|general\s+manager|\bgm\b|chief)\b/i;
// 2026-05-14: function narrowed to sales/BD/revenue/commercial.
// REMOVED: growth, marketing, brand, partnerships, operations, comms, communications, client services.
const ICP_SENIOR_FUNCTION = /\b(sales|business\s+development|\bbd\b|revenue|commercial|outbound)\b/i;

// Junior IC / sub-decision-maker titles. If any matches AND no senior-standalone, reject.
const ICP_JUNIOR_TITLE = /\b(intern|trainee|junior|associate|assistant|coordinator|specialist|analyst|officer|admin|receptionist|clerk|engineer|developer|designer|writer|editor|representative|agent\b|strategist)\b/i;

// "Executive" / "Manager" / "Lead" / "Consultant" — junior unless preceded by Senior/Head/Chief.
// Standalone "BD Executive", "Senior Digital Marketing Executive" → junior IC.
const ICP_JUNIOR_QUALIFIED = /\b(executive|manager|lead|consultant)\b/i;
const ICP_SENIOR_QUALIFIER = /\b(senior|head|chief|principal|lead\s+(of|the)|managing|global|regional)\b/i;

// Companies that must be hard-rejected even if title looks senior — too big to sell to,
// or not buyers (industry bodies, universities, government).
//
// 2026-05-06 update: expanded MNC blocklist after pool audit found dentsu Malaysia,
// IPG Mediabrands, Leo Burnett, GroupM, AirAsia subsidiaries leaking through. Added
// the WPP / IPG / Publicis / Dentsu / Omnicom network sub-brands and MY-listed MNCs.
// 2026-05-14: added phd (Omnicom-owned media agency, "PHD Malaysia" leak),
// vistage (CEO peer-group franchise), manning gottlieb omd, mediavest, possible
// other Omnicom/IPG/Publicis subsidiaries seen in pool. Geographic suffix
// stripping in hunter.domainsFromCompany now means "PHD Malaysia" → "phd" stem,
// and this regex matches \bphd\b in the raw company string too.
const ICP_LARGE_GLOBAL_AGENCIES = /\b(wpp|publicis|omnicom|interpublic|\bipg\b|ipg\s+mediabrands|mediabrands|\bbbdo\b|ogilvy|mccann|\bvml\b|dentsu|dentsu\s+creative|carat|iprospect|isobar|havas|grey\s+group|leo\s+burnett|saatchi|\bddb\b|tbwa|\bjwt\b|wunderman|edelman|\bweber\b|burson|fleishman|hill\+knowlton|groupm|mindshare|wavemaker|mediacom|essence|\bmsl\b|spark\s+foundry|zenith|starcom|digitas|\bmrm\b|\binitiative\b|\bub\b|ipg\s+health|huge|r\/ga|akqa|\bsid\s+lee\b|phd\s+media|phd\s+malaysia|phd\s+singapore|manning\s+gottlieb|mediavest|vistage)\b/i;
const ICP_ENTERPRISE_BRANDS = /\b(deloitte|mckinsey|\bpwc\b|\bkpmg\b|\bey\b|accenture|boston\s+consulting|\bbain\b|shell|petronas|tenaga|maybank|\bcimb\b|\brhb\b|public\s+bank|hong\s+leong|sime\s+darby|axiata|celcomdigi|celcom|\bdigi\b|\bmaxis\b|\bastro\b|airasia|air\s+asia|grab|sea\s+limited|shopee|lazada|capitaland|ihh\s+healthcare|\biskandar\b|unilever|nestle|nestlé|procter|p&g|samsung|\blg\b|sony|panasonic|google|\bmeta\b|amazon|microsoft|apple|\bibm\b|huawei|xiaomi|canon|honda|toyota|mastercard|visa\b)\b/i;
const ICP_INDUSTRY_BODIES = /\b(women\s+in\s+pr|female\s+founders|chamber\s+of|chambers\s+of|association|trade\s+union|alliance|federation|society\s+of|members?'?\s*(network|club|association)|institute\s+of|board\s+of|council\s+of)\b/i;
// 2026-05-06: removed `training\s+(institute|provider|academy)` from this regex.
// Per MJ direction (Captain ICP update), B2B corporate/professional training providers
// are now the PRIMARY ICP. Rejecting them here was fighting the new ICP. Universities,
// colleges, polytechnics and schools (academic) remain rejected.
const ICP_GOV_NGO_EDU = /\b(ministry|jabatan|kementerian|government|\bpolis\b|police|army|military|ngo|non[\s-]?profit|charity|foundation|university|universiti|college|polytechnic|sekolah|school|\buitm\b|\bukm\b)\b/i;
const ICP_FREELANCE = /\b(freelance|freelancer|self[\s-]?employed|independent(\s+consultant)?|solo(\s+consultant)?|individual)\b/i;

// Per-tenant sender identity. If client_id is missing, fallback to 'The Team'.
// Beaver Solutions tenant — MJ direction 2026-04-29: hardcode "Michael Jerry".
const ICP_SENDER_IDENTITY = {
  'ce2fc8e5-617e-42d5-91fe-4275ceaa0030': 'Michael Jerry',
};

// Strip any LLM-generated sign-off block from a body. Catches patterns like
// "Regards,\nName", "Best,\nName", "Cheers,\nName", and anything trailing after them.
// 2026-05-06: expanded to catch "Talk soon", "Speak soon", "Looking forward",
// "All the best", "Yours" — LLM variants that bypassed the original regex.
const SIGNOFF_STRIP_REGEX = /\n*\s*(regards|best(\s+regards)?|cheers|kind\s+regards|sincerely|warm\s+regards|thanks|thank\s+you|talk\s+soon|speak\s+soon|looking\s+forward(\s+to[\s\S]{0,40}?)?|chat\s+soon|all\s+the\s+best|yours(\s+truly|\s+sincerely)?|see\s+you\s+soon)[,!.\s]*[\r\n]+[\s\S]*$/i;

// Strips agent-name signatures the LLM appends WITHOUT a standard sign-off word.
// Failure modes seen in production (logged 2026-05-01 + 2026-05-05):
//   "—Bryan Beaver" / "Bryan Beaver" / "Enforcer Beaver" / "Sales Beaver"
//   "Baver Solutions" / "Beaver Solutions" / "The Beaver Team" / "The Team at Beaver"
// These typically appear as the final 1-2 lines after the message body.
// Anchored to end-of-string so a real recipient name isn't accidentally stripped.
const AGENT_NAME_STRIP_REGEX = /\n+\s*[—–-]*\s*(bryan(\s+beaver)?|enforcer(\s+beaver)?|sales(\s+beaver)?|captain(\s+beaver)?|ranger(\s+beaver)?|director(\s+beaver)?|research(\s+beaver)?|the\s+beaver(\s+(team|crew|solutions))?|the\s+team\s+at\s+beaver(\s+solutions)?|baver\s+solutions|beaver\s+solutions|the\s+beavrdam(\s+team)?|bobby(\s+beaver)?|bitton)[\s.!]*$/i;

/**
 * Resolve sender identity for a given client. Hardcoded map first, then persona,
 * then fallback. Pulled OUT of the LLM path so the LLM cannot hallucinate a name.
 */
function resolveSenderName(clientId, persona) {
  if (clientId && ICP_SENDER_IDENTITY[clientId]) return ICP_SENDER_IDENTITY[clientId];
  return persona?.sender_name || persona?.contact_name || persona?.name || 'The Team';
}

/**
 * ICP v2 hard filter. Runs AFTER existing geo/industry/corp gate.
 * Returns { pass: true } or { pass: false, status: 'rejected_*', reason: '...' }.
 *
 * Acceptance order: data integrity → country → vertical → persona/title → score.
 * Each gate emits a distinct status for validation queries.
 */
function applyIcpV2Filter(lead) {
  const allText = [lead.name || '', lead.company || '', lead.title || '', lead.snippet || '', lead.location || ''].join(' ');
  const company = (lead.company || '').trim();
  const name = (lead.name || '').trim();
  const title = (lead.title || '').trim();

  // Gate 0: Data integrity — lead name must not equal company name.
  if (name && company && name.toLowerCase() === company.toLowerCase()) {
    return { pass: false, status: 'rejected_data_integrity', reason: 'lead name equals company name' };
  }
  if (!name || name.toLowerCase().includes('unknown')) {
    return { pass: false, status: 'rejected_data_integrity', reason: 'missing or unknown lead name' };
  }

  // Gate 1: Country. Must be SEA-6. NULL is treated as unresolved (rejected_unresolved_country).
  // Country may live on lead.country (preferred) or be derived from Haiku verification metadata.
  const rawCountry = (lead.country
    || lead.metadata?.country
    || lead.verification?.haikuResult?.country
    || lead.verification?.country
    || ''
  ).trim().toLowerCase();

  if (!rawCountry) {
    return { pass: false, status: 'rejected_unresolved_country', reason: 'country could not be resolved from LinkedIn / company website' };
  }
  // 2026-05-23: explicit deny check fires before the allow check.
  if (ICP_DENIED_COUNTRIES.has(rawCountry)) {
    return { pass: false, status: 'rejected_country', reason: `country "${rawCountry}" is explicitly excluded from ICP` };
  }
  if (!ICP_ALLOWED_COUNTRIES.has(rawCountry)) {
    return { pass: false, status: 'rejected_country', reason: `country "${rawCountry}" is outside target ICP geographies` };
  }

  // Gate 2: Vertical / company shape exclusions.
  if (ICP_INDUSTRY_BODIES.test(allText)) {
    return { pass: false, status: 'rejected_vertical', reason: 'industry body / association / chamber' };
  }
  if (ICP_GOV_NGO_EDU.test(allText)) {
    return { pass: false, status: 'rejected_vertical', reason: 'government / NGO / academic / training provider' };
  }
  if (ICP_FREELANCE.test(allText)) {
    return { pass: false, status: 'rejected_vertical', reason: 'freelance / solo / independent operator' };
  }
  if (ICP_LARGE_GLOBAL_AGENCIES.test(allText) || ICP_ENTERPRISE_BRANDS.test(allText)) {
    return { pass: false, status: 'rejected_size', reason: 'global agency / enterprise brand — outside 5-50 sweet spot' };
  }

  // Gate 3: Persona / title. Senior standalone passes immediately. Senior leader (Director/Head/VP/GM/Chief)
  // passes only when combined with a sales-adjacent function. Junior IC titles reject.
  const titleLower = title.toLowerCase();
  const hasSeniorStandalone = ICP_SENIOR_STANDALONE.test(titleLower);
  const hasSeniorLeader = ICP_SENIOR_LEADER.test(titleLower);
  const hasSeniorFunction = ICP_SENIOR_FUNCTION.test(titleLower);
  const hasJuniorWord = ICP_JUNIOR_TITLE.test(titleLower);
  const hasQualifiedJunior = ICP_JUNIOR_QUALIFIED.test(titleLower);
  const hasSeniorQualifier = ICP_SENIOR_QUALIFIER.test(titleLower);

  // Senior standalone always passes.
  if (hasSeniorStandalone) {
    // fall through to score gate
  } else if (hasSeniorLeader && hasSeniorFunction) {
    // fall through — Director of Sales, Head of Marketing, VP of BD all pass
  } else if (hasJuniorWord) {
    return { pass: false, status: 'rejected_persona', reason: `junior IC title: "${title}"` };
  } else if (hasQualifiedJunior && !hasSeniorQualifier) {
    return { pass: false, status: 'rejected_persona', reason: `unqualified mid-IC title: "${title}"` };
  } else if (!title) {
    return { pass: false, status: 'rejected_persona', reason: 'no title present' };
  } else {
    // Title doesn't clearly match either bucket — reject conservatively.
    return { pass: false, status: 'rejected_persona', reason: `title "${title}" does not match decision-maker criteria` };
  }

  // Gate 4: Score threshold. <65 rejects entirely. P-tier resolved on insert side.
  const score = Number(lead.score || 0);
  if (score > 0 && score < 65) {
    return { pass: false, status: 'rejected_low_score', reason: `score ${score} below 65 threshold` };
  }

  return { pass: true };
}

/**
 * Resolve signal_tier from score + verification state per MJ 2026-04-29:
 *   P1 = score >=85 AND email_verified
 *   P2 = 75-84
 *   P3 = 65-74
 *   <65 already rejected by applyIcpV2Filter.
 */
function resolveSignalTier(lead) {
  const score = Number(lead.score || 0);
  const verified = lead.email_verified === true
    || lead.email_source === 'hunter';
  if (score >= 85 && verified) return 'P1';
  if (score >= 75) return 'P2';
  if (score >= 65) return 'P3';
  return null;
}

/**
 * Single source of truth for channel-routing decisions at draft time.
 * Replaces the duplicated logic that lived at processExistingLeadsPipeline
 * (~line 1537) and processLeadPipeline (~line 2606). Both sites now call
 * this helper. Behavior locked per MJ direction 2026-04-29 + 2026-05-06:
 *   - Verified email present → email-first (touch 1)
 *   - linkedin_first_override metadata flag → LinkedIn at touch 1 (per-lead manual override)
 *   - lead_tier='B' (linkedin-only pool: linkedin_url present, no verified email)
 *     → LinkedIn at touch 1 (this is the channel-mix policy 30 email + 20 linkedin/day)
 *   - Neither email nor linkedin_url → blocked_no_email (HOLD for enrichment)
 *
 * Touch 3+ escalation (email → LinkedIn after FU2 with no reply) is handled
 * separately in followupSequence.escalateChannel() and is not in this helper.
 * The touch-3 rule is FOLLOW-UP logic for emailed leads with no reply, NOT the
 * gate for new linkedin-only leads.
 *
 * @param {object} lead — must have email, email_verified, email_source, linkedin_url, metadata
 * @param {object} options
 * @param {boolean} [options.linkedinAlreadyTried=false] — set when caller has
 *   evidence (DB query) that LinkedIn was already attempted on this lead
 * @returns {{channel: 'email'|'linkedin', status: 'pending_ranger'|'blocked_no_email', reason: string}}
 */
function selectChannel(lead, options = {}) {
  const { linkedinAlreadyTried = false } = options;
  const meta = lead.metadata || {};
  const linkedinFirstOverride = meta.linkedin_first_override === true || meta.linkedin_first_override === 'true';
  const hasVerifiedEmail = lead.email
    && (lead.email_verified === true || lead.email_source === 'hunter');
  const isLinkedinOnlyLead = lead.lead_tier === 'B' && lead.linkedin_url;

  if (linkedinFirstOverride && lead.linkedin_url && !linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'pending_ranger', reason: 'linkedin_first_override metadata flag set' };
  }
  if (hasVerifiedEmail) {
    return { channel: 'email', status: 'pending_ranger', reason: `Verified email (${lead.email_source || 'known'})` };
  }
  if (lead.linkedin_url && linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'channel_exhausted', reason: 'LinkedIn already tried and no verified email found' };
  }
  if (isLinkedinOnlyLead && !linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'pending_ranger', reason: 'Tier B linkedin-only lead' };
  }
  // 2026-05-14 (Mismatch 3 fix): graceful LinkedIn fallback for any lead with a
  // valid linkedin_url but no verified email AND not yet tagged tier B.
  // Previously these fell through to blocked_no_email — capping today's autonomous
  // pipeline at 1 of 8 leads producing a draft (7/8 blocked). The hero-film
  // contract (BEAVER-FLOWCHARTS.md) says no-email + has-linkedin → LinkedIn drafting.
  if (lead.linkedin_url && !linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'pending_ranger', reason: 'No verified email — LinkedIn fallback (lead has linkedin_url)' };
  }
  return {
    channel: 'email',
    status: 'blocked_no_email',
    reason: 'No verified email and no usable linkedin_url — holding for enrichment',
  };
}

let callAgent;

try {
  callAgent = require('./claude').callAgent;
  console.log('[agents] Claude loaded successfully');
} catch (err) {
  console.warn('[agents] Failed to load claude service:', err.message);
}

/**
 * =========================
 * MEMORY HELPERS (Sprint 9)
 * =========================
 */

/** Read a single agent_memory entry. Returns content or null. */
async function getMemory(clientId, agent, key) {
  try {
    const res = await pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = $2 AND key = $3 LIMIT 1`,
      [clientId, agent, key]
    );
    return res.rows[0]?.content || null;
  } catch {
    return null;
  }
}

/**
 * Log an agent mistake to agent_memory for future runs to learn from.
 * Keeps the last 20 entries per agent.
 */
async function logMistake(clientId, agent, mistake, cause, newRule) {
  try {
    const existing = await pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = $2 AND key = 'mistakes' LIMIT 1`,
      [clientId, agent]
    );
    const entry = { mistake, cause, new_rule: newRule, ts: new Date().toISOString() };
    let mistakes = [];
    if (existing.rows.length > 0) {
      const prev = existing.rows[0].content;
      mistakes = Array.isArray(prev) ? prev : [];
    }
    mistakes.unshift(entry);
    mistakes = mistakes.slice(0, 20); // cap at 20 entries

    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
       VALUES ($1, $2, 'mistakes', 'mistakes', $3)
       ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $3, updated_at = NOW()`,
      [clientId, agent, JSON.stringify(mistakes)]
    );
  } catch (err) {
    console.warn(`[memory] Failed to log mistake for ${agent}:`, err.message);
  }
}

/**
 * =========================
 * EXEC STATUS HELPER
 * =========================
 * Writes intermediate pipeline state to agent_memory so the frontend
 * can show live beaver status via the poll endpoint.
 * key: exec_${plan_id}, type: 'config'
 */
async function updateExecStatus(clientId, planId, statusObj) {
  try {
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'director', $2, $3::jsonb, 'config', NOW())
       ON CONFLICT (client_id, agent, key)
       DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
      [clientId, `exec_${planId}`, JSON.stringify(statusObj)]
    );
  } catch (err) {
    console.warn('[pipeline] updateExecStatus failed:', err.message);
  }
}

/**
 * Pull the last 10 Ranger rejection reasons from the messages table.
 * Used to brief Sales Beaver on patterns to avoid.
 */
async function getRangerRejectionPatterns(clientId) {
  try {
    const res = await pool.query(
      `SELECT ranger_notes FROM messages
       WHERE client_id = $1 AND status = 'ranger_rejected' AND ranger_notes IS NOT NULL
       ORDER BY created_at DESC LIMIT 10`,
      [clientId]
    );
    if (res.rows.length === 0) return null;
    return res.rows.map(r => r.ranger_notes).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * A8-6: Pull the Enforcer's latest weekly teaching note. runEnforcerTeaching
 * writes one to agent_memory (agent='ranger', key=enforcer_teaching_<week>)
 * every Sunday, but nothing ever consumed it — the "sharpen the clone" loop was
 * dead. Sales Beaver now folds the most recent note into its draft prompt.
 * Returns the plain-text note, or null if none / skipped / LLM-failed.
 */
async function getEnforcerTeachingNote(clientId) {
  try {
    const res = await pool.query(
      `SELECT content FROM agent_memory
       WHERE client_id = $1 AND agent = 'ranger' AND key LIKE 'enforcer_teaching_%'
       ORDER BY updated_at DESC LIMIT 1`,
      [clientId]
    );
    const content = res.rows[0]?.content;
    if (!content) return null;
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return (parsed?.status === 'ok' && parsed?.teaching_note) ? parsed.teaching_note : null;
  } catch {
    return null;
  }
}

/**
 * Fix 6: Pull recent founder feedback (edits + rejections) from founder_feedback table.
 * Returns formatted few-shot examples showing how the founder corrects drafts.
 * Sales Beaver uses these to calibrate tone, length, and style.
 */
async function getFounderFeedback(clientId) {
  try {
    const res = await pool.query(
      `SELECT feedback_type, original_body, edited_body, rejection_reason, channel, lead_context
       FROM founder_feedback
       WHERE client_id = $1
       ORDER BY created_at DESC LIMIT 30`,
      [clientId]
    );
    if (res.rows.length === 0) return null;

    const examples = [];

    // Edit-class feedback — the founder rewrote the draft. Covers plain edits,
    // borderline apply/edit actions, and edits made at manual-send time. All of
    // these carry an edited_body, so show the before/after diff.
    const EDIT_TYPES = ['edit', 'borderline_edit_apply', 'borderline_apply_suggestion',
                        'manual_ui_send_edit', 'manual_chrome_send_edit'];
    const edits = res.rows.filter(r => EDIT_TYPES.includes(r.feedback_type) && r.edited_body);
    for (const edit of edits.slice(0, 5)) {
      const ctx = edit.lead_context || {};
      examples.push(
        `[EDIT EXAMPLE — ${edit.channel}] Lead: ${ctx.name || 'Unknown'} at ${ctx.company || 'Unknown'}` +
        `\nOriginal draft:\n${edit.original_body}` +
        `\nFounder's corrected version:\n${edit.edited_body}`
      );
    }

    // Rejection-class feedback — the founder killed the draft. Covers plain
    // rejections and borderline skips.
    const REJECT_TYPES = ['rejection', 'borderline_skip'];
    const rejections = res.rows.filter(r => REJECT_TYPES.includes(r.feedback_type) && r.rejection_reason);
    for (const rej of rejections.slice(0, 5)) {
      const ctx = rej.lead_context || {};
      examples.push(
        `[REJECTED — ${rej.channel}] Lead: ${ctx.name || 'Unknown'} at ${ctx.company || 'Unknown'}` +
        `\nRejected draft:\n${rej.original_body}` +
        `\nReason: ${rej.rejection_reason}`
      );
    }

    // Founder notes — an explicit "teach the beaver" instruction left on a draft
    // via the founder-note affordance. The note text rides in rejection_reason.
    const notes = res.rows.filter(r => r.feedback_type === 'founder_note' && r.rejection_reason);
    for (const note of notes.slice(0, 5)) {
      const ctx = note.lead_context || {};
      examples.push(
        `[FOUNDER NOTE — ${note.channel}] Lead: ${ctx.name || 'Unknown'} at ${ctx.company || 'Unknown'}` +
        `\nDraft the note refers to:\n${note.original_body}` +
        `\nFounder's instruction — follow this: ${note.rejection_reason}`
      );
    }

    return examples.length > 0 ? examples : null;
  } catch {
    return null;
  }
}

/**
 * Build a shared memory brief for the Director to inject at kickoff.
 * Reads ICP, weekly learnings, recent Ranger rejections, and past agent mistakes.
 */
async function buildDirectorMemoryBrief(clientId) {
  try {
    const [icp, weeklyLearnings, rangerPatterns, salesMistakes, researchMistakes, leadSelectionDirectives] = await Promise.all([
      getMemory(clientId, 'director', 'icp'),
      getMemory(clientId, 'director', 'weekly_learnings'),
      getRangerRejectionPatterns(clientId),
      getMemory(clientId, 'sales_beaver', 'mistakes'),
      getMemory(clientId, 'research_beaver', 'mistakes'),
      getFounderLeadSelectionDirectives(clientId),
    ]);

    const parts = [];
    if (icp && Object.keys(icp).length > 0) {
      parts.push(`ICP: ${JSON.stringify(icp)}`);
    }
    if (weeklyLearnings) {
      parts.push(`Weekly learnings (apply these): ${JSON.stringify(weeklyLearnings)}`);
    }
    if (rangerPatterns?.length) {
      parts.push(`Recent Ranger rejections — avoid these patterns:\n${rangerPatterns.slice(0, 5).join('\n')}`);
    }
    if (Array.isArray(salesMistakes) && salesMistakes.length > 0) {
      parts.push(`Sales Beaver past mistakes: ${JSON.stringify(salesMistakes.slice(0, 3))}`);
    }
    if (Array.isArray(researchMistakes) && researchMistakes.length > 0) {
      parts.push(`Research Beaver past mistakes: ${JSON.stringify(researchMistakes.slice(0, 3))}`);
    }
    if (leadSelectionDirectives) {
      parts.push(`Founder lead-selection feedback (Research/Captain must obey; do not select similar off-ICP leads):\n${leadSelectionDirectives}`);
    }

    return parts.length > 0 ? `\n\nSHARED MEMORY BRIEF (read before acting):\n${parts.join('\n\n')}` : '';
  } catch {
    return '';
  }
}

/**
 * =========================
 * RESEARCH BEAVER
 * =========================
 */
async function researchSearch(clientId, { query, command = null, filters = {} }) {
  const batchIndex = filters.batchIndex || 0;

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'research_search',
    target_type: 'search',
    metadata: {
      query,
      command: command ? String(command).slice(0, 200) : null,
      query_mode: query ? 'explicit_query' : 'icp_memory',
      filters,
      batchIndex,
    },
  });

  // Load ICP memory upfront — used by both search query builder and Claude fallback
  const icpMemory = await getMemory(clientId, 'director', 'icp');

  let researchResult = null;   // hoisted so the no-results diagnostic log can read its stats
  let researchDiagnostics = null;
  let multiError = null;       // captured so the no-results log records WHY, not just THAT

  // Primary: Multi-source research — Brave (people, signal, company) + Hunter domain search
  // Rotates through 300+ query variations so dedup never exhausts the pool
  try {
    console.log(`[research_beaver] Running multi-source research (batch ${batchIndex})`);
    researchResult = await researchModule.researchLeads(clientId, {
      icpMemory,
      targetCount: filters.limit || 5,
      batchIndex,
      maxPaidQueries: filters.maxPaidQueries,
      commandOverride: query, // user's actual command — takes priority over ICP for query building
    });

    const multiLeads = researchResult.leads || [];
    console.log(`[research_beaver] Multi-source returned ${multiLeads.length} leads via ${researchResult.queriesUsed?.length || 0} queries`);

    researchDiagnostics = {
      pool_stats: researchResult.pool_stats || null,
      verification_stats: researchResult.verification_stats || null,
      scoring_stats: researchResult.scoring_stats || null,
      layer1_candidates: researchResult.verification_stats?.candidates ?? null,
      candidates_total: researchResult.verification_stats?.candidates_total ?? null,
      queries_total: researchResult.verification_stats?.queries_total ?? null,
      rounds_ran: researchResult.verification_stats?.rounds_ran ?? null,
      circuit_breaker_tripped: researchResult.verification_stats?.circuit_breaker_tripped ?? null,
      layer2_verified: researchResult.verification_stats?.verified ?? null,
      layer2_rejected: researchResult.verification_stats?.rejected ?? null,
      rejection_summary: researchResult.verification_stats?.rejection_summary ?? null,
      rejection_samples: researchResult.verification_stats?.rejection_samples ?? null,
    };

    if (multiLeads.length > 0) {
      return {
        success: true,
        data: { leads: multiLeads, query: researchResult.queriesUsed?.join(' | ') || query, filters, source: 'multi', diagnostics: researchDiagnostics },
      };
    }

    console.warn('[research_beaver] Multi-source returned 0 leads — trying Apollo fallback');
  } catch (err) {
    multiError = err.message;
    console.warn('[research_beaver] Multi-source research failed, trying Apollo:', err.message);
  }

  // Fallback: Apollo only when explicitly capped on. Default cap is 0 because
  // Apollo is a stale paid path and must not burn quota silently.
  try {
    const apolloLeads = await apolloService.searchPeople(clientId, { query, limit: filters.limit || 5 });
    if (apolloLeads && apolloLeads.length > 0) {
      console.log(`[research_beaver] Apollo fallback returned ${apolloLeads.length} leads`);
      return {
        success: true,
        data: { leads: apolloLeads, query, filters, source: 'apollo' },
      };
    }
  } catch (err) {
    console.warn('[research_beaver] Apollo fallback also unavailable:', err.message);
  }

  // Provider config snapshot — turns a silent "0 results" into a one-query diagnosis.
  // Self-sourcing needs ONE working search provider: Brave (primary), Google CSE
  // (fallback), or Apollo. DuckDuckGo is a crash-guard, not a real source.
  const apolloKey = await apolloService.getApiKey(clientId).catch(() => null);
  const providers = {
    brave:      !!process.env.BRAVE_API_KEY,
    google_cse: !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX),
    apollo:     !!apolloKey && Number(process.env.APOLLO_DAILY_QUERY_CAP || 0) > 0,
  };
  const missingKeys = [];
  if (!providers.brave) missingKeys.push('BRAVE_API_KEY');
  if (!providers.google_cse) missingKeys.push('GOOGLE_CSE_API_KEY/CX');
  const noProviderConfigured = !providers.brave && !providers.google_cse && !providers.apollo;
  const verificationStats = researchResult?.verification_stats || {};
  const candidatesTotal = verificationStats.candidates_total ?? verificationStats.candidates ?? null;
  const noResultsNote = noProviderConfigured
    ? 'No configured research provider is usable'
    : (Number(candidatesTotal) > 0
        ? 'Provider/parser produced candidates, but Research verification rejected all'
        : 'Provider/parser returned 0 usable candidates');
  const likelyCause = noProviderConfigured
    ? 'NO_SEARCH_PROVIDER — Brave, Google CSE, and Apollo all unconfigured'
    : (Number(candidatesTotal) > 0
        ? 'VERIFICATION_REJECTED_ALL — provider/parser produced candidates but Layer 2 rejected every one'
        : 'PROVIDER_OR_PARSER_ZERO — provider returned no usable candidates, parser dropped all items, or query was too narrow');

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'research_no_results',
    target_type: 'system',
    metadata: {
      query: researchResult?.queriesUsed?.[0] || query?.substring?.(0, 200) || '[icp_memory]',
      command: command ? String(command).slice(0, 200) : null,
      queries_preview: researchResult?.queriesUsed?.slice?.(0, 10) || [],
      source: 'multi',
      note: noResultsNote,
      // diagnostics — read these first when self-sourcing yields 0
      providers_configured: providers,
      multi_error: multiError || null,
      // Initial-pass scope (legacy fields — kept for back-compat with prior log readers)
      layer1_candidates: verificationStats.candidates ?? null,
      layer2_verified: verificationStats.verified ?? null,
      layer2_rejected: verificationStats.rejected ?? null,
      queries_run: researchResult?.queriesUsed?.length ?? null,
      pool_exhaustion_pct: researchResult?.pool_stats?.exhaustion_pct ?? null,
      // Full-pipeline scope (2026-05-22 — incoherent-metric fix). The legacy
      // fields above are INITIAL PASS ONLY; these are the TOTAL across the
      // entire retry+expansion ladder. Use these for any "0 leads" diagnosis.
      candidates_total: verificationStats.candidates_total ?? null,
      queries_total: verificationStats.queries_total ?? null,
      rounds_ran: verificationStats.rounds_ran ?? null,
      circuit_breaker_tripped: verificationStats.circuit_breaker_tripped ?? null,
      rejection_summary: verificationStats.rejection_summary ?? null,
      rejection_samples: verificationStats.rejection_samples ?? null,
      likely_cause: likelyCause,
    },
  });
  const keyDiagnostic = missingKeys.length > 0
    ? ` Missing API keys: ${missingKeys.join(', ')}.`
    : ' API keys present — try different ICP keywords or a broader location.';
  return {
    success: true,
    data: {
      leads: [],
      query,
      filters,
      source: 'multi',
      diagnostics: researchDiagnostics,
      note: `No results from any source.${keyDiagnostic}`,
      missing_keys: missingKeys,
    },
  };

  /* ── Claude fallback (DISABLED — fabricates companies) ──────────
   * Kept for potential re-enablement for enrichment (not sourcing).
  if (callAgent) {
    try {
      const weeklyLearnings = await getMemory(clientId, 'director', 'weekly_learnings');
      let memoryContext = '';
      if (icpMemory && Object.keys(icpMemory).length > 0) {
        memoryContext += `\n\nICP TO TARGET:\n${JSON.stringify(icpMemory, null, 2)}`;
      }
      if (weeklyLearnings) {
        memoryContext += `\n\nWEEKLY LEARNINGS (apply these to targeting):\n${JSON.stringify(weeklyLearnings)}`;
      }

      const result = await callAgent(
        'research_beaver',
        `Find companies and people matching this query: "${query}". Return exactly the number of leads requested in the query (default 3 if not specified).${memoryContext}`,
        { query, filters }
      );

      // Handle all possible response shapes
      if (Array.isArray(result)) {
        leads = result;
      } else if (Array.isArray(result?.leads)) {
        leads = result.leads;
      } else if (result?.raw) {
        let raw = result.raw.trim();
        raw = raw.replace(/^```json\s*\/i, '').replace(/^```\s*\/i, '').replace(/```\s*$\/i, '');
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) leads = parsed;
          else if (Array.isArray(parsed?.leads)) leads = parsed.leads;
        } catch {
          const objMatch = raw.match(/\{[\s\S]*\}/);
          const arrMatch = raw.match(/\[[\s\S]*\]/);
          const matched = arrMatch?.[0] || objMatch?.[0];
          if (matched) {
            try {
              const parsed = JSON.parse(matched);
              if (Array.isArray(parsed)) leads = parsed;
              else if (Array.isArray(parsed?.leads)) leads = parsed.leads;
            } catch {}
          }
        }
      }

      console.log(`[research_beaver] Found ${leads.length} leads for query: "${query}"`);
    } catch (err) {
      console.error('[agents] Research Beaver failed:', err.message);
      await logMistake(clientId, 'research_beaver', 'Claude call failed during research', err.message, 'Retry with a more specific query or check Apollo connection');
    }
  }

  return {
    success: true,
    data: { leads, query, filters },
  };
  ── end Claude fallback ── */
}

/**
 * Pre-draft personalisation: search the web for recent signals about
 * the lead's company/person. Returns 0-3 signal snippets that Sales
 * Beaver can reference. Uses Brave (no LLM cost). Skips if lead
 * already has strong signal data from Research Beaver.
 */
async function searchPersonalisationSignals(lead) {
  const meta = lead.metadata || {};
  // Skip if we already have strong signal data
  if (meta.signal && meta.why_now) return [];

  const { searchOpenWeb } = require('./searchService');
  const queries = [];

  if (lead.company && lead.company !== 'Unknown Company') {
    queries.push(`"${lead.company}" news OR hiring OR funding OR launch 2026`);
  }
  if (lead.name && lead.name !== 'Unknown Contact' && lead.company && lead.company !== 'Unknown Company') {
    queries.push(`"${lead.name}" "${lead.company}"`);
  }

  if (queries.length === 0) return [];

  const signals = [];
  for (const q of queries.slice(0, 2)) {
    try {
      const results = await searchOpenWeb(q, 3);
      for (const r of results) {
        if (r.snippet && r.snippet.length > 30) {
          let source = r.source || '';
          if (!source && r.link) {
            try { source = new URL(r.link).hostname; } catch {}
          }
          signals.push({
            text: r.snippet.substring(0, 150),
            source,
            date: r.date || '',
          });
        }
      }
    } catch (err) {
      console.warn(`[sales-personalise] Search failed for "${q}":`, err.message);
    }
  }
  return signals.slice(0, 3);
}

/**
 * =========================
 * SALES BEAVER
 * =========================
 *
 * Wave 3 (2026-05-03): every draft is tagged with SALES_PROMPT_VARIANT in
 * metadata. Enables `reply_rate by variant` rollups once we A/B-test prompts.
 * Bump this constant when materially changing the salesGenerate prompt.
 */
const SALES_PROMPT_VARIANT = 'sales_v3_2026_05_18_sonnet';

function safeJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function getSignalPackage(source = {}) {
  const meta = safeJsonObject(source.metadata);
  return source.signal_package
    || meta.signal_package
    || source.signalPackage
    || meta.signalPackage
    || null;
}

function isCompetitorOffer(source = {}, signalPackage = null) {
  const meta = safeJsonObject(source.metadata);
  const fit = safeJsonObject(signalPackage?.company_icp_fit);
  const values = [
    source.lead_class,
    meta.lead_class,
    signalPackage?.lead_class,
    signalPackage?.reject_reason,
    fit.lead_class,
    fit.reject_reason,
  ].filter(Boolean).map(v => String(v).toLowerCase());
  return values.some(v => v.includes('competitor_offer') || v.includes('competitor-offer'));
}

function hasUsefulValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' ? value.trim().length > 0 : !!value;
}

function decisionMakerPresent(signalPackage = {}) {
  const decisionMaker = signalPackage.decision_maker;
  if (!decisionMaker) return false;
  if (Array.isArray(decisionMaker)) return decisionMaker.length > 0;
  if (typeof decisionMaker === 'object') {
    return hasUsefulValue(decisionMaker.name) || hasUsefulValue(decisionMaker.title) || hasUsefulValue(decisionMaker.source_url);
  }
  return hasUsefulValue(decisionMaker);
}

function isReplyOrFollowupContext(context = '', opts = {}) {
  const text = String(context || '').toLowerCase();
  return opts.is_reply === true
    || opts.touch_number > 0
    || text.includes('this is a reply message')
    || text.includes('reply received:')
    || text.includes('previous messages sent:')
    || text.includes('previous messages in this sequence')
    || text.includes('follow-up')
    || text.includes('follow up');
}

function salesSignalPreflight({ lead = {}, channel = 'email', context = '', is_reply = false, touch_number = 0 } = {}) {
  if (isReplyOrFollowupContext(context, { is_reply, touch_number })) {
    return { ok: true, bypassed: 'reply_or_followup' };
  }

  const signalPackage = getSignalPackage(lead);
  if (isCompetitorOffer(lead, signalPackage)) {
    return {
      ok: false,
      status: 'needs_more_research',
      missing_fields: [],
      reason: 'competitor_offer_disqualified',
      repair_route: 'competitor_offer_disqualified',
      required_repair: 'Research must park this competitor-offer prospect instead of drafting.',
    };
  }

  const missingFields = [];
  if (!signalPackage || typeof signalPackage !== 'object') {
    missingFields.push('signal_package');
  } else {
    if (!hasUsefulValue(signalPackage.source_url)) missingFields.push('source_url');
    if (!hasUsefulValue(signalPackage.evidence)) missingFields.push('evidence');
    if (!hasUsefulValue(signalPackage.why_now)) missingFields.push('why_now');
    if (!decisionMakerPresent(signalPackage)) missingFields.push('decision_maker');
  }

  const hasIdentity = hasUsefulValue(lead.name) && hasUsefulValue(lead.company) && hasUsefulValue(lead.title);
  if (!hasIdentity) missingFields.push('lead_identity');
  if (!['email', 'linkedin', 'instagram'].includes(String(channel || '').toLowerCase())) {
    missingFields.push('channel');
  }

  if (missingFields.length > 0) {
    return {
      ok: false,
      status: 'needs_more_research',
      missing_fields: [...new Set(missingFields)],
      reason: 'signal_package_incomplete',
      repair_route: 'needs_research_repair',
      required_repair: 'Research must provide source_url, evidence, why_now, and decision_maker before Sales drafts.',
    };
  }

  return { ok: true, signal_package: signalPackage };
}

function signalDraftGuidance(signalPackage = {}) {
  const family = String(signalPackage.signal_family || signalPackage.signal_type || signalPackage.signal_id || '').toLowerCase();
  const prefix = 'observed signal -> commercial implication -> one pointed diagnostic question';
  if (family.includes('hiring')) {
    return `${prefix}: hiring role implies capacity pressure; ask one diagnostic question about outbound load or pipeline ownership.`;
  }
  if (family.includes('expansion') || family.includes('market')) {
    return `${prefix}: expansion implies market/team ramp pressure; ask one diagnostic question about building pipeline in the new motion.`;
  }
  if (family.includes('funding') || family.includes('capital') || family.includes('budget')) {
    return `${prefix}: fresh capital implies GTM execution pressure; ask one diagnostic question about turning budget into pipeline.`;
  }
  if (family.includes('ad') || family.includes('paid') || family.includes('campaign') || family.includes('gtm_spend')) {
    return `${prefix}: active ads imply paid demand or campaign motion; ask one diagnostic question about conversion or outbound leverage.`;
  }
  if (family.includes('tech') || family.includes('stack') || family.includes('crm')) {
    return `${prefix}: tech stack change implies process redesign and operational friction; ask one diagnostic question about workflow ownership.`;
  }
  return `${prefix}: use the verified evidence, name the commercial implication, then ask exactly one diagnostic question.`;
}

function buildSalesSignalContext({ lead = {}, channel = 'email' } = {}) {
  const signalPackage = getSignalPackage(lead);
  if (!signalPackage) return '';
  const channelLine = channel === 'linkedin'
    ? 'Channel limit: LinkedIn DM, exactly 3 lines, under 50 words, start with "Hi [first name], saw you [specific signal].", no subject, no sign-off, end on one diagnostic question.'
    : channel === 'instagram'
      ? 'Channel limit: Instagram DM, 1-2 sentences, under 30 words, no sign-off.'
      : 'Channel limit: Email body under 80 words, system appends the sign-off.';
  return [
    'SIGNAL PACKAGE (required evidence for this draft):',
    `- signal_id: ${signalPackage.signal_id || 'unknown'}`,
    `- signal_family: ${signalPackage.signal_family || 'unknown'}`,
    `- source_url: ${signalPackage.source_url || 'missing'}`,
    `- evidence: ${Array.isArray(signalPackage.evidence) ? signalPackage.evidence.join('; ') : signalPackage.evidence || 'missing'}`,
    `- why_now: ${signalPackage.why_now || 'missing'}`,
    `- decision_maker: ${typeof signalPackage.decision_maker === 'object' ? JSON.stringify(signalPackage.decision_maker) : signalPackage.decision_maker || 'missing'}`,
    `- writing_logic: ${signalDraftGuidance(signalPackage)}`,
    channelLine,
    'No generic opener. Do not write "saw your company" or broad company praise.',
  ].join('\n');
}

async function loadLeadForSalesPreflight(clientId, leadId) {
  if (!clientId || !leadId) return null;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, company, title, email, linkedin_url, email_verified, email_source, metadata, status, pipeline_stage
       FROM leads WHERE id = $1 AND client_id = $2 LIMIT 1`,
      [leadId, clientId]
    );
    return rows[0] || null;
  } catch (err) {
    console.warn('[sales-preflight] lead lookup failed:', err.message);
    return null;
  }
}

async function salesGenerate(clientId, { lead_id, channel, context = '' }) {
  await logsService.createLog(clientId, {
    agent: 'sales_beaver',
    action: 'message_generated',
    target_type: 'message',
    target_id: lead_id,
    metadata: { lead_id, channel },
  });

  const salesLead = await loadLeadForSalesPreflight(clientId, lead_id);
  const signalPreflight = salesSignalPreflight({
    lead: salesLead || { id: lead_id },
    channel,
    context,
  });
  if (!signalPreflight.ok) {
    const repairState = repairPolicy.researchRepairState(salesLead || {});
    const signalPackage = getSignalPackage(salesLead || {});
    await logsService.createLog(clientId, {
      agent: 'sales_beaver',
      action: 'needs_more_research',
      target_type: 'lead',
      target_id: lead_id,
      metadata: {
        lead_id,
        channel,
        missing_fields: signalPreflight.missing_fields,
        reason: signalPreflight.reason,
        repair_route: signalPreflight.repair_route,
        repair_attempt: repairState.repairAttempt,
        max_repair_attempts: repairState.maxRepairAttempts,
        signal_package_hash: repairPolicy.signalPackageHash(signalPackage),
      },
    }).catch(() => {});
    return {
      lead_id,
      channel,
      subject: null,
      body: null,
      status: 'needs_more_research',
      missing_fields: signalPreflight.missing_fields,
      reason: signalPreflight.reason,
      repair_route: signalPreflight.repair_route,
      required_repair: signalPreflight.required_repair,
      repair_attempt: repairState.repairAttempt,
      max_repair_attempts: repairState.maxRepairAttempts,
      signal_package: signalPackage,
    };
  }

  if (callAgent) {
    try {
      const directivesSvc = require('./directives');
      const { ensureLeadAngle } = require('./researchEnrichment');
      const [persona, fileConfig, rangerPatterns, salesDirectives, founderFeedback, teachingNote, leadAngle] = await Promise.all([
        getClientPersona(clientId),
        getClientConfig(clientId),
        // MEMORY: Load Ranger rejection patterns — brief Sales Beaver on what to avoid (Sprint 9)
        getRangerRejectionPatterns(clientId),
        // Wave 1 (2026-05-03): Captain may have written an apply_rejection_patterns
        // directive with TODAY's top reject reasons (>= 3 rejects). These are
        // sharper than the historical Ranger memory — Sales Beaver applies both.
        directivesSvc.readPendingDirectives(clientId, 'sales_beaver').catch(() => []),
        // Fix 6: Founder feedback — edit diffs + rejection reasons from MJ's corrections
        getFounderFeedback(clientId),
        // A8-6: Enforcer's weekly teaching note — the "sharpen the clone" loop.
        getEnforcerTeachingNote(clientId),
        // MJ direction 2026-05-19: every lead gets a REAL, verifiable angle
        // before Sales Beaver drafts — researched on the spot if not already
        // present. No lead is ever skipped for lack of a pre-found signal.
        ensureLeadAngle(clientId, lead_id),
      ]);
      const personaContext = buildPersonaContext(persona);
      const fileContext = buildClientContext(fileConfig);

      let rangerContext = '';
      if (rangerPatterns?.length) {
        rangerContext = `\n\nRANGER REJECTION HISTORY — these patterns were rejected recently, do NOT repeat them:\n${rangerPatterns.slice(0, 5).join('\n')}`;
      }

      // Fix 6: Founder feedback injection — the founder's edits and rejections
      // are the strongest signal for voice calibration. These examples show exactly
      // how the founder wants messages to read.
      let founderFeedbackContext = '';
      if (founderFeedback?.length) {
        founderFeedbackContext = `\n\nFOUNDER FEEDBACK — the founder edited or rejected these drafts. Study these examples carefully and match the founder's preferred style, tone, and length:\n\n${founderFeedback.join('\n\n---\n\n')}`;
      }

      // A8-6: Enforcer's weekly teaching note — the Enforcer reviews a week of
      // drafts and writes one tightening instruction. Folding it in here is the
      // "sharpen the clone" loop: this week's drafts learn from last week's QA.
      let teachingContext = '';
      if (teachingNote) {
        teachingContext = `\n\nENFORCER'S WEEKLY TEACHING NOTE — the QA agent's coaching from last week's reviews. Apply it:\n${teachingNote}`;
      }

      // MJ direction 2026-05-19: the verified personalisation angle. Every lead
      // carries one (researched on the spot by ensureLeadAngle). Sales Beaver
      // anchors the opener on it — never sends a generic, non-personal message.
      let angleContext = '';
      if (leadAngle?.ok && leadAngle.signal) {
        const tier = leadAngle.strength === 'rich'
          ? 'SIGNAL-RICH — a dated recent trigger event'
          : 'SIGNAL-LITE — a verifiable observation about the company/role';
        angleContext = `\n\nVERIFIED PERSONALISATION ANGLE — anchor the opening line on this. It is verified TRUE; use it, do not contradict it, do not embellish beyond it. Tier: ${tier}.\n- Signal: ${leadAngle.signal}`;
        if (leadAngle.why_now) angleContext += `\n- Why now: ${leadAngle.why_now}`;
        if (leadAngle.angle)   angleContext += `\n- Suggested angle: ${leadAngle.angle}`;
      }

      const signalContext = buildSalesSignalContext({ lead: salesLead, channel });

      // Captain's directive injection — today's hot reject reasons + any other
      // active directives. Marked consumed at end of this draft (whether the
      // resulting message survives Enforcer or not — the directive WAS applied).
      let captainDirectiveContext = '';
      const consumedDirectiveIds = [];
      const rejectDirective = salesDirectives.find(d => d.directive_type === 'apply_rejection_patterns');
      if (rejectDirective?.payload?.patterns?.length) {
        const lines = rejectDirective.payload.patterns
          .slice(0, 5)
          .map(p => `- ${p.reason} (rejected ${p.n}× today)`)
          .join('\n');
        captainDirectiveContext = `\n\nCAPTAIN'S DIRECTIVE — today's top reject reasons. Avoid these patterns at ALL costs:\n${lines}`;
        consumedDirectiveIds.push(rejectDirective.id);
      }

      // Phase 5.5 (2026-05-06): Winning hooks directive — positive counterpart to
      // apply_rejection_patterns. Captain writes when ≥3 reply events confirm a pattern.
      // Injected as a SUGGESTION (not a mandate) so Sonnet can adapt to each lead's context.
      const winningHooksDirective = salesDirectives.find(d => d.directive_type === 'apply_winning_hooks');
      if (winningHooksDirective?.payload?.hooks?.length) {
        const hookLines = winningHooksDirective.payload.hooks
          .slice(0, 3)
          .map(h => `- "${h.text}" (${h.channel}, ${h.reply_rate}% reply rate, ${h.total_replies} replies)`)
          .join('\n');
        captainDirectiveContext += `\n\nCAPTAIN'S DIRECTIVE — winning hook patterns (bias toward these opening angles when relevant):\n${hookLines}`;
        consumedDirectiveIds.push(winningHooksDirective.id);
      }

      // Sender identity — resolved at template layer, NOT in prompt (ICP+channel patches per MJ direction 2026-04-29).
      // The LLM must not produce its own signature; we strip and re-append below.
      const senderName = resolveSenderName(clientId, persona);

      const signOffInstruction = channel === 'email'
        ? `\nDO NOT include any sign-off, signature, sender name, "Regards,", "Best,", "Cheers,", or your own name. The system appends the signature deterministically. End the body at the final question.`
        : `\nDO NOT include any sign-off like "Regards," or "Best," — this is a ${channel} DM, not an email. No sign-off at all. Just end with the question.`;

      const result = await callAgent(
        'sales_beaver',
        `Write a ${channel} outreach message for this lead: ${context}
${signOffInstruction}
${signalContext}
${angleContext}
${personaContext}${fileContext}${rangerContext}${captainDirectiveContext}${founderFeedbackContext}${teachingContext}`,
        { lead_id, channel, clientId }
      );

      // Mark Captain's directive consumed once it's been folded into the prompt.
      // Fire-and-forget — failure here doesn't invalidate the draft.
      if (consumedDirectiveIds.length > 0) {
        directivesSvc.markConsumed(clientId, consumedDirectiveIds).catch(() => {});
      }

      // Primary: structured JSON response with body field
      if (result?.body) {
        let finalSubject = result.subject || null;
        let finalBody = result.body;

        // Defensive unwrap: Haiku intermittently returns nested JSON inside the
        // body field, i.e. result = {subject: "X", body: '{"subject":"X","body":"Hi AJ..."}'}.
        // Without this check, the raw JSON string gets stored as the message body and
        // ends up in the approval queue as literal {"subject":"...","body":"..."}.
        if (typeof finalBody === 'string' && /^\s*\{[\s\S]*?"body"\s*:/.test(finalBody)) {
          try {
            const inner = JSON.parse(finalBody);
            if (typeof inner?.body === 'string' && inner.body.trim().length > 0) {
              console.warn(`[agents] Sales Beaver returned nested JSON body for lead ${lead_id} — unwrapping inner body`);
              finalBody = inner.body;
              // Inner subject only overrides when outer didn't provide one
              if (!finalSubject && typeof inner?.subject === 'string') {
                finalSubject = inner.subject;
              }
            }
          } catch (err) {
            console.warn(`[agents] Failed to parse nested JSON body for lead ${lead_id}: ${err.message}`);
            // Keep original — better a broken message that Enforcer will catch than a silent drop
          }
        }

        // ICP+channel patches per MJ direction 2026-04-29
        // Strip any LLM-generated signature/sign-off, then deterministically append the
        // hardcoded sender identity for emails. LinkedIn DMs get no sign-off.
        // Two-pass strip (2026-05-06): SIGNOFF first catches standard sign-offs,
        // AGENT_NAME catches stray "Bryan Beaver" / "Enforcer Beaver" / "Beaver Solutions"
        // tails that slip past when the LLM omits the sign-off word.
        finalBody = stripEmDashes(finalBody);
        if (typeof finalBody === 'string') {
          let stripped = finalBody.replace(SIGNOFF_STRIP_REGEX, '').replace(/\s+$/, '');
          stripped = stripped.replace(AGENT_NAME_STRIP_REGEX, '').replace(/\s+$/, '');
          finalBody = (channel === 'email')
            ? `${stripped}\n\nRegards,\n${senderName}`
            : stripped;
        }

        return {
          lead_id,
          channel,
          subject: stripEmDashes(finalSubject) || null,
          body:    finalBody,
          status:  'pending_ranger',
          prompt_variant: SALES_PROMPT_VARIANT,
          signal_package: signalPreflight.signal_package || getSignalPackage(salesLead || {}) || null,
          research_repair: salesLead?.metadata?.research_repair || null,
        };
      }

      // Fallback: Claude returned raw text (JSON parse failed) — extract body from raw
      if (result?.raw) {
        const raw = result.raw;
        console.warn(`[agents] Sales Beaver returned raw text (JSON parse failed) for lead ${lead_id} — attempting body extraction`);

        // Try: find "body": "..." in the raw string (handles escaped JSON)
        const bodyMatch = raw.match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
        const subjectMatch = raw.match(/"subject"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (bodyMatch) {
          const extractedBody = bodyMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          const extractedSubject = subjectMatch ? subjectMatch[1].replace(/\\"/g, '"') : null;
          console.log(`[agents] Extracted body from raw response for lead ${lead_id}`);
          return {
            lead_id,
            channel,
            subject: extractedSubject ? stripEmDashes(extractedSubject) : null,
            body:    (() => {
              // ICP+channel patches per MJ direction 2026-04-29 — strip+append in fallback path too
              // Two-pass strip (2026-05-06): SIGNOFF then AGENT_NAME catches "Bryan Beaver" tails.
              let stripped = stripEmDashes(extractedBody).replace(SIGNOFF_STRIP_REGEX, '').replace(/\s+$/, '');
              stripped = stripped.replace(AGENT_NAME_STRIP_REGEX, '').replace(/\s+$/, '');
              return channel === 'email' ? `${stripped}\n\nRegards,\n${senderName}` : stripped;
            })(),
            status:  'pending_ranger',
            signal_package: signalPreflight.signal_package || getSignalPackage(salesLead || {}) || null,
            research_repair: salesLead?.metadata?.research_repair || null,
          };
        }

        // Last resort: use the entire raw text as body if it looks like a message (>20 chars)
        if (raw.length > 20 && !raw.startsWith('{')) {
          console.log(`[agents] Using raw response as body for lead ${lead_id} (${raw.length} chars)`);
          return {
            lead_id,
            channel,
            subject: null,
            body:    (() => {
              // ICP+channel patches per MJ direction 2026-04-29 — strip+append in last-resort fallback too
              // Two-pass strip (2026-05-06): SIGNOFF then AGENT_NAME catches "Bryan Beaver" tails.
              let stripped = stripEmDashes(raw.trim()).replace(SIGNOFF_STRIP_REGEX, '').replace(/\s+$/, '');
              stripped = stripped.replace(AGENT_NAME_STRIP_REGEX, '').replace(/\s+$/, '');
              return channel === 'email' ? `${stripped}\n\nRegards,\n${senderName}` : stripped;
            })(),
            status:  'pending_ranger',
            signal_package: signalPreflight.signal_package || getSignalPackage(salesLead || {}) || null,
            research_repair: salesLead?.metadata?.research_repair || null,
          };
        }

        console.warn(`[agents] Could not extract body from raw response for lead ${lead_id}. Raw: ${raw.substring(0, 200)}`);
      }
    } catch (err) {
      if (isBudgetExceededError(err)) {
        console.warn('[agents] Sales generation blocked by budget cap:', err.message);
        throw err;
      }
      console.warn('[agents] Sales Claude failed:', err.message);
      await logMistake(clientId, 'sales_beaver', 'Claude call failed during message generation', err.message, 'Check Claude API connectivity and lead context quality');
    }
  }

  return {
    lead_id,
    channel,
    error: true,
    subject: null,
    body: null,
    status: 'failed',
    failure_reason: 'Sales Beaver could not generate a message — Claude API unavailable',
  };
}

/**
 * Strip em dashes as a hard safety net before saving any message body.
 * Replaces — with a comma or space depending on context.
 */
function stripEmDashes(text) {
  if (!text) return text;
  // Replace em dash with a comma-space for mid-sentence, or just a space
  return text.replace(/\s*—\s*/g, ', ').replace(/—/g, ' ').replace(/\s*–\s*/g, ', ').replace(/–/g, ' ');
}

/**
 * =========================
 * AUTO-FIX PIPELINE (Phase A)
 * =========================
 * Runs BEFORE Enforcer review. Fixes anything that can be fixed deterministically
 * without damaging the message. Returns the cleaned message + a list of fixes applied.
 *
 * Philosophy: Reject → Fix → Retry, not Reject → Drop.
 * Only BRAND-SAFETY issues are left for the Enforcer to hard-reject.
 * Quality issues are auto-fixed here so the pipeline keeps flowing.
 */
function autoFixMessage(body, { touchNumber = 0, maxWords = 80, channel = null } = {}) {
  if (!body || typeof body !== 'string') {
    return { body: body || '', fixes: [], fatal: 'empty_body' };
  }

  const fixes = [];
  let fixed = body;

  // 1. Em dash / en dash → comma
  if (/[—–]/.test(fixed)) {
    fixed = stripEmDashes(fixed);
    fixes.push('stripped_em_dashes');
  }

  // 2. Bullet points → merge into sentences
  if (/^\s*[•\-\*]\s/m.test(fixed)) {
    fixed = fixed.replace(/^\s*[•\-\*]\s+/gm, '').replace(/\n{2,}/g, '\n\n');
    fixes.push('removed_bullets');
  }

  // 3. Strip numbered lists (1. 2. 3.) inside body
  if (/^\s*\d+[\.\)]\s/m.test(fixed)) {
    fixed = fixed.replace(/^\s*\d+[\.\)]\s+/gm, '');
    fixes.push('removed_numbered_list');
  }

  // 4. Collapse extra whitespace + blank lines
  fixed = fixed.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // 5. Strip soft CTA phrases (Day 0 only)
  if (touchNumber === 0) {
    const softCtas = [
      /\bworth a quick chat\b[^.?!]*/gi,
      /\bhappy to jump on\b[^.?!]*/gi,
      /\bwould love to connect\b[^.?!]*/gi,
      /\bkeen to connect\b[^.?!]*/gi,
      /\blet me know if you'?re open to\b[^.?!]*/gi,
      /\bopen to a quick\b[^.?!]*/gi,
    ];
    let stripped = false;
    for (const pattern of softCtas) {
      if (pattern.test(fixed)) {
        fixed = fixed.replace(pattern, '').replace(/\s+([.?!])/g, '$1').replace(/\s{2,}/g, ' ').trim();
        stripped = true;
      }
    }
    if (stripped) fixes.push('stripped_soft_cta');
  }

  // 6. Strip banned phrases (case-insensitive)
  // 2026-05-15: was a stale hand-copied 26-item list that never picked up the
  // 2026-05-13 v1.0 additions. Now references VENDOR_SPEAK_PHRASES directly —
  // the strippable subset. Structural cold-tells (COLD_TELL_PHRASES) are NOT
  // autofixed; codeEnforcerGates hard-rejects those so they regenerate.
  const bannedLowerList = VENDOR_SPEAK_PHRASES;
  let bannedHit = false;
  for (const phrase of bannedLowerList) {
    const re = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi');
    if (re.test(fixed)) {
      fixed = fixed.replace(re, '');
      bannedHit = true;
    }
  }
  if (bannedHit) {
    fixed = fixed.replace(/\s{2,}/g, ' ').replace(/\s+([.?!,])/g, '$1').trim();
    fixes.push('stripped_banned_phrases');
  }

  // 7. Collapse multiple question marks → single
  if (/\?{2,}/.test(fixed)) {
    fixed = fixed.replace(/\?{2,}/g, '?');
    fixes.push('collapsed_question_marks');
  }

  // 8. Reduce to ONE question (keep the last — usually the CTA question)
  const questionMatches = fixed.match(/\?/g) || [];
  if (questionMatches.length > 1) {
    // Split on sentence boundaries, keep only the last question, convert others to statements
    const sentences = fixed.split(/(?<=[.?!])\s+/);
    let lastQuestionIdx = -1;
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (sentences[i].includes('?')) { lastQuestionIdx = i; break; }
    }
    for (let i = 0; i < sentences.length; i++) {
      if (i !== lastQuestionIdx && sentences[i].includes('?')) {
        sentences[i] = sentences[i].replace(/\?/g, '.');
      }
    }
    fixed = sentences.join(' ');
    fixes.push('reduced_to_one_question');
  }

  // 9. Word count trim (preserve greeting + sign-off)
  // Strip greeting "Hi Name," and sign-off "Regards, Name" for counting
  const bodyOnly = fixed
    .replace(/^Hi\s+[\w\s]{1,40}?,\s*/i, '')
    .replace(/\s*Regards,?\s*[\s\S]*$/i, '')
    .replace(/\s*Best,?\s*[\s\S]*$/i, '')
    .replace(/\s*Cheers,?\s*[\s\S]*$/i, '')
    .trim();
  const words = bodyOnly.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    // Trim from the middle: keep opening 2 sentences + closing sentence (usually has the question)
    const sentences = bodyOnly.split(/(?<=[.?!])\s+/).filter(Boolean);
    if (sentences.length >= 3) {
      const questionSentIdx = sentences.findIndex(s => s.includes('?'));
      const closing = questionSentIdx >= 0 ? sentences[questionSentIdx] : sentences[sentences.length - 1];
      let trimmed = [sentences[0], sentences[1], closing].join(' ');
      const trimmedWords = trimmed.split(/\s+/).filter(Boolean);
      if (trimmedWords.length > maxWords) {
        trimmed = trimmedWords.slice(0, maxWords).join(' ');
      }
      // Rebuild with greeting + sign-off
      const greetingMatch = fixed.match(/^Hi\s+[\w\s]{1,40}?,/i);
      const signoffMatch = fixed.match(/(Regards|Best|Cheers),?\s*[\s\S]*$/i);
      fixed = [
        greetingMatch ? greetingMatch[0] : 'Hi,',
        '',
        trimmed,
        '',
        signoffMatch ? signoffMatch[0] : 'Regards,',
      ].join('\n');
      fixes.push(`trimmed_from_${words.length}_to_${trimmed.split(/\s+/).length}_words`);
    }
  }

  // 10. Final whitespace cleanup
  fixed = fixed.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

  // 11. LinkedIn channel: strip the email sign-off entirely (2026-05-29 Phase 5).
  // Canonical rule: LinkedIn DMs end on the question with NO sign-off; email keeps
  // "Regards, / Michael Jerry". Sales Beaver inconsistently appends the email
  // sign-off to LinkedIn drafts, which the Enforcer then hard-rejects — by far the
  // dominant pre-score reject class (the pool is LinkedIn-heavy). Deterministic
  // stripping here means a good LinkedIn draft is no longer killed for it.
  // The \n-anchor requires the closer to start its own line, so a mid-sentence
  // "best"/"thanks" is never matched.
  if (channel === 'linkedin') {
    const before = fixed;
    // A sign-off is a closer word starting its own line, optionally followed by a
    // comma and/or the sender name, to end of message. Restricting the tail to
    // (comma / name / newline) only means a mid-line "best way to reach you" or
    // "thanks for the note" is never matched — only a true closing block is.
    fixed = fixed.replace(
      /\n+[ \t]*(regards|best regards|kind regards|warm regards|best|cheers|thanks|thank you|sincerely)\b[ \t]*,?[ \t]*(michael(?:\s+jerry)?|mj)?[ \t]*(\n[\s\S]*)?$/i,
      ''
    ).trim();
    // Standalone bare-name sign-off (no closer word).
    fixed = fixed.replace(/\n+[ \t]*(michael(?:\s+jerry)?|mj)[ \t]*$/i, '').trim();
    if (fixed !== before) fixes.push('stripped_linkedin_signoff');
  }

  return { body: fixed, fixes, fatal: null };
}

/**
 * Hard brand-safety checks — these CANNOT be auto-fixed. Fail = drop.
 * Everything else should be auto-fixed by autoFixMessage().
 */
function brandSafetyCheck(body, leadContext = {}) {
  if (!body) return { safe: false, reason: 'empty_body' };

  // 1. Placeholder text never got filled
  if (/\[(name|company|first_name|last_name|title)\]/i.test(body) ||
      /\{\{[^}]+\}\}/.test(body) ||
      /<insert[^>]*>/i.test(body)) {
    return { safe: false, reason: 'unfilled_placeholder' };
  }

  // 2. Prompt injection leaked into message
  if (/ignore previous instructions|system:|you are now/i.test(body)) {
    return { safe: false, reason: 'prompt_injection_detected' };
  }

  // 3. Credential or API key shape
  if (/\b(sk-[a-zA-Z0-9]{20,}|api[_-]?key|bearer\s+[a-zA-Z0-9]{20,})\b/i.test(body)) {
    return { safe: false, reason: 'credential_leak' };
  }

  // 4. Wrong name mismatch (if lead context provided)
  if (leadContext?.name) {
    const leadTokens = String(leadContext.name || '').trim().split(/\s+/).filter(Boolean);
    const normaliseNameToken = (value = '') => String(value)
      .trim()
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      .toLowerCase();
    const honorifics = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'professor']);
    const firstName = leadTokens[0] || '';
    const allowedGreetingTokens = new Set();
    const normalisedFirst = normaliseNameToken(firstName);
    if (normalisedFirst) allowedGreetingTokens.add(normalisedFirst);
    if (honorifics.has(normalisedFirst) && leadTokens[1]) {
      allowedGreetingTokens.add(normaliseNameToken(leadTokens[1]));
    }
    if ([...allowedGreetingTokens].some(token => token.length >= 3 || honorifics.has(token))) {
      // Look for "Hi <OtherName>," pattern and check it matches
      const greetMatch = body.match(/^Hi\s+([A-Za-z][A-Za-z.'-]*)/i);
      const greeted = normaliseNameToken(greetMatch?.[1] || '');
      if (greeted && !allowedGreetingTokens.has(greeted)) {
        return { safe: false, reason: `name_mismatch: greeted "${greetMatch[1]}" but lead is "${firstName}"` };
      }
    }
  }

  // 5. Fabricated growth/funding claims without data (heuristic)
  if (leadContext && !leadContext.signal && !leadContext.why_now) {
    const fabricationPatterns = [
      /\brecently raised\b/i,
      /\bjust closed (a|your) funding\b/i,
      /\bimpressive \d+% growth\b/i,
      /\bcongrats on (your|the) (series|round|raise)\b/i,
    ];
    for (const p of fabricationPatterns) {
      if (p.test(body)) {
        return { safe: false, reason: 'fabricated_claim' };
      }
    }
  }

  // 6. Fabricated email address in body (2026-05-14: Hari Kishan h@tamsaglobal.com class).
  // Sales Beaver sometimes invents a contact email — short slug @ company-shaped-domain.
  // Sending to a fabricated address bounces / hits spam traps / wastes the warm signal.
  // Any email in the body must match the lead's known email OR be a recognised sender
  // domain (the user's own org). Otherwise hard reject.
  const emailRe = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const foundEmails = (body.match(emailRe) || []).map(e => e.toLowerCase());
  if (foundEmails.length > 0) {
    const leadEmail = String(leadContext.email || '').toLowerCase();
    const senderAllowed = /@(beaver\.solutions|emplifive\.com|emplifive\.ai)$/i;
    const fabricated = foundEmails.filter(e =>
      e !== leadEmail && !senderAllowed.test(e)
    );
    if (fabricated.length > 0) {
      return { safe: false, reason: `fabricated_email:${fabricated[0]}` };
    }
  }

  return { safe: true };
}

/**
 * =========================
 * CODE-LEVEL ENFORCER GATES
 * =========================
 * Hard checks that run AFTER Claude's Enforcer review, BEFORE saving to pending_approval.
 * These catch anything Claude missed. If any gate fails, the message is force-rejected
 * regardless of Claude's score.
 */
// 2026-05-15: split into two named lists so autoFixMessage and codeEnforcerGates
// can never drift apart again (they did — autofix carried a stale 26-item subset).
//
// VENDOR_SPEAK_PHRASES — adjectives/fillers safe to STRIP mid-sentence without
// breaking grammar. autoFixMessage strips these to rescue a borderline draft.
const VENDOR_SPEAK_PHRASES = [
  'cutting-edge', 'paradigm shift', 'seamless', 'leverage', 'synergy',
  'game-changer', 'innovative', 'revolutionary', 'transformative', 'delve',
  'i hope this email finds you well', 'i wanted to reach out', 'unlock',
  'unleash', 'empower', 'elevate', 'streamline', 'actionable insights',
  'thought leader', 'disruptive', 'data-driven', 'circle back', 'touch base',
  'move the needle', 'best-in-class',
];

// COLD_TELL_PHRASES — structural template tells. A message containing one of
// these is fundamentally a template; stripping the phrase leaves broken grammar.
// codeEnforcerGates hard-rejects and forces a full regenerate. Do NOT autofix these.
// 2026-05-13: Beaver v1.0 cold-tells (sales-assets/BEAVER_LINKEDIN_OUTREACH_RULES.md).
const COLD_TELL_PHRASES = [
  'at what point does', 'at what point do you', 'how do you think about', "what's your approach to",
  'most founders i talk to', 'most founders i speak to',
  'we help teams like yours', 'agencies like yours', 'founders like you',
  'worth a chat', '15 minutes this week', '15 mins this week',
  'happy to jump on a call', 'happy to hop on a call',
  'passionate about', 'results-driven',
  'hope this finds you well', "hope you're doing well", 'hope all is well',
  // Follow-up cold-tells (mirror followupSequence.js prompt banned list)
  'just checking in', 'circling back', 'following up on',
  'still thinking', 'just thinking', 'still wondering',
  'quick favor', 'quick ask',
];

// Full hard-reject set. codeEnforcerGates checks this. Derived from the two
// lists above — single source of truth, no manual duplication.
const BANNED_PHRASES = [...VENDOR_SPEAK_PHRASES, ...COLD_TELL_PHRASES];

function codeEnforcerGates(body, touchNumber = 0) {
  if (!body) return { passed: false, reason: 'Empty message body' };

  const failures = [];

  // Gate 1: Word count for Day 0 cold messages
  // Prompt says 80 words excluding greeting + sign-off. Code gate uses 100 to account
  // for "Hi [Name]," + "Regards,\nSender Name" (~15-20 words of non-body content).
  const wordCount = body.split(/\s+/).filter(w => w.length > 0).length;
  if (touchNumber === 0 && wordCount > 100) {
    failures.push(`Word count ${wordCount} exceeds 100 (80 body + greeting/signoff allowance)`);
  }

  // Gate 2: More than 1 question
  const questionCount = (body.match(/\?/g) || []).length;
  if (questionCount > 1) {
    failures.push(`${questionCount} questions found (max 1)`);
  }

  // Gate 3: Em dash anywhere
  if (body.includes('\u2014') || body.includes('\u2013')) {
    failures.push('Em dash or en dash detected');
  }

  // Gate 4: Bullet points in body
  if (/^\s*[•\-\*]\s/m.test(body)) {
    failures.push('Bullet points detected in message body');
  }

  // Gate 5: Banned phrases
  const lowerBody = body.toLowerCase();
  const foundBanned = BANNED_PHRASES.filter(phrase => lowerBody.includes(phrase));
  if (foundBanned.length > 0) {
    failures.push(`Banned phrase(s): ${foundBanned.join(', ')}`);
  }

  if (failures.length > 0) {
    return { passed: false, reason: failures.join('; ') };
  }

  return { passed: true };
}

function signalPackageMissingFields(signalPackage = {}) {
  const missing = [];
  if (!signalPackage || typeof signalPackage !== 'object') return ['signal_package'];
  if (!hasUsefulValue(signalPackage.source_url)) missing.push('source_url');
  if (!hasUsefulValue(signalPackage.evidence)) missing.push('evidence');
  if (!hasUsefulValue(signalPackage.why_now)) missing.push('why_now');
  if (!decisionMakerPresent(signalPackage)) missing.push('decision_maker');
  return missing;
}

function tokenizeEvidence(value) {
  const text = Array.isArray(value) ? value.join(' ') : String(value || '');
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 5 && !['company', 'training', 'business'].includes(token));
}

function messageReferencesSignal(messageBody = '', signalPackage = {}, leadContext = {}) {
  const body = String(messageBody || '').toLowerCase();
  const evidenceTokens = [
    ...tokenizeEvidence(signalPackage.evidence),
    ...tokenizeEvidence(signalPackage.why_now),
    ...tokenizeEvidence(signalPackage.signal_id),
  ];
  const uniqueTokens = [...new Set(evidenceTokens)].slice(0, 20);
  const tokenHits = uniqueTokens.filter(token => body.includes(token)).length;
  if (tokenHits >= 2) return true;

  const family = String(signalPackage.signal_family || signalPackage.signal_id || '').toLowerCase();
  if (family.includes('hiring') && /\bhiring|hire|recruit|role|bd(r)?|business development\b/i.test(messageBody)) return true;
  if (family.includes('expansion') && /\bexpand|expansion|market|office|region|ramp\b/i.test(messageBody)) return true;
  if ((family.includes('ad') || family.includes('gtm_spend')) && /\bad|ads|campaign|paid|demand\b/i.test(messageBody)) return true;
  if (family.includes('tech') && /\bcrm|stack|tool|system|workflow|migration\b/i.test(messageBody)) return true;
  if ((family.includes('funding') || family.includes('capital')) && /\bfunding|raised|capital|round|budget\b/i.test(messageBody)) return true;

  const company = String(leadContext.company || '').toLowerCase();
  return company.length > 3 && body.includes(company) && tokenHits >= 1;
}

function hasUnsupportedSignalClaim(messageBody = '', signalPackage = {}) {
  const body = String(messageBody || '').toLowerCase();
  const evidenceText = [
    signalPackage.signal_family,
    signalPackage.signal_id,
    signalPackage.evidence,
    signalPackage.why_now,
  ].join(' ').toLowerCase();
  const unsupportedFamilies = [
    { rule: 'unsupported_signal', claim: /\b(series\s+[abc]|seed|funding|raised|capital|round|investment|investor)\b/i, supported: /\b(funding|capital|raised|round|investment|investor|seed|series)\b/i },
    { rule: 'unsupported_signal', claim: /\bhiring|recruiting|new role|job post|business development manager\b/i, supported: /\b(hiring|hire|recruit|job|role|business development)\b/i },
    { rule: 'unsupported_signal', claim: /\bexpanding|new market|new office|launching in\b/i, supported: /\b(expansion|expand|new market|new office|launch)\b/i },
  ];
  return unsupportedFamilies.some(({ claim, supported }) => claim.test(body) && !supported.test(evidenceText));
}

function enforcerEvidenceGate({ message_body, lead_context = {} } = {}) {
  if (isReplyOrFollowupContext(lead_context.context || '', lead_context)) {
    return { bypassed: true, approved: true, decision: 'approve', evidence_decision: 'bypassed_reply_or_followup' };
  }

  const signalPackage = getSignalPackage(lead_context);

  if (isCompetitorOffer(lead_context, signalPackage)) {
    return {
      message_id: lead_context.message_id || null,
      approved: false,
      decision: 'reject',
      score: 0,
      evidence_decision: 'competitor_offer_disqualified',
      repair_route: 'competitor_offer_disqualified',
      failed_rule: 'competitor_offer_disqualified',
      failed_phrase: null,
      required_repair: 'Research must park competitor-offer prospects instead of sending them to Sales.',
      notes: 'competitor_offer_disqualified',
      issues: ['competitor_offer_disqualified'],
      suggestions: [],
    };
  }

  const missingFields = signalPackageMissingFields(signalPackage);
  if (missingFields.length > 0) {
    return {
      message_id: lead_context.message_id || null,
      approved: false,
      decision: 'reject',
      score: 0,
      evidence_decision: 'needs_research_repair',
      repair_route: 'needs_research_repair',
      failed_rule: 'thin_evidence',
      failed_phrase: null,
      required_repair: `Research must repair signal_package fields: ${missingFields.join(', ')}`,
      notes: `needs_research_repair:${missingFields.join(',')}`,
      issues: missingFields,
      suggestions: [],
      missing_fields: missingFields,
    };
  }

  if (hasUnsupportedSignalClaim(message_body, signalPackage)) {
    return {
      message_id: lead_context.message_id || null,
      approved: false,
      decision: 'reject',
      score: 20,
      evidence_decision: 'unsupported_signal',
      repair_route: 'needs_research_repair',
      failed_rule: 'unsupported_signal',
      failed_phrase: null,
      required_repair: 'Research must either provide evidence for the claimed signal or Sales must remove the unsupported claim.',
      notes: 'unsupported_signal',
      issues: ['unsupported_signal'],
      suggestions: [],
    };
  }

  const lowerBody = String(message_body || '').toLowerCase();
  const genericPhrases = [
    'saw your company',
    'noticed your company',
    'doing great',
    'impressive work',
    'we help companies',
    'worth a chat',
  ];
  const genericHit = genericPhrases.find(phrase => lowerBody.includes(phrase));
  const referencesSignal = messageReferencesSignal(message_body, signalPackage, lead_context);
  if (genericHit || !referencesSignal) {
    return {
      message_id: lead_context.message_id || null,
      approved: false,
      decision: 'reject',
      score: 45,
      evidence_decision: genericHit ? 'generic_message' : 'signal_not_used',
      repair_route: 'needs_sales_redraft',
      failed_rule: genericHit ? 'generic_message' : 'weak_copy',
      failed_phrase: genericHit || null,
      required_repair: 'Sales must redraft from the actual signal: observed signal -> commercial implication -> one pointed diagnostic question.',
      notes: genericHit ? `generic_message:${genericHit}` : 'signal_not_used',
      issues: [genericHit ? 'generic_message' : 'signal_not_used'],
      suggestions: ['Lead with the verified signal package, not broad company praise.'],
    };
  }

  const implicationWords = /\bcapacity|pipeline|ramp|pressure|demand|conversion|outbound|workflow|friction|execution\b/i;
  if (!implicationWords.test(message_body)) {
    return {
      message_id: lead_context.message_id || null,
      approved: false,
      decision: 'reject',
      score: 58,
      evidence_decision: 'weak_copy',
      repair_route: 'needs_sales_redraft',
      failed_rule: 'weak_copy',
      failed_phrase: null,
      required_repair: 'Sales must add the commercial implication before asking the diagnostic question.',
      notes: 'weak_copy',
      issues: ['weak_copy'],
      suggestions: ['Add the commercial implication tied to the signal.'],
    };
  }

  return {
    message_id: lead_context.message_id || null,
    approved: true,
    decision: 'approve',
    score: 85,
    evidence_decision: 'evidence_ok',
    repair_route: null,
    failed_rule: null,
    failed_phrase: null,
    required_repair: null,
  };
}

/**
 * =========================
 * RANGER
 * =========================
 */
async function rangerReview(clientId, { message_id, message_body, lead_context = {} }) {
  await logsService.createLog(clientId, {
    agent: 'ranger',
    action: 'ranger_review',
    target_type: 'message',
    target_id: message_id,
    metadata: { message_id },
  });

  // ── Phase A Step 1: Brand-safety hard check (NOT fixable) ──
  const safety = brandSafetyCheck(message_body, lead_context);
  if (!safety.safe) {
    console.warn(`[enforcer] HARD REJECT (brand-safety): ${safety.reason}`);
    // Shared-memory capture for Phase 2 weekly strategy (fire-and-forget)
    require('./learningEngine').postRangerRejection(clientId, {
      messageBody: message_body,
      notes: `Brand safety violation: ${safety.reason}`,
      score: 0,
      channel: lead_context?.channel,
      leadIndustry: lead_context?.industry,
    }).catch(() => {});
    // Phase 4 rebuild plan (2026-05-12): feedback_events enforcer_rejected
    // capture on brand-safety reject path (was missed in f86a0f5 — only
    // captured Sonnet-path rejects). Brand-safety is high-signal: name
    // mismatches, hallucinated facts, prompt-injection attempts all land here.
    require('./learningEngine').postFeedbackEvent(clientId, {
      leadId: lead_context?.lead_id || null,
      messageId: message_id || null,
      eventType: 'enforcer_rejected',
      signalStrengthAtTime: lead_context?.buying_signal_strength || null,
      sourceStrategy: lead_context?.source_strategy || null,
      segment: lead_context?.industry || null,
      channel: lead_context?.channel,
      touchNumber: lead_context?.touch_number ?? 0,
      rangerScore: 0,
      scoreDelta: -60,
      notes: `brand_safety:${safety.reason}`,
      payload: { failure_class: 'brand_safety', reason: safety.reason },
    }).catch(() => {});
    return {
      message_id,
      approved: false,
      decision: 'reject',
      score: 0,
      notes: `Brand safety violation: ${safety.reason}`,
      issues: [safety.reason],
      suggestions: [],
      brand_safety_failure: true,
    };
  }

  // ── Phase A Step 2: Auto-fix quality issues ──
  const touchNumber = lead_context?.touch_number || 0;
  const maxWords = touchNumber > 0 ? 120 : 80;
  // Channel-aware autofix (2026-05-29 Phase 5): LinkedIn DMs must not carry an
  // email sign-off (the dominant hard-reject class). Derive the channel from
  // lead_context or the message row so the sign-off is stripped BEFORE the code
  // gates + the LLM Enforcer evaluate the body. All pipelines route review
  // through rangerReview, so fixing it here covers every path + the final body.
  let reviewChannel = lead_context?.channel || null;
  if (!reviewChannel && message_id) {
    try {
      const { rows } = await pool.query(
        `SELECT channel FROM messages WHERE id = $1 AND client_id = $2 LIMIT 1`,
        [message_id, clientId]
      );
      reviewChannel = rows[0]?.channel || null;
    } catch { /* non-fatal — fall back to channel-agnostic autofix */ }
  }
  const fixed = autoFixMessage(message_body, { touchNumber, maxWords, channel: reviewChannel });
  const fixedBody = fixed.body;
  const fixesApplied = fixed.fixes;

  if (fixesApplied.length > 0) {
    console.log(`[enforcer] Auto-fixed: ${fixesApplied.join(', ')}`);
    await logsService.createLog(clientId, {
      agent: 'ranger',
      action: 'message_autofixed',
      target_type: 'message',
      target_id: message_id,
      metadata: { fixes: fixesApplied },
    }).catch(() => {});
  }

  // ── Phase A Step 2.5: Deterministic gate sweep (post-autofix) ──
  // Catches anything autoFixMessage couldn't repair (e.g. word count not
  // trimmable because too few sentences). Replaces the duplicate auto-reject
  // gates we used to ask the LLM to enforce — the LLM was miscounting on both
  // Haiku and Sonnet. Code-level checks are deterministic by definition.
  const gateCheck = codeEnforcerGates(fixedBody, touchNumber);
  if (!gateCheck.passed) {
    console.warn(`[enforcer] Code-gate reject: ${gateCheck.reason}`);
    require('./learningEngine').postRangerRejection(clientId, {
      messageBody: fixedBody,
      notes: `Code-gate violation: ${gateCheck.reason}`,
      score: 0,
      channel: lead_context?.channel,
      leadIndustry: lead_context?.industry,
    }).catch(() => {});
    // Phase 4 rebuild plan (2026-05-12): feedback_events enforcer_rejected
    // capture on code-gate reject path (was missed in f86a0f5). Code gates
    // catch word-count, em-dash, multi-?, etc. — useful pattern data.
    require('./learningEngine').postFeedbackEvent(clientId, {
      leadId: lead_context?.lead_id || null,
      messageId: message_id || null,
      eventType: 'enforcer_rejected',
      signalStrengthAtTime: lead_context?.buying_signal_strength || null,
      sourceStrategy: lead_context?.source_strategy || null,
      segment: lead_context?.industry || null,
      channel: lead_context?.channel,
      touchNumber: lead_context?.touch_number ?? 0,
      rangerScore: 0,
      scoreDelta: -60,
      notes: `code_gate:${gateCheck.reason}`,
      payload: { failure_class: 'code_gate', reason: gateCheck.reason },
    }).catch(() => {});
    return {
      message_id,
      approved: false,
      decision: 'reject',
      score: 0,
      body: fixedBody,
      fixes_applied: fixesApplied,
      notes: `Code-gate violation: ${gateCheck.reason}`,
      issues: [gateCheck.reason],
      suggestions: [],
      reject_reason: gateCheck.reason,
      code_gate_failure: true,
    };
  }

  const evidenceGate = enforcerEvidenceGate({
    message_body: fixedBody,
    lead_context: {
      ...lead_context,
      message_id,
      channel: reviewChannel || lead_context?.channel,
    },
  });
  if (!evidenceGate.bypassed && !evidenceGate.approved) {
    console.warn(`[enforcer] Evidence-gate reject: ${evidenceGate.failed_rule}`);
    const repairState = repairPolicy.researchRepairState({
      repair_attempt: lead_context?.repair_attempt,
      max_repair_attempts: lead_context?.max_repair_attempts,
      metadata: { research_repair: lead_context?.research_repair || {} },
    });
    const signalPackage = getSignalPackage(lead_context);
    if (typeof pipeline.recordRepairRoute === 'function') {
      pipeline.recordRepairRoute(clientId, {
        lead_id: lead_context?.lead_id || null,
        message_id,
        pipeline_path: lead_context?.pipeline_path || 'unknown',
        agent: 'enforcer_beaver',
        source: 'enforcer_evidence_gate',
        channel: reviewChannel || lead_context?.channel || null,
        repair_route: evidenceGate.repair_route,
        failed_rule: evidenceGate.failed_rule,
        reason: evidenceGate.notes || evidenceGate.required_repair,
        repair_attempt: repairState.repairAttempt,
        max_repair_attempts: repairState.maxRepairAttempts,
        signal_package: signalPackage,
        metadata: {
          evidence_decision: evidenceGate.evidence_decision,
          failed_phrase: evidenceGate.failed_phrase,
          required_repair: evidenceGate.required_repair,
          missing_fields: evidenceGate.missing_fields || evidenceGate.issues || [],
        },
      }).catch(() => {});
    }
    let captainFallback = null;
    const repairExhausted = evidenceGate.repair_route === 'needs_research_repair'
      && repairPolicy.researchRepairExhausted(repairState);
    if (repairExhausted) {
      captainFallback = await captainFallbackDraft(clientId, {
        lead: {
          id: lead_context?.lead_id || null,
          name: lead_context?.name,
          company: lead_context?.company,
          title: lead_context?.title,
        },
        channel: reviewChannel || lead_context?.channel || 'email',
        reason: evidenceGate.required_repair || evidenceGate.notes,
        missing_fields: evidenceGate.missing_fields || evidenceGate.issues || [],
        rejected_body: fixedBody,
        signal_package: signalPackage,
      });
    }
    return {
      ...evidenceGate,
      message_id,
      body: fixedBody,
      fixes_applied: fixesApplied,
      repair_exhausted: repairExhausted,
      captain_fallback: captainFallback,
    };
  }

  // ── Phase A Step 3: Claude scores the FIXED version ──
  if (callAgent) {
    try {
      const persona = await getClientPersona(clientId);
      const personaContext = buildPersonaContext(persona);

      // Inject lead context so Enforcer can validate personalization is real
      const prevSummary = lead_context?.previous_messages_summary
        ? `- Touch number: ${lead_context.touch_number ?? 'unknown'} (this is a follow-up)\n- Previous messages in this sequence (VERIFIED — any 'Sent you a note...' style reference to these is NOT fabrication): ${lead_context.previous_messages_summary}\n`
        : '';
      const leadContextStr = lead_context?.name
        ? `LEAD CONTEXT (validate message is accurate for this person):\n- Name: ${lead_context.name}\n- Company: ${lead_context.company || 'Unknown'}\n- Title: ${lead_context.title || 'Unknown'}\n- Signal (why now): ${lead_context.signal || lead_context.why_now || 'Not specified'}\n- Angle: ${lead_context.angle || 'Not specified'}\n- Friction: ${lead_context.friction || 'Not specified'}\n${prevSummary}\n`
        : '';

      const result = await callAgent(
        'ranger',
        `Review this message:\n\n${leadContextStr}MESSAGE:\n${fixedBody}${personaContext}`,
        { message_id, clientId, channel: reviewChannel }
      );

      // Normalise new format { decision, score, breakdown, feedback, suggested_edit, reject_reason }
      // to include approved: boolean for backward compat with pipeline code
      if (result?.decision !== undefined) {
        // ── Phase A Step 4: Score floor lowered. Accept 40+ after auto-fix ──
        // Rationale: if we auto-fixed the mechanical issues, a 40+ score is a
        // message worth sending. Only hard brand-safety issues (checked above)
        // can kill a message now.
        let approved = result.decision === 'approve' || result.decision === 'approve_with_edits' || result.decision === 'approve_with_suggestions';
        const score = result.score || 0;
        if (!approved && score >= 40 && fixesApplied.length > 0) {
          // Post-autofix rescue: fixes applied + score passes floor → approve
          approved = true;
          result.decision = 'approve_with_edits';
          result.feedback = `${result.feedback || ''} [Auto-rescued: fixes=${fixesApplied.join(',')}, score=${score}]`.trim();
        }

        // Shared-memory capture on final rejection (fire-and-forget)
        if (!approved) {
          require('./learningEngine').postRangerRejection(clientId, {
            messageBody: fixedBody,
            notes: result.reject_reason || result.feedback,
            score,
            channel: lead_context?.channel,
            leadIndustry: lead_context?.industry,
          }).catch(() => {});

          // Phase 4 rebuild plan (2026-05-12): feedback_events enforcer_rejected
          // capture. Fire-and-forget. Feeds the cross-agent learning loop so the
          // weekly consumer cron can correlate rejection patterns with signals.
          require('./learningEngine').postFeedbackEvent(clientId, {
            leadId: lead_context?.lead_id || null,
            messageId: message_id || null,
            eventType: 'enforcer_rejected',
            signalStrengthAtTime: lead_context?.buying_signal_strength || (lead_context?.signal ? 'rich' : 'lite'),
            sourceStrategy: lead_context?.source_strategy || null,
            segment: lead_context?.industry || null,
            channel: lead_context?.channel,
            touchNumber: lead_context?.touch_number ?? 0,
            rangerScore: score,
            scoreDelta: score < 60 ? -(60 - score) : 0,
            notes: result.reject_reason || result.feedback,
          }).catch(() => {});
        }

        return {
          ...result,
          approved,
          body: fixedBody, // ← return the fixed body so caller saves the cleaned version
          fixes_applied: fixesApplied,
          notes: result.feedback || result.reject_reason || (approved ? null : `rejected:score=${score},decision=${result.decision}`),
          issues: result.reject_reason ? [result.reject_reason] : [],
          suggestions: result.suggested_edit ? [result.suggested_edit] : [],
          two_thoughts: result.two_thoughts || null, // Fix 5: borderline suggestions
        };
      }
      // Legacy format
      if (result?.approved !== undefined) {
        return { ...result, body: fixedBody, fixes_applied: fixesApplied };
      }
    } catch (err) {
      console.warn('[agents] Ranger failed:', err.message);
      await logMistake(clientId, 'ranger', 'Claude call failed during QA review', err.message, 'Ranger fail-CLOSED 2026-05-13 — message rejected pending manual review');
      // ── Fail-CLOSED 2026-05-13 (was fail-OPEN):
      // Enforcer cannot validate when Claude is unavailable. Reject the draft and surface
      // to MJ rather than auto-approving an unscored message at threshold-passing score.
      // Body still returned so MJ can inspect and manually approve if appropriate.
      return {
        message_id,
        approved: false,
        decision: 'reject',
        score: 0,
        body: fixedBody,
        fixes_applied: fixesApplied,
        notes: `Enforcer unavailable (Claude API failed) — rejected pending manual review. Auto-fix applied: ${fixesApplied.join(',') || 'none'}`,
        issues: ['enforcer_unavailable'],
        suggestions: [],
      };
    }
  }

  // No LLM agent available: fail closed and surface for manual review.
  return {
    message_id,
    approved: false,
    decision: 'reject',
    score: 0,
    body: fixedBody,
    fixes_applied: fixesApplied,
    notes: 'Enforcer unavailable (agent not configured) - blocked pending manual review',
    issues: ['enforcer_unavailable'],
    suggestions: [],
  };
}

function fallbackFirstName(name = '') {
  const clean = String(name || '').trim().replace(/[,()]/g, ' ');
  return clean.split(/\s+/).find(Boolean) || 'there';
}

function deterministicCaptainFallback({ lead = {}, channel = 'email', reason = null } = {}) {
  const first = fallbackFirstName(lead.name);
  const company = lead.company || 'your company';
  const rolePhrase = lead.title ? `the ${lead.title}` : 'a decision-maker';
  if (channel === 'linkedin' || channel === 'instagram') {
    return {
      subject: null,
      body: `Noticed you are ${rolePhrase} at ${company}. I could not verify a stronger timing signal, so keeping this direct: is outbound execution currently on your plate?`,
    };
  }
  return {
    subject: `${company}`,
    body: `Hi ${first},\n\nNoticed you are ${rolePhrase} at ${company}. I could not verify a stronger timing signal, so keeping this direct: is outbound execution currently on your plate?`,
    reason,
  };
}

async function captainFallbackDraft(clientId, {
  lead = {},
  channel = 'email',
  reason = null,
  missing_fields = [],
  rejected_body = '',
  signal_package = null,
} = {}) {
  await logsService.createLog(clientId, {
    agent: 'captain_beaver',
    action: 'captain_fallback_requested',
    target_type: 'lead',
    target_id: lead.id || null,
    metadata: { channel, reason, missing_fields, draftSource: 'captain_fallback' },
  }).catch(() => {});

  if (callAgent) {
    try {
      const prompt = `Research repair for this lead has already hit its bounded retry limit. Captain must write the manual-review draft now. Do not ask Enforcer to write the rescue draft. Do not invent missing evidence.

LEAD:
- Name: ${lead.name || 'Unknown'}
- Company: ${lead.company || 'Unknown'}
- Title: ${lead.title || 'Unknown'}
- Channel: ${channel}

FAILED RESEARCH REPAIR:
- Reason: ${reason || 'research_repair_exhausted'}
- Missing fields: ${Array.isArray(missing_fields) ? missing_fields.join(', ') : String(missing_fields || '')}
- Signal package: ${signal_package ? JSON.stringify(signal_package) : 'missing'}

LAST REJECTED BODY:
${rejected_body || '(none)'}

Write a conservative ${channel === 'email' ? 'cold email' : `${channel} DM`} that is honest about the limited timing evidence, asks exactly one diagnostic question, and is safe for MJ to review manually. Return JSON only: {"subject":null|string,"body":"..."}`;
      const result = await callAgent('captain_orchestrator', prompt, { clientId, mode: 'captain_fallback_draft' });
      const raw = typeof result === 'string'
        ? result
        : (result?.brief || result?.summary || result?.body || JSON.stringify(result));
      const cleaned = String(raw || '').replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed?.body && typeof parsed.body === 'string') {
        return {
          subject: parsed.subject || null,
          body: stripEmDashes(parsed.body),
          draftSource: 'captain_fallback',
          prompt_variant: 'captain_fallback',
          reason,
        };
      }
    } catch (err) {
      console.warn('[captain-fallback] Captain draft failed, using deterministic manual-review floor:', err.message);
    }
  }

  const fallback = deterministicCaptainFallback({ lead, channel, reason });
  return {
    ...fallback,
    body: stripEmDashes(fallback.body),
    draftSource: 'captain_fallback',
    prompt_variant: 'captain_fallback',
  };
}

/**
 * NEVER BURN A SOURCED LEAD (rule restored 2026-05-18, per MJ).
 *
 * When Sales Beaver's draft is rejected AND the Enforcer's own rewrite
 * (rangerDraft) also fails, the lead must NOT be discarded — real money was
 * spent sourcing it. The three fallback sites used to set the message to
 * 'ranger_rejected' with no approval row, which silently burned the lead.
 *
 * Instead: surface the best available draft to MJ's approval queue. He can
 * edit or approve it himself. Worst case is "needs your eyes", never "lost".
 * Returns true if the lead was surfaced.
 */
async function surfaceUnrewrittenDraft(clientId, {
  messageId,
  body,
  subject,
  reason,
  requestedBy = 'enforcer_rewrite_failed',
  agent = 'enforcer_beaver',
  action = 'lead_surfaced_unrewritten',
  note = null,
} = {}) {
  if (!messageId || !body || typeof body !== 'string') return false;
  try {
    const reviewNote = note
      || `Needs your review — Sales Beaver was rejected by the Enforcer and the auto-rewrite could not complete (${reason || 'quality gate'}). Edit or approve; the lead is preserved, not discarded.`;
    await pool.query(
      `UPDATE messages SET body = $1, subject = COALESCE($2, subject),
         status = 'pending_approval', ranger_score = COALESCE(ranger_score, 0),
         ranger_notes = $3, updated_at = NOW()
       WHERE id = $4 AND client_id = $5`,
      [body, subject ?? null, reviewNote, messageId, clientId]
    );
    await pool.query(
      `INSERT INTO approvals (client_id, message_id, requested_by, status)
       VALUES ($1, $2, $3, 'pending')`,
      [clientId, messageId, requestedBy]
    );
    await writeApprovalAuditForMessage(clientId, messageId, {
      decision: 'manual_pending',
      reason: reason || 'enforcer_rewrite_failed',
    });
    await logsService.createLog(clientId, {
      agent, action,
      target_type: 'message', target_id: messageId,
      metadata: { reason: reason || null, requested_by: requestedBy },
    }).catch(() => {});
    return true;
  } catch (err) {
    console.warn('[never-burn] surfaceUnrewrittenDraft failed:', err.message);
    return false;
  }
}

async function surfaceCaptainFallbackDraft(clientId, {
  messageId,
  lead,
  channel = 'email',
  reason,
  rejectedBody,
  subject,
  signalPackage = null,
  note = 'Captain fallback - Sales Beaver failed after bounded redrafts. Review before sending.',
} = {}) {
  if (!messageId || !lead) return false;
  const captainDraft = await captainFallbackDraft(clientId, {
    lead,
    channel,
    reason: reason || 'sales_redraft_exhausted',
    missing_fields: [],
    rejected_body: rejectedBody || '',
    signal_package: signalPackage,
  }).catch((err) => {
    console.warn(`[captain-fallback] Captain fallback draft failed for ${lead?.name || 'lead'}:`, err.message);
    return null;
  });
  if (!captainDraft?.body || typeof captainDraft.body !== 'string') return false;
  return surfaceUnrewrittenDraft(clientId, {
    messageId,
    body: captainDraft.body,
    subject: captainDraft.subject || subject,
    reason: reason || captainDraft.reason || 'sales_redraft_exhausted',
    requestedBy: 'captain_fallback',
    agent: 'captain_beaver',
    action: 'captain_fallback_draft',
    note,
  });
}

async function getFounderLeadSelectionDirectives(clientId) {
  try {
    const res = await pool.query(
      `SELECT rejection_reason, lead_context
       FROM founder_feedback
       WHERE client_id = $1
         AND feedback_type IN ('rejection', 'founder_note', 'borderline_skip')
         AND COALESCE(rejection_reason, '') ~* $2
       ORDER BY created_at DESC
       LIMIT 10`,
      [clientId, LEAD_SELECTION_REJECTION_SQL]
    );
    if (res.rows.length === 0) return null;
    return res.rows.map(row => {
      const ctx = row.lead_context || {};
      return `- ${ctx.name || 'Unknown'} at ${ctx.company || 'Unknown'}: ${row.rejection_reason}`;
    }).join('\n');
  } catch {
    return null;
  }
}

async function writeApprovalAuditForMessage(clientId, messageId, {
  decision = 'manual_pending',
  reason = null,
  model = process.env.MODEL_SONNET || 'claude-sonnet-4-20250514',
} = {}) {
  if (!clientId || !messageId) return;
  try {
    const { rows: [msg] } = await pool.query(
      `SELECT lead_id, channel, ranger_score FROM messages WHERE client_id = $1 AND id = $2 LIMIT 1`,
      [clientId, messageId]
    );
    if (!msg) return;
    await pool.query(
      `INSERT INTO approval_audit (client_id, message_id, lead_id, decision, score, reasons, model, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        clientId,
        messageId,
        msg.lead_id,
        decision,
        msg.ranger_score ?? null,
        JSON.stringify({ method: 'fallback_approval', reason }),
        model,
        msg.channel,
      ]
    );
  } catch (err) {
    console.warn('[approval_audit] fallback write failed:', err.message);
  }
}

/**
 * =========================
 * RANGER DRAFT (last resort)
 * =========================
 * Called when Sales Beaver fails all 3 Ranger attempts.
 * The Ranger writes the message itself using its own rules — guaranteed compliant.
 */
async function rangerDraft(clientId, { lead_name, lead_company, lead_title, lead_angle, lead_friction, rejected_body, channel = 'email' }) {
  if (!callAgent) return null;

  try {
    const [persona, fileConfig] = await Promise.all([
      getClientPersona(clientId),
      getClientConfig(clientId),
    ]);
    const personaContext = buildPersonaContext(persona);
    const fileContext = buildClientContext(fileConfig);

    const rangerSenderName = resolveSenderName(clientId, persona) || 'there';
    const isEmail = channel === 'email';
    const isLinkedIn = channel === 'linkedin';

    const channelInstructions = isEmail
      ? `Write a Day 0 cold EMAIL that passes ALL your own gates:
- Open with: Hi [first name only],
- Under 80 words (body only — do NOT count the "Hi [name]," line or the sign-off in word count)
- No em dashes (—) anywhere
- No bullet points
- Exactly 1 question
- No product or service name in opener
- No soft CTAs (no "worth a quick chat", "happy to jump on")
- Specific reference to a real signal about this company
- Reads like a human, not a vendor
- No banned phrases
- Close the email with "Regards," on one line, then "${rangerSenderName}" on the next line.`
      : isLinkedIn
        ? `Write a Day 0 cold LinkedIn DM that passes ALL your own gates:
- Exactly 3 lines, under 50 words total
- Line 1 starts with: Hi [first name only], saw you [specific signal].
- Line 2 gives short outbound context tied to one approved pain
- Line 3 is exactly 1 diagnostic question and the message ends there
- NO subject line
- NO sign-off, no "Regards,", no name at the end
- No em dashes (—), no bullet points
- No product or service name in the opener
- No soft CTAs, no banned phrases
- Specific reference to a real signal about this company
- Casual peer-to-peer voice, not a vendor`
      : `Write a SHORT ${channel} DM (this is a ${channel} message, NOT an email) that passes ALL your own gates:
- 2-3 sentences, under 50 words total
- NO subject line. NO "Hi [name]," greeting.
- NO sign-off — no "Regards,", no name at the end. End the message on the question.
- No em dashes (—), no bullet points
- Exactly 1 question
- No product or service name in the opener
- No soft CTAs, no banned phrases
- Specific reference to a real signal about this company
- Casual peer-to-peer voice, not a vendor`;

    const jsonShape = isEmail
      ? `Return JSON only: {"subject":"Subject line (max 6 words, no em dashes)","body":"Full email: Hi [name] greeting, body, one question, then close with Regards, then ${rangerSenderName}"}`
      : isLinkedIn
        ? `Return JSON only: {"subject":null,"body":"The three-line LinkedIn DM text: Hi [name], saw you [specific signal]. Then one short outbound-context line. Then one diagnostic question. No sign-off."}`
      : `Return JSON only: {"subject":null,"body":"The ${channel} DM text — 2-3 sentences, no greeting, no sign-off, ending on the question"}`;

    const result = await callAgent(
      'ranger',
      `Sales Beaver has failed your QA gate 3 times for this lead. You must now write the message yourself.

LEAD:
- Name: ${lead_name || 'Unknown'}
- Company: ${lead_company || 'Unknown'}
- Title: ${lead_title || 'Unknown'}
- Research angle: ${lead_angle || 'General operational pain'}
- Friction detected: ${lead_friction || 'Founder-led sales, pipeline inconsistency'}

Last rejected message (do NOT copy — write from scratch):
${rejected_body || '(none)'}

${channelInstructions}${personaContext}${fileContext}

${jsonShape}`,
      { mode: 'ranger_draft', lead_name, lead_company }
    );

    if (result?.body) {
      let finalSubject = result.subject || null;
      let finalBody = result.body;

      // Defense-in-depth: Haiku occasionally returns nested JSON in the body
      // field (same failure mode seen in salesGenerate). Unwrap it here so
      // downstream callers always get a clean string body, never a nested
      // JSON blob. Without this, callers that store the returned body
      // directly into messages.body end up with literal {"subject":"...","body":"..."}
      // text in the approval queue.
      if (typeof finalBody === 'string' && /^\s*\{[\s\S]*?"body"\s*:/.test(finalBody)) {
        try {
          const inner = JSON.parse(finalBody);
          if (typeof inner?.body === 'string' && inner.body.trim().length > 0) {
            console.warn(`[agents] rangerDraft returned nested JSON body for ${lead_name} — unwrapping`);
            finalBody = inner.body;
            if (!finalSubject && typeof inner?.subject === 'string') {
              finalSubject = inner.subject;
            }
          }
        } catch (err) {
          console.warn(`[agents] rangerDraft nested-JSON parse failed for ${lead_name}: ${err.message}`);
        }
      }

      const cleanBody = stripEmDashes(finalBody); // safety net even on Ranger's own draft
      // A1-4: the Enforcer's own fallback draft is NOT exempt from the code
      // gates. Run them so callers stamp an HONEST score, not a blind 70.
      const gate = codeEnforcerGates(cleanBody, 0);
      return {
        subject: finalSubject,
        body: cleanBody,
        score: gate.passed ? 70 : 45,
        gateReason: gate.passed ? null : gate.reason,
      };
    }
    return null;
  } catch (err) {
    console.warn('[agents] Ranger draft failed:', err.message);
    await logMistake(clientId, 'ranger', 'Ranger draft failed after Sales Beaver exhausted attempts', err.message, 'Lead needs manual message from user');
    return null;
  }
}

/**
 * =========================
 * DIRECTOR — PLAN
 * =========================
 */
/**
 * Pre-screen a Director command for things that are explicitly out of scope.
 * Returns a plain message string if the command should be rejected, null otherwise.
 */
function screenCommand(command) {
  // Ranger bypass attempts
  if (/\b(skip|bypass|without|disable|remove|ignore)\s+(the\s+)?ranger\b/i.test(command) ||
      /\bno\s+ranger\b/i.test(command) ||
      /\bskip\s+qa\b/i.test(command)) {
    return "The Ranger review is a mandatory quality gate and cannot be skipped or bypassed. Every message must pass Ranger's QA check before it reaches your approval queue. This protects you from sending non-compliant, low-quality, or off-brand messages — it's a core safety feature of BeavrDam.\n\nIf Ranger keeps rejecting messages, try asking me to adjust the messaging style instead.";
  }

  // Direct personal notification email (not outreach)
  // Pattern: "email me", "email us", "send me an email", "email [person]@[domain]"
  // but NOT if the command also mentions leads/outreach/campaign/companies (that's sales)
  const isOutreach = /\b(lead|leads|campaign|outreach|prospect|company|companies|target|find|search)\b/i.test(command);
  const isDirectEmail = /\b(email|send\s+an?\s+email|notify|message)\s+(me|us|them|[a-zA-Z]+\s+and\s+[a-zA-Z]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+)\b/i.test(command);

  if (isDirectEmail && !isOutreach) {
    return "I'm built to run sales outreach campaigns, not send one-off notification emails to specific people.\n\nThe pipeline is: I find leads → Sales Beaver drafts messages → Ranger reviews → you approve → email sends.\n\nFor campaigns, try something like:\n• \"Find 10 VPs of Engineering at B2B SaaS companies and reach out\"\n• \"Target fintech startups in London with a cold email sequence\"\n\nIf you need to send a manual email outside the pipeline, you can do that directly from your Gmail account.";
  }

  return null;
}

async function getSearchProviderCapacity(clientId) {
  const { CAPS, providerUsageToday } = require('./spendGuard');
  const providers = [
    {
      provider: 'brave',
      configured: !!process.env.BRAVE_API_KEY,
      cap: CAPS.brave,
      spent: await providerUsageToday('brave', clientId).catch(() => CAPS.brave),
    },
    {
      provider: 'google_cse',
      configured: !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX),
      cap: CAPS.google_cse,
      spent: await providerUsageToday('google_cse', clientId).catch(() => CAPS.google_cse),
    },
  ];

  const withRemaining = providers.map(p => ({
    ...p,
    remaining: Math.max(0, (Number(p.cap) || 0) - (Number(p.spent) || 0)),
    usable: p.configured && (Number(p.cap) || 0) > (Number(p.spent) || 0),
  }));

  return {
    hasCapacity: withRemaining.some(p => p.usable),
    providers: withRemaining,
    remainingPaidQueries: withRemaining.reduce((sum, p) => sum + (p.usable ? p.remaining : 0), 0),
  };
}

function minPaidQueriesForExternalTarget(target) {
  const n = Math.max(1, Number(target) || 1);
  return Math.max(4, n * 4);
}

function buildSignalFirstSourcingPlan(remainingTarget, campaignSearchBudgetRemaining) {
  const target = Math.max(0, Math.ceil(Number(remainingTarget) || 0));
  const availableBudget = Math.max(0, Math.floor(Number(campaignSearchBudgetRemaining) || 0));
  if (target === 0 || availableBudget === 0) {
    return { paidQueryBudget: 0, maxSignalLeads: 0, bufferLeads: 0 };
  }

  const desiredBuffer = Math.min(2, target);
  const idealBudget = Math.max(3, (target * 2) + desiredBuffer);
  const paidQueryBudget = Math.min(availableBudget, idealBudget);
  const maxSignalLeads = Math.max(1, Math.min(target + desiredBuffer, Math.floor(paidQueryBudget / 2)));

  return {
    paidQueryBudget,
    maxSignalLeads,
    bufferLeads: Math.max(0, maxSignalLeads - target),
  };
}

function normalisePaidSignalCap(maxPaidSignalQueries) {
  if (maxPaidSignalQueries === null || maxPaidSignalQueries === undefined || maxPaidSignalQueries === '') {
    return null;
  }
  const n = Number(maxPaidSignalQueries);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function allowsPaidPersonalisation(allowPaidSignal, maxPaidSignalQueries) {
  if (allowPaidSignal === false) return false;
  return normalisePaidSignalCap(maxPaidSignalQueries) !== 0;
}

async function directorPlan(clientId, { command, source }) {
  // Pre-screen before calling AI or building a plan
  const rejection = screenCommand(command);
  if (rejection) {
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'command_out_of_scope',
      metadata: { command, reason: rejection.split('\n')[0] },
    });
    return {
      plan_id: uuidv4(),
      command,
      status: 'out_of_scope',
      message: rejection,
    };
  }

  // Extract requested lead count from command — e.g. "Find 3 leads" → 3.
  // Ignore version/date/time fragments such as V2.1 before looking for counts.
  // Default: pull daily target from DB, fallback to 50 if not set.
  let requestedCount = parseRequestedLeadCount(command, null);
  if (requestedCount === null) {
    // Use daily KPI target as default lead count for bare "kickoff"
    try {
      const today = todayInMalaysia();
      const { rows } = await pool.query(
        `SELECT target FROM daily_kpi WHERE client_id = $1 AND date = $2 LIMIT 1`,
        [clientId, today]
      );
      requestedCount = rows[0]?.target || 50;
    } catch { requestedCount = 50; }
  }

  // Check how many uncontacted leads already exist in DB (DB-first info for plan)
  let uncontactedCount = 0;
  try {
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM leads l
       WHERE l.client_id = $1 AND l.deleted_at IS NULL AND l.status = 'new'
         AND NOT EXISTS (
           SELECT 1 FROM messages m
            WHERE m.lead_id = l.id AND m.client_id = $1
              AND m.status IN (
                'pending_ranger', 'pending_approval', 'approved',
                'pending_send', 'sending', 'sent', 'delivered',
                'linkedin_requested', 'awaiting_accept'
              )
         )`,
      [clientId]
    );
    uncontactedCount = count;
  } catch { /* ignore */ }

  const planId = uuidv4();
  const [icp, persona, fileConfig, memoryBrief] = await Promise.all([
    directorGetICP(clientId),
    getClientPersona(clientId),
    getClientConfig(clientId),
    // MEMORY: Build full shared context brief at kickoff (Sprint 9)
    buildDirectorMemoryBrief(clientId),
  ]);

  // ── MyClaw as Captain Beaver (Option B) ──────────────────
  // ── Captain Beaver (Claude) handles all planning ─────────────
  // MyClaw (OpenClaw/OpenAI) has been retired. Captain Beaver is the sole brain.
  if (callAgent) {
    try {
      const icpContext = Object.keys(icp).length > 0
        ? `\n\nClient ICP Profile:\n${JSON.stringify(icp, null, 2)}`
        : '';
      const personaContext = buildPersonaContext(persona);
      const fileContext = buildClientContext(fileConfig);
      const result = await callAgent('director', command + icpContext + personaContext + fileContext + memoryBrief);

      if (result?.status === 'clarification_needed') {
        return {
          plan_id: planId,
          command,
          status: 'clarification_needed',
          message: result.question || result.message || 'Could you give me a bit more detail so I can brief the crew properly?',
        };
      }

      if (result?.steps) {
        return {
          plan_id: planId,
          command,
          interpretation: result.interpretation || command,
          steps: result.steps,
          status: 'pending_approval',
          estimated_leads: result.estimated_leads || requestedCount,
          estimated_time: result.estimated_time || '~5 min',
        };
      }
    } catch (err) {
      console.warn('[agents] Director failed:', err.message);
      await logMistake(clientId, 'director', 'Plan generation failed', err.message, 'Simplify command or check ICP configuration');
    }
  }

  // Build plan steps — mention DB-first if there are uncontacted leads
  const steps = [];
  if (uncontactedCount > 0) {
    steps.push({ step: 1, agent: 'research_beaver', action: `Process ${uncontactedCount} existing leads from database first`, status: 'pending' });
    steps.push({ step: 2, agent: 'research_beaver', action: 'Search for additional leads if needed (Brave)', status: 'pending' });
  } else {
    steps.push({ step: 1, agent: 'research_beaver', action: 'Search for companies matching ICP (Brave)', status: 'pending' });
  }
  steps.push({ step: steps.length + 1, agent: 'sales_beaver', action: 'Generate personalised outreach for each lead', status: 'pending' });
  steps.push({ step: steps.length + 1, agent: 'ranger', action: 'QA review all generated messages', status: 'pending' });
  steps.push({ step: steps.length + 1, agent: 'director', action: 'Auto-approve + enqueue for send', status: 'pending' });

  return {
    plan_id: planId,
    command,
    interpretation: command,
    steps,
    status: 'pending_approval',
    estimated_leads: requestedCount,
    estimated_time: uncontactedCount > 0 ? `~${Math.ceil(requestedCount / 5)} min (${uncontactedCount} from DB)` : `~${Math.ceil(requestedCount / 5)} min`,
    db_leads_available: uncontactedCount,
  };
}

/**
 * =========================
 * EMAIL ENRICHMENT
 * =========================
 */
async function enrichLeadsWithHunter(clientId, leads) {
  if (!leads || leads.length === 0) return leads;

  const { findEmail } = require('./emailEnrichment');

  const enriched = [];
  for (const lead of leads) {
    // Skip if email already set (e.g. from Apollo)
    if (lead.email) {
      enriched.push(lead);
      continue;
    }

    try {
      const nameParts = (lead.name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      const result = await findEmail({
        name: lead.name,
        company: lead.company,
        first_name: firstName,
        last_name: lastName,
        domain: lead.domain || null,
        clientId,
      });

      if (result?.email) {
        console.log(`[emailEnrichment] Found ${result.email} for ${lead.name} at ${lead.company} (source: ${result.email_source}, confidence: ${result.confidence})`);
        enriched.push({
          ...lead,
          email: result.email,
          email_verified: result.status === 'deliverable',
          email_source: result.email_source || 'findemail',
        });
        continue;
      }

      enriched.push(lead); // save lead without email — can be enriched manually later
    } catch (err) {
      console.warn(`[emailEnrichment] Enrichment failed for ${lead.name}:`, err.message);
      enriched.push(lead); // always save the lead even without email
    }
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'hunter_enrichment_complete',
    metadata: {
      total: leads.length,
      enriched: enriched.filter(l => ['hunter', 'pattern+verify', 'pattern+catch_all', 'scrape+pattern', 'scrape'].includes(l.email_source)).length,
    },
  });

  return enriched;
}

/**
 * =========================
 * CAPTAIN — FINAL VALIDATION GATE
 * =========================
 * Hard checks before pushing a message to the approval queue.
 * Returns { valid: true } or { valid: false, fixed_body, notes }
 */
async function captainValidate(clientId, lead, message) {
  const PLACEHOLDER_RE = /\[NAME\]|\[COMPANY\]|\{\{|\}\}/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const issues = [];

  // Hard check: lead name
  if (!lead.name || lead.name === 'Unknown Contact') issues.push('Lead name is missing or Unknown Contact');

  // Hard check: lead company
  if (!lead.company || lead.company === 'Unknown Company') issues.push('Lead company is missing or Unknown Company');

  // Hard check: at least one contact method
  const hasEmail = lead.email && EMAIL_RE.test(lead.email);
  const hasLinkedIn = !!lead.linkedin_url;
  if (!hasEmail && !hasLinkedIn) issues.push('No valid email or linkedin_url for this lead');

  // Hard check: message body
  if (!message.body || !message.body.trim()) issues.push('Message body is empty');

  // Hard check: placeholder text
  if (message.body && PLACEHOLDER_RE.test(message.body)) issues.push('Message body contains unfilled placeholders');

  if (issues.length === 0) return { valid: true };

  // Try to fix with Claude if available
  if (callAgent && message.body) {
    try {
      const fixResult = await callAgent(
        'director',
        `A message for ${lead.name || 'a prospect'} at ${lead.company || 'a company'} has these issues that must be fixed before it can be sent:
${issues.map((i, n) => `${n + 1}. ${i}`).join('\n')}

Original message:
${message.body}

Rules:
- Replace any [NAME], [COMPANY], {{, }} placeholders with real values from the lead info above
- Ensure personalisation is specific and real, not generic
- Keep under 80 words (body excluding greeting and sign-off)
- No em dashes, no bullet points, exactly 1 question

Lead info: Name=${lead.name || 'unknown'}, Company=${lead.company || 'unknown'}, Title=${lead.title || 'unknown'}

Return JSON only: {"body":"fixed message body including greeting and sign-off","notes":"what was fixed"}`,
        { mode: 'captain_fix', lead_id: lead.id }
      );

      if (fixResult?.body) {
        return {
          valid: false,
          fixed_body: stripEmDashes(fixResult.body),
          notes: fixResult.notes || `Captain fixed: ${issues.join('; ')}`,
        };
      }
    } catch (err) {
      console.warn('[captain] captainValidate rewrite failed:', err.message);
    }
  }

  return {
    valid: false,
    fixed_body: null,
    notes: `Captain validation failed: ${issues.join('; ')}`,
  };
}

/**
 * Phase C helper: run the Sales + Enforcer pipeline on leads that were already
 * saved by signal hunt. Skips research, Captain gates, and Hunter enrichment.
 * Returns a summary compatible with directorExecute.
 */
async function processExistingLeadsPipeline(clientId, plan_id, leads, options = {}) {
  const originalLeadCount = Array.isArray(leads) ? leads.length : 0;
  leads = Array.isArray(leads) ? leads : [];
  const { allowPersonalisationSearch = true } = options;

  // ── Same-day enrolled dedup (MYT calendar day) ──────────────────────────
  // Once enrolled today, never re-enrolled today. Prevents the 75× pattern.
  const { rows: recentEnrolled } = await pool.query(
    `SELECT DISTINCT lead_id FROM pipeline_traces
     WHERE client_id = $1 AND stage = 'enrolled'
       AND (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date`,
    [clientId]
  ).catch(() => ({ rows: [] }));
  const recentEnrolledSet = new Set(recentEnrolled.map(r => r.lead_id));
  const dedupedLeads = leads.filter(l => !recentEnrolledSet.has(l.id));
  const skippedSameDay = leads.length - dedupedLeads.length;
  if (dedupedLeads.length < leads.length) {
    console.log(`[signal-pipeline] Same-day dedup: skipped ${skippedSameDay}/${leads.length} already-enrolled leads`);
  }
  leads = dedupedLeads;

  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'signal_pipeline_executing',
    metadata: { plan_id, lead_count: leads.length, original_lead_count: originalLeadCount, skipped_same_day: skippedSameDay },
  });

  if (leads.length === 0) {
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'signal_pipeline_skipped',
      metadata: {
        plan_id,
        reason: skippedSameDay > 0 ? 'same_day_enrolled_dedupe' : 'no_leads_provided',
        original_lead_count: originalLeadCount,
        skipped_same_day: skippedSameDay,
      },
    });
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'signal_pipeline_completed',
      metadata: { plan_id, leads: 0, drafted: 0, approved: 0, rejected: 0, skipped_same_day: skippedSameDay },
    });
    pipelineTrace.traceStage(clientId, {
      kickoff_id: plan_id,
      stage: 'enrolled',
      status: 'kickoff_summary',
      agent: 'director',
      pipeline_path: 'signal_pipeline',
      metadata: {
        total_leads: 0,
        original_lead_count: originalLeadCount,
        skipped_same_day: skippedSameDay,
        drafted: 0,
        approved: 0,
        rejected: 0,
        silent_drop_count: 0,
      },
    }).catch(() => {});
    return {
      plan_id,
      status: 'completed',
      leads: 0,
      summary: { leads_found: 0, messages_drafted: 0, approved: 0, rejected: 0, skipped_same_day: skippedSameDay },
      source: 'signal_hunt',
    };
  }

  // ── Phase 1 (2026-05-08): pipeline_traces — emit enrolled for every lead ─
  for (const lead of leads) {
    pipelineTrace.traceStage(clientId, {
      lead_id: lead.id,
      kickoff_id: plan_id,
      stage: 'enrolled',
      status: 'success',
      agent: 'director',
      pipeline_path: 'signal_pipeline',
      metadata: { company: lead.company, title: lead.title, has_email: !!lead.email },
    }).catch(() => {});
  }

  // ── Phase 5.5 (2026-05-06): ICP audit at draft-time ──────────────────────
  // Closes the chat-tool gap surfaced during E2E validation: legacy MNC leads
  // (dentsu Malaysia, IPG Mediabrands, MDEC, Publicis Groupe etc.) sourced
  // before the MNC blocklist expansion were still being picked by run_campaign
  // because only the kickoff path was running pool-audit.
  // Re-applying applyIcpV2Filter here catches them before draft cycles burn.
  // Phase 2 Step 4 (2026-05-08): per-lead audit + soft-delete + log + trace
  // consolidated into pipeline.icpGateSoftDelete. Behaviour identical.
  const auditedLeads = [];
  let icpAuditRejected = 0;
  for (const lead of leads) {
    const result = await pipeline.icpGateSoftDelete(clientId, lead, {
      applyIcpV2Filter,
      kickoff_id: plan_id,
      pipeline_path: 'signal_pipeline',
      audit_source: 'processExistingLeadsPipeline_phase_5_5',
    });
    if (result.pass) {
      auditedLeads.push(lead);
    } else {
      icpAuditRejected++;
    }
  }
  if (icpAuditRejected > 0) {
    console.log(`[signal-pipeline] ICP audit rejected ${icpAuditRejected}/${leads.length} legacy leads at draft-time`);
  }
  leads = auditedLeads;

  let approvedCount = 0;
  let rejectedCount = 0;
  let captainFallbackCount = 0;
  let messagesDrafted = 0;
  let skippedCount = 0;
  let channelExhaustedCount = 0;

  for (const lead of leads) {
    // ── Phase 2 Step 7 (Jules F-03): unified path behind PIPELINE_V2_ENABLED.
    // Flag OFF (default) → the inline loop below runs unchanged.
    if (pipeline.isV2Enabled()) {
      const r = await pipeline.processLead(clientId, lead, {
        pipelinePath: 'signal_pipeline',
        kickoffId: plan_id,
        allowPersonalisationSearch,
        deps: {
          salesGenerate, rangerReview, rangerDraft, captainDraft: captainFallbackDraft, selectChannel, autoFixMessage,
          brandSafetyCheck, searchPersonalisationSignals, recordOutcome, attributionFromLead,
          stripEmDashes, applyIcpV2Filter, hunterService,
          channelHints: CHANNEL_HINTS,
          beaverState: require('./beaverState'),
        },
      });
      if (r.outcome === 'approved') { approvedCount++; messagesDrafted++; }
      else if (r.outcome === 'manual_review') { messagesDrafted++; if (r.viaCaptainFallback) captainFallbackCount++; }
      else if (r.outcome === 'rejected' || r.outcome === 'brand_safety_rejected') { rejectedCount++; messagesDrafted++; }
      else if (r.outcome === 'blocked_no_email') { messagesDrafted++; }
      continue;
    }
    try {
      // ── P0-D (2026-05-10): per-lead draft-failure circuit breaker ──────
      // If this lead has failed drafting 3+ times in the last 24h, skip it.
      // Prevents the ddc09f6a pattern: 30 draft_failed in 35 min ($0.535 burned).
      const { rows: failRows } = await pool.query(
        `SELECT COUNT(*)::int AS fails FROM pipeline_traces
         WHERE client_id = $1 AND lead_id = $2 AND stage = 'draft_failed'
           AND created_at > NOW() - INTERVAL '24 hours'`,
        [clientId, lead.id]
      ).catch(() => ({ rows: [{ fails: 0 }] }));
      if (failRows[0].fails >= 3) {
        console.warn(`[signal-pipeline] Circuit breaker: ${lead.name} has ${failRows[0].fails} draft_failed in 24h — skipping`);
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id, kickoff_id: plan_id,
          stage: 'draft_failed', status: 'circuit_breaker_skip',
          agent: 'director', pipeline_path: 'signal_pipeline',
          metadata: { recent_failures: failRows[0].fails },
        }).catch(() => {});
        continue;
      }

      // Build Sales Beaver context from the signal metadata
      const meta = lead.metadata || {};
      const contextParts = [
        `Name: ${lead.name}`,
        `Company: ${lead.company}`,
        `Title: ${lead.title || 'Unknown'}`,
      ];
      if (meta.signal)   contextParts.push(`Signal (why reaching out now): ${meta.signal}`);
      if (meta.why_now)  contextParts.push(`Why now: ${meta.why_now}`);
      if (meta.angle)    contextParts.push(`Angle to lead with: ${meta.angle}`);
      if (meta.signal_type) contextParts.push(`Signal type: ${meta.signal_type}`);
      // A1-18: signal pipeline now passes the same context fields the kickoff pipeline does.
      if (lead.linkedin_url) contextParts.push(`LinkedIn: ${lead.linkedin_url}`);
      if (lead.short_description || meta.short_description) contextParts.push(`About: ${lead.short_description || meta.short_description}`);
      if (meta.friction) contextParts.push(`Friction point: ${meta.friction}`);
      if (meta.notes) contextParts.push(`Personalisation hook: ${meta.notes}`);
      if (!meta.signal && meta.snippet) contextParts.push(`LinkedIn profile snippet: ${meta.snippet}`);
      if (meta.search_query) contextParts.push(`Search context: ${meta.search_query}`);

      // Search for personalisation signals before drafting only when the run
      // explicitly allows it and Research has already supplied the V2.1 package.
      // Otherwise Sales must route to Research repair, not patch missing evidence
      // with ad hoc open-web queries.
      const hasSignalPackageForSearch = !!getSignalPackage(lead);
      if (allowPersonalisationSearch && hasSignalPackageForSearch) {
        await assertLlmBudgetOpen(clientId);
        try {
          const signals = await searchPersonalisationSignals(lead);
          if (signals.length > 0) {
            contextParts.push('');
            contextParts.push('RECENT SIGNALS (from web search — reference these if relevant):');
            for (const s of signals) {
              const dateStr = s.date ? ` (${s.date})` : '';
              contextParts.push(`- ${s.text}${dateStr} [source: ${s.source}]`);
            }
            console.log(`[sales-personalise] Found ${signals.length} signals for ${lead.name} at ${lead.company}`);
          }
        } catch (err) {
          console.warn(`[sales-personalise] Skipped for ${lead.name}:`, err.message);
        }
      } else {
        console.log(`[sales-personalise] Skipping open-web personalization for ${lead.name}: ${allowPersonalisationSearch ? 'missing signal_package' : 'paid signal disabled'}`);
      }

      // ── Email-priority rule ─────────────────────────────────────────────
      // If the lead has no email, use the autonomous order: public web/domain
      // evidence -> Hunter -> MillionVerifier-backed pattern verification.
      // LinkedIn is used only when no usable email is available.
      await pipeline.enrichEmail(clientId, lead, {
        pipeline_path: 'signal-pipeline',
        hunterService,
      });

      // ── Channel selection ── single source of truth in selectChannel()
      // 2026-05-13: compute linkedinAlreadyTried like kickoff_pipeline (agents.js:3253-3271)
      // so signal_pipeline doesn't redundantly attempt LinkedIn when a prior attempt exists.
      let linkedinAlreadyTried_sp = false;
      if (!lead.email && lead.linkedin_url) {
        const prevLinkedinRes_sp = await pool.query(
          `SELECT id FROM messages
            WHERE client_id = $1 AND lead_id = $2 AND channel = 'linkedin'
              AND status NOT IN ('deleted')
            LIMIT 1`,
          [clientId, lead.id]
        );
        linkedinAlreadyTried_sp = prevLinkedinRes_sp.rows.length > 0;
      }
      const channelChoice_sp = selectChannel(lead, { linkedinAlreadyTried: linkedinAlreadyTried_sp });
      const channel = channelChoice_sp.channel;
      let kickoffMessageStatus = channelChoice_sp.status;
      if (kickoffMessageStatus === 'channel_exhausted') {
        skippedCount++;
        channelExhaustedCount++;
        console.log(`[signal-pipeline] ${lead.name} — channel exhausted, skipping draft: ${channelChoice_sp.reason}`);
        await logsService.createLog(clientId, {
          agent: 'director', action: 'lead_channel_exhausted',
          target_type: 'lead', target_id: lead.id,
          metadata: { reason: channelChoice_sp.reason, path: 'signal_pipeline', lead_name: lead.name, channel },
        }).catch(() => {});
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id, kickoff_id: plan_id,
          stage: 'skipped', status: 'channel_exhausted',
          agent: 'director', pipeline_path: 'signal_pipeline',
          reason: channelChoice_sp.reason,
          metadata: { lead_name: lead.name, channel },
        }).catch(() => {});
        continue;
      }
      if (channelChoice_sp.status === 'blocked_no_email') {
        // 2026-05-23 SHORT-CIRCUIT (lead-completeness contract):
        // Incomplete leads — no verified email AND no usable LinkedIn — must
        // NEVER reach Sales Beaver. Previously code logged the trace then fell
        // through to draftWithFallback + persistDraft, burning Sonnet tokens
        // and creating wasted message rows. Lead now stays in `prospecting`
        // until Research Beaver enriches an email or a new LinkedIn lever
        // opens. Captain re-queues on demand via the event-driven enrichment
        // path.
        console.log(`[signal-pipeline] ${lead.name} — incomplete (no usable channel), skipping draft`);
        await logsService.createLog(clientId, {
          agent: 'director', action: 'lead_incomplete',
          target_type: 'lead', target_id: lead.id,
          metadata: { reason: channelChoice_sp.reason, path: 'signal_pipeline', lead_name: lead.name },
        }).catch(() => {});
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id, kickoff_id: plan_id,
          stage: 'skipped', status: 'blocked_no_email',
          agent: 'director', pipeline_path: 'signal_pipeline',
          reason: channelChoice_sp.reason,
          metadata: { lead_name: lead.name },
        }).catch(() => {});
        skippedCount++;
        continue;
      }

      if (channel === 'linkedin') {
        const prevLinkedinRes = await pool.query(
          `SELECT id FROM messages WHERE client_id = $1 AND lead_id = $2 AND channel = 'linkedin' AND status NOT IN ('deleted') LIMIT 1`,
          [clientId, lead.id]
        );
        if (prevLinkedinRes.rows.length > 0) {
          skippedCount++;
          channelExhaustedCount++;
          console.log(`[signal-pipeline] ${lead.name} — LinkedIn already tried, Hunter found nothing — skipping`);
          pipelineTrace.traceStage(clientId, {
            lead_id: lead.id, kickoff_id: plan_id,
            stage: 'skipped', status: 'channel_exhausted',
            agent: 'director', pipeline_path: 'signal_pipeline',
            metadata: { lead_name: lead.name, channel },
          }).catch(() => {});
          continue;
        }
      }

      // ── Phase 3 pivot (2026-05-08): pre-draft lead readiness gate ─────
      // Don't burn Sales Beaver tokens on leads with missing name / company /
      // contact-method. Mirrors the kickoff pipeline guard added the same commit.
      // Both pipelines now converge on Enforcer-only post-draft review.
      const readiness_sp = pipeline.leadReadinessGate(lead);
      if (!readiness_sp.ready) {
        console.warn(`[signal-pipeline] Pre-draft skip: ${lead.name || 'unknown'} @ ${lead.company || 'unknown'} — ${readiness_sp.reason}`);
        await logsService.createLog(clientId, {
          agent: 'director', action: 'lead_not_ready',
          target_type: 'lead', target_id: lead.id,
          metadata: { reason: readiness_sp.reason, channel, path: 'signal_pipeline' },
        }).catch(() => {});
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          kickoff_id: plan_id,
          stage: 'icp_rejected',
          status: 'lead_not_ready',
          agent: 'director',
          reason: readiness_sp.reason,
          pipeline_path: 'signal_pipeline',
          metadata: { lead_name: lead.name, lead_company: lead.company },
        }).catch(() => {});
        continue;
      }

      // ── Dedup guard BEFORE draft (saves Sonnet tokens) ─────────────────
      // Moved ahead of draftWithFallback: if lead already has an active message,
      // skip immediately. Previously this ran AFTER the Sonnet call, burning
      // $0.018/call on leads that would just get discarded.
      const existingActive = await pipeline.checkActiveMessage(clientId, lead.id);
      if (existingActive) {
        console.warn(`[signal-pipeline] Dedup guard: ${lead.name} already has an active message — skipping`);
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          kickoff_id: plan_id,
          stage: 'draft_skipped',
          status: 'dedup_guard',
          agent: 'director',
          reason: `Lead already has active message (id: ${existingActive.id || 'unknown'})`,
          pipeline_path: 'signal_pipeline',
          metadata: { lead_name: lead.name, channel, existing_message_id: existingActive.id || null },
        }).catch(() => {});
        continue;
      }

      // Sales Beaver + Captain fallback via pipeline.draftWithFallback.
      const draft = await pipeline.draftWithFallback(clientId, {
        lead_id: lead.id,
        channel,
        // Jules F-03: append channel instructions like the kickoff path does,
        // so signal-pipeline drafts get the same channel-shaping the best leads deserve.
        context: contextParts.join('\n') + (CHANNEL_HINTS[channel] ? `\n\nCHANNEL INSTRUCTIONS: ${CHANNEL_HINTS[channel]}` : ''),
        salesGenerate,
        rangerDraft,
        captainDraft: captainFallbackDraft,
        enableEnforcerFallback: true,
        lead,
        leadAngle: meta.angle,
        leadFriction: meta.friction,
        pipeline_path: 'signal-pipeline',
        kickoff_id: plan_id,
        defaultDraftSource: 'signal_hunt',
      });
      if (!draft) {
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          kickoff_id: plan_id,
          stage: 'draft_failed',
          status: 'sales_and_fallback_null',
          agent: 'sales_beaver',
          pipeline_path: 'signal_pipeline',
          metadata: { lead_name: lead.name, channel },
        }).catch(() => {});
        continue;
      }
      const salesResult = { prompt_variant: draft.prompt_variant };
      const draftBody = draft.body;
      const draftSubject = draft.subject;
      const draftSource = draft.draftSource;
      const draftRequiresManualReview = draft.manualReview === true || draftSource === 'captain_fallback';
      const effectiveLead = draft.lead && typeof draft.lead === 'object' ? draft.lead : lead;
      const effectiveMeta = safeJsonObject(effectiveLead.metadata);
      const effectiveSignalPackage = draft.signal_package || effectiveMeta.signal_package || meta.signal_package || null;
      const effectiveResearchRepair = draft.research_repair || effectiveMeta.research_repair || meta.research_repair || null;
      const effectiveSignal = effectiveMeta.signal || meta.signal || null;
      const effectiveWhyNow = effectiveMeta.why_now || meta.why_now || null;
      const evidenceMetadata = {
        ...(effectiveSignalPackage ? { signal_package: effectiveSignalPackage } : {}),
        ...(effectiveResearchRepair ? { research_repair: effectiveResearchRepair } : {}),
      };

      // Phase 2 Step 2 (2026-05-08): persistDraft is the single source of truth
      // for INSERT INTO messages. Composes metadata (source, signal, prompt_variant,
      // blocked_reason) and emits pipeline_traces 'drafted' internally — the
      // explicit traceStage call previously here is removed.
      const msg = await pipeline.persistDraft(clientId, {
        lead_id: lead.id,
        channel,
        subject: draftSubject,
        body: draftBody,
        status: draftRequiresManualReview ? 'pending_approval' : kickoffMessageStatus,
        draft_source: draftSource,
        prompt_variant: salesResult?.prompt_variant,
        signal: effectiveSignal,
        metadata: {
          ...(draftRequiresManualReview ? { captain_fallback_reason: draft.reason || null } : {}),
          ...evidenceMetadata,
        },
        kickoff_id: plan_id,
        pipeline_path: 'signal_pipeline',
      });

      // Phase D piece 2 — outcome attribution: drafted event (signal-pipeline path)
      recordOutcome(clientId, {
        outcome: 'drafted',
        leadId: lead.id,
        messageId: msg.id,
        channel,
        ...attributionFromLead(effectiveLead),
        eventData: { source_path: 'signal_pipeline', status: draftRequiresManualReview ? 'pending_approval' : kickoffMessageStatus, draft_source: draftSource },
      });

      // (Phase 2 Step 2: drafted trace now emitted internally by pipeline.persistDraft above)

      messagesDrafted++;

      if (draftRequiresManualReview) {
        await pool.query(
          `INSERT INTO approvals (client_id, message_id, requested_by, status)
           VALUES ($1, $2, 'captain_fallback', 'pending')`,
          [clientId, msg.id]
        ).catch(() => {});
        await logsService.createLog(clientId, {
          agent: 'captain_beaver',
          action: 'captain_fallback_draft',
          target_type: 'message',
          target_id: msg.id,
          metadata: { lead_name: lead.name, channel, reason: draft.reason || null, pipeline_path: 'signal_pipeline' },
        }).catch(() => {});
        continue;
      }

      // If blocked, skip Ranger and downstream processing — message is on hold for enrichment.
      if (kickoffMessageStatus === 'blocked_no_email') {
        continue;
      }

      // Run auto-fix + Enforcer
      const fixed = autoFixMessage(msg.body, { touchNumber: 0, maxWords: 80 });
      if (fixed.fixes.length > 0) {
        await pool.query(
          `UPDATE messages SET body = $1 WHERE id = $2`,
          [fixed.body, msg.id]
        );
      }

      const safety = brandSafetyCheck(fixed.body, {
        name: effectiveLead.name || lead.name, company: effectiveLead.company || lead.company, title: effectiveLead.title || lead.title,
        signal: effectiveSignal, why_now: effectiveWhyNow,
      });

      if (!safety.safe) {
        await pool.query(
          `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1 WHERE id = $2`,
          [`Brand safety: ${safety.reason}`, msg.id]
        );
        // Phase 5.5: log to mistake_memory so future drafts for same company avoid this
        pool.query(
          `INSERT INTO mistake_memory (client_id, lead_id, agent, mistake_type, description, payload)
           VALUES ($1, $2, 'sales_beaver', 'brand_safety_fail', $3, $4::jsonb)`,
          [clientId, lead.id, `Brand safety failed for ${lead.company}: ${safety.reason}`,
           JSON.stringify({ company: lead.company, reason: safety.reason, message_id: msg.id })]
        ).catch(() => {});
        // Phase 1 (2026-05-08): pipeline_traces brand_safety reject (signal_pipeline)
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          message_id: msg.id,
          kickoff_id: plan_id,
          stage: 'rejected',
          status: 'brand_safety',
          agent: 'sales_beaver',
          reason: safety.reason,
          pipeline_path: 'signal_pipeline',
          metadata: { company: lead.company, channel },
        }).catch(() => {});
        rejectedCount++;
        continue;
      }

      let rangerResult;
      let rangerFailedClosed = false;
      try {
        rangerResult = await rangerReview(clientId, {
          message_id: msg.id,
          message_body: fixed.body,
          lead_context: {
            name: effectiveLead.name || lead.name, company: effectiveLead.company || lead.company, title: effectiveLead.title || lead.title,
            email: effectiveLead.email || lead.email, lead_id: lead.id,
            signal: effectiveSignal, angle: effectiveMeta.angle || meta.angle, why_now: effectiveWhyNow,
            signal_package: effectiveSignalPackage,
            research_repair: effectiveResearchRepair,
            channel,
            pipeline_path: 'signal_pipeline',
          },
        });
      } catch (err) {
        // Fail-CLOSED 2026-05-13: cannot validate when Enforcer is down. Reject and surface to MJ.
        rangerResult = { approved: false, score: 0, notes: 'Enforcer unavailable — manual review required', body: fixed.body };
        rangerFailedClosed = true;
      }

      // Phase 1 (2026-05-08): pipeline_traces reviewed (Enforcer ran or failed-closed)
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id,
        message_id: msg.id,
        kickoff_id: plan_id,
        stage: 'reviewed',
        status: rangerFailedClosed ? 'fail_closed_enforcer_unavailable' : (rangerResult?.approved ? 'approved' : 'rejected'),
        agent: 'enforcer_beaver',
        score: rangerResult?.score ?? null,
        reason: rangerResult?.notes || null,
        pipeline_path: 'signal_pipeline',
        metadata: { channel, fail_closed: rangerFailedClosed },
      }).catch(() => {});

      let finalBody = rangerResult?.body || fixed.body;
      let finalSubject = draftSubject;

      if (rangerResult?.approved) {
        // ── Enforcer approved → auto-approve / borderline / manual decision ──
        // Phase 2 Step 6 (Jules F-11): the ~180-line decision + persistence block
        // is now pipeline.applyEnforcerDecision — one definition, both pipelines.
        await pipeline.applyEnforcerDecision(clientId, {
          msg,
          lead: effectiveLead,
          rangerResult,
          finalBody,
          subject: finalSubject,
          kickoffId: plan_id,
          pipelinePath: 'signal_pipeline',
          source: 'signal_pipeline',
        });
        approvedCount++;
      } else {
        if (rangerResult?.repair_route === 'needs_research_repair') {
          if (rangerResult?.captain_fallback?.body) {
            await surfaceUnrewrittenDraft(clientId, {
              messageId: msg.id,
              body: rangerResult.captain_fallback.body,
              subject: rangerResult.captain_fallback.subject || finalSubject,
              reason: rangerResult?.notes || 'research_repair_exhausted',
              requestedBy: 'captain_fallback',
              agent: 'captain_beaver',
              action: 'captain_fallback_draft',
              note: 'Captain fallback — Research repair already exhausted. Review before sending.',
            });
          } else {
            await pool.query(
              `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1 WHERE id = $2 AND client_id = $3`,
              [rangerResult?.required_repair || rangerResult?.notes || 'Routed to Research repair; Sales redraft skipped until Research repairs the lead.', msg.id, clientId]
            );
          }
          continue;
        }

        const MAX_SIGNAL_RANGER_RETRIES = 2;
        for (let retryAttempt = 0; retryAttempt < MAX_SIGNAL_RANGER_RETRIES && !rangerResult?.approved; retryAttempt++) {
          const rejectionFeedback = rangerResult?.reject_reason || rangerResult?.notes || 'Message did not pass quality gates';
          const feedbackContext = [
            contextParts.join('\n'),
            '',
            `PREVIOUS ATTEMPT REJECTED: ${rejectionFeedback}`,
            `Previous message that was rejected:\n${finalBody}`,
            '',
            'Rewrite the message fixing the issue above. Do NOT repeat the same product-pitch structure.',
            'CRITICAL: Day 0 email body 50-60 words MAX. Lead with the real buying signal, then one pain-led question.',
          ].join('\n');

          let redraft = null;
          try {
            redraft = await salesGenerate(clientId, { lead_id: lead.id, channel, context: feedbackContext });
          } catch (redraftErr) {
            console.warn(`[signal-pipeline] Sales redraft ${retryAttempt + 1} failed for ${lead.name}:`, redraftErr.message);
          }
          if (!redraft?.body) break;

          const redraftBody = typeof stripEmDashes === 'function' ? stripEmDashes(redraft.body) : redraft.body;
          const retryFixed = autoFixMessage(redraftBody, { touchNumber: 0, maxWords: 80 });
          finalBody = retryFixed.body;
          finalSubject = redraft.subject || finalSubject;
          await pool.query(
            `UPDATE messages
                SET body = $1,
                    subject = $2,
                    ranger_attempt_count = $3,
                    ranger_notes = $4,
                    status = 'pending_ranger',
                    updated_at = NOW()
              WHERE id = $5 AND client_id = $6`,
            [
              finalBody,
              finalSubject,
              retryAttempt + 1,
              `Signal redraft ${retryAttempt + 1}: fixing - ${rejectionFeedback}`,
              msg.id,
              clientId,
            ]
          );
          rangerResult = await rangerReview(clientId, {
            message_id: msg.id,
            message_body: finalBody,
            lead_context: {
              name: lead.name, company: lead.company, title: lead.title,
              email: lead.email, lead_id: lead.id,
              signal: effectiveSignal, angle: effectiveMeta.angle || meta.angle, why_now: effectiveWhyNow,
              signal_package: effectiveSignalPackage,
              research_repair: effectiveResearchRepair,
              channel,
              pipeline_path: 'signal_pipeline',
            },
          });
          pipelineTrace.traceStage(clientId, {
            lead_id: lead.id,
            message_id: msg.id,
            kickoff_id: plan_id,
            stage: 'reviewed',
            status: rangerResult?.approved ? 'approved_after_redraft' : 'rejected_after_redraft',
            agent: 'enforcer_beaver',
            score: rangerResult?.score ?? null,
            reason: rangerResult?.notes || null,
            pipeline_path: 'signal_pipeline',
            metadata: { channel, redraft_attempt: retryAttempt + 1 },
          }).catch(() => {});
          const beaverStateService = require('./beaverState');
          if (beaverStateService && typeof beaverStateService.recordImprovementAfterFeedback === 'function') {
            beaverStateService.recordImprovementAfterFeedback(clientId, {
              lead_id: lead.id,
              original_message_id: msg.id,
              retry_message_id: msg.id,
              original_reject_reason: rejectionFeedback,
              retry_passed: rangerResult?.approved === true,
            }).catch(() => {});
          }
        }

        if (rangerResult?.approved) {
          await pipeline.applyEnforcerDecision(clientId, {
            msg,
            lead: effectiveLead,
            rangerResult,
            finalBody: rangerResult?.body || finalBody,
            subject: finalSubject,
            kickoffId: plan_id,
            pipelinePath: 'signal_pipeline',
            source: 'signal_pipeline',
          });
          approvedCount++;
          continue;
        }
        if (rangerResult?.repair_route === 'needs_research_repair') {
          if (rangerResult?.captain_fallback?.body) {
            await surfaceUnrewrittenDraft(clientId, {
              messageId: msg.id,
              body: rangerResult.captain_fallback.body,
              subject: rangerResult.captain_fallback.subject || finalSubject,
              reason: rangerResult?.notes || 'research_repair_exhausted',
              requestedBy: 'captain_fallback',
              agent: 'captain_beaver',
              action: 'captain_fallback_draft',
              note: 'Captain fallback — Research repair already exhausted. Review before sending.',
            });
          } else {
            await pool.query(
              `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1 WHERE id = $2 AND client_id = $3`,
              [rangerResult?.required_repair || rangerResult?.notes || 'Routed to Research repair after Sales redraft.', msg.id, clientId]
            );
          }
          continue;
        }
        // Sales exhausted its bounded redraft loop. Captain owns the final
        // manual-review salvage; Enforcer remains a reviewer, not the writer.
        const finalRejectReason = rangerResult?.notes || 'Sales Beaver failed after bounded redrafts';
        console.warn(`[signal-pipeline] Enforcer rejected ${lead.name}: ${finalRejectReason} — Captain drafting fallback`);
        await pool.query(
          `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1 WHERE id = $2`,
          [finalRejectReason, msg.id]
        );
        // Phase 5.5: log hard rejects (score < 60) to mistake_memory for cross-agent context
        if ((rangerResult?.score ?? 100) < 60) {
          pool.query(
            `INSERT INTO mistake_memory (client_id, lead_id, agent, mistake_type, description, payload)
             VALUES ($1, $2, 'sales_beaver', 'enforcer_hard_reject', $3, $4::jsonb)`,
            [clientId, lead.id,
             `Enforcer hard-rejected draft for ${lead.company} (score ${rangerResult?.score ?? '?'}): ${rangerResult?.notes || 'no notes'}`,
             JSON.stringify({
               company: lead.company,
               score: rangerResult?.score,
               notes: rangerResult?.notes,
               channel,
               message_id: msg.id,
             })]
          ).catch(() => {});
        }

        const surfaced = await surfaceCaptainFallbackDraft(clientId, {
          messageId: msg.id,
          lead: effectiveLead,
          channel,
          reason: finalRejectReason,
          rejectedBody: finalBody,
          subject: finalSubject || draftSubject,
          signalPackage: effectiveSignalPackage,
        });
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          message_id: msg.id,
          kickoff_id: plan_id,
          stage: surfaced ? 'reviewed' : 'rejected',
          status: surfaced ? 'captain_fallback_manual_review' : 'captain_fallback_failed',
          agent: 'captain_beaver',
          score: rangerResult?.score ?? null,
          reason: finalRejectReason,
          pipeline_path: 'signal_pipeline',
          metadata: { channel, redraft_attempts: MAX_SIGNAL_RANGER_RETRIES },
        }).catch(() => {});
        if (surfaced) captainFallbackCount++;
        else rejectedCount++;
      }
    } catch (err) {
      if (isBudgetExceededError(err)) {
        console.error(`[signal-pipeline] Budget cap abort while processing ${lead.name}:`, err.message);
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          kickoff_id: plan_id,
          stage: 'draft_failed',
          status: 'budget_exceeded_abort',
          agent: 'director',
          reason: err.message,
          pipeline_path: 'signal_pipeline',
          metadata: { lead_name: lead.name },
        }).catch(() => {});
        throw err;
      }
      console.error(`[signal-pipeline] Error processing ${lead.name}:`, err.message);
      // Phase 1 hotfix (2026-05-09): unexpected errors were invisible in funnel.
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id,
        kickoff_id: plan_id,
        stage: 'draft_failed',
        status: 'unexpected_error',
        agent: 'director',
        pipeline_path: 'signal_pipeline',
        metadata: { lead_name: lead.name, error: err.message },
      }).catch(() => {});
    }
  }

  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'signal_pipeline_completed',
    metadata: { plan_id, leads: leads.length, drafted: messagesDrafted, approved: approvedCount, captain_fallback: captainFallbackCount, rejected: rejectedCount, skipped: skippedCount, channel_exhausted: channelExhaustedCount, original_lead_count: originalLeadCount, skipped_same_day: skippedSameDay },
  });

  // ── Phase 1 (2026-05-08): emit pipeline_traces summary so funnel survival rate
  // is computable without joining logs.metadata. The per-lead traces above + this
  // summary together let `getKickoffSurvival` produce the report directly.
  pipelineTrace.traceStage(clientId, {
    kickoff_id: plan_id,
    stage: 'enrolled',
    status: 'kickoff_summary',
    agent: 'director',
    pipeline_path: 'signal_pipeline',
    metadata: {
      total_leads: leads.length,
      drafted: messagesDrafted,
      approved: approvedCount,
      captain_fallback: captainFallbackCount,
      rejected: rejectedCount,
      icp_audit_rejected: icpAuditRejected,
      skipped_same_day: skippedSameDay,
      skipped_count: skippedCount,
      channel_exhausted_count: channelExhaustedCount,
      silent_drop_count: Math.max(0, leads.length - messagesDrafted - rejectedCount - skippedCount),
    },
  }).catch(() => {});

  // ─── Daily KPI report to Captain (Sales + Enforcer perspectives) ──
  // Mirrors the cold-research path in directorExecute. Without this, the
  // signal-pipeline kickoff would never report agent perspective to
  // Captain — and signal-pipeline IS the dominant kickoff path when pool
  // has cached leads. Same shape as the cold-research report.
  try {
    const beaverState = require('./beaverState');
    const passRate = messagesDrafted > 0
      ? Math.round((approvedCount / messagesDrafted) * 100)
      : null;

    beaverState.reportDailyKPIs(clientId, 'sales_beaver', {
      drafted: messagesDrafted,
      approved_first_pass: approvedCount,
      first_pass_rate_pct: passRate,
      run_kind: 'signal_pipeline',
      plan_id,
    }).catch(err => console.warn('[sales_beaver] daily KPI report failed:', err.message));

    beaverState.reportDailyKPIs(clientId, 'ranger', {
      reviewed: messagesDrafted,
      approved: approvedCount,
      rejected: rejectedCount,
      approve_rate_pct: passRate,
      run_kind: 'signal_pipeline',
      plan_id,
    }).catch(err => console.warn('[ranger] daily KPI report failed:', err.message));
  } catch (err) {
    console.warn('[signal-pipeline] beaverState KPI wiring failed:', err.message);
  }

  return {
    plan_id,
    status: 'completed',
    leads: leads.length,
    summary: { leads_found: leads.length, messages_drafted: messagesDrafted, approved: approvedCount, captain_fallback: captainFallbackCount, rejected: rejectedCount, skipped: skippedCount, channel_exhausted: channelExhaustedCount },
    source: 'signal_hunt',
  };
}

/**
 * =========================
 * DIRECTOR — EXECUTE (full pipeline)
 * =========================
 */
function klDateString() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function claimDailyPaidSignalAttempt(clientId, { sourceMode, plan_id, maxPaidSignalQueries }) {
  if (sourceMode !== 'daily_web_linkedin_topup') return true;
  const key = `${sourceMode}_${klDateString()}`;
  const { rows } = await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
     VALUES ($1, 'director', $2, $3::jsonb, 'state', NOW())
     ON CONFLICT (client_id, agent, key) DO NOTHING
     RETURNING id`,
    [
      clientId,
      key,
      JSON.stringify({
        plan_id,
        source_mode: sourceMode,
        max_paid_signal_queries: maxPaidSignalQueries,
        claimed_at: new Date().toISOString(),
      }),
    ]
  );
  const claimed = rows.length > 0;
  if (!claimed) {
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'daily_web_linkedin_topup_deduped',
      metadata: { plan_id, key, source_mode: sourceMode, boundary: 'one_topup_attempt_per_myt_day' },
    }).catch(() => {});
  }
  return claimed;
}

async function directorExecute(clientId, {
  plan_id,
  command,
  batchIndex = 0,
  limit,
  use_existing_leads = null,
  completionAttempt = 0,
  maxCompletionAttempts = 2,
  requestedTarget = null,
  deliveredSoFar = 0,
  draftedSoFar = 0,
  rejectedSoFar = 0,
  leadsFoundSoFar = 0,
  allowPaidSignal = true,
  sourceMode = 'manual_campaign',
  maxPaidSignalQueries = null,
}) {
  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'plan_executing',
    metadata: { plan_id, batchIndex, signal_sourced: !!use_existing_leads, allow_paid_signal: allowPaidSignal, source_mode: sourceMode },
  });

  // ── Beavers read Captain's morning brief at run start ───────────────
  // Surfaces today's directives (TASKS / ACTIONS TAKEN / NEEDS YOUR CALL)
  // so Sales Beaver context knows the strategy bet of the day, fresh
  // market signals from Phase E, and Captain's threshold tuning calls.
  // Logged for debugging — actual consumption is via getMemory() lookups
  // from the per-beaver prompt builders (research, sales, enforcer).
  try {
    const beaverState = require('./beaverState');
    const captainBrief = await beaverState.readCaptainBrief(clientId).catch(() => null);
    if (captainBrief) {
      console.log(`[director] Loaded Captain brief from agent_memory (${(captainBrief.summary || '').length} chars summary)`);
    } else {
      console.log('[director] No Captain brief in agent_memory — beavers run without daily directive');
    }

    // Also surface today's market signals (Phase E) so Sales Beaver can
    // reference them as personalization seeds when drafting.
    const today = todayInMalaysia();
    const marketRes = await pool.query(
      `SELECT content FROM agent_memory
        WHERE client_id = $1 AND agent = 'market_sensor' AND key = $2
        LIMIT 1`,
      [clientId, `market_signals_${today}`]
    ).catch(() => ({ rows: [] }));
    const oppCount = marketRes.rows[0]?.content?.opportunities?.length || 0;
    if (oppCount > 0) {
      console.log(`[director] Phase E: ${oppCount} fresh market opportunities available for personalization`);
    }
  } catch (err) {
    console.warn('[director] beaverState brief read failed (non-fatal):', err.message);
  }

  // ── Phase C: Signal-sourced path ─────────────────────────────
  // If use_existing_leads is provided, skip research entirely and feed those
  // lead IDs straight to Sales Beaver + Enforcer. Signal detection IS the gate.
  if (use_existing_leads && Array.isArray(use_existing_leads) && use_existing_leads.length > 0) {
    console.log(`[director] Signal-sourced mode: processing ${use_existing_leads.length} pre-saved leads`);
    try {
      const { rows: signalLeads } = await pool.query(
        `SELECT * FROM leads WHERE client_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
        [clientId, use_existing_leads]
      );
      if (signalLeads.length === 0) {
        console.warn('[director] use_existing_leads returned no rows, falling through to cold research');
      } else {
        // Jump directly to Sales/Enforcer pipeline using these leads
        return await processExistingLeadsPipeline(clientId, plan_id, signalLeads, {
          allowPersonalisationSearch: allowsPaidPersonalisation(allowPaidSignal, maxPaidSignalQueries),
        });
      }
    } catch (err) {
      console.error('[director] Signal-sourced path failed:', err.message);
      // fall through to cold research
    }
  }

  // ── Phase 2 V2 Step 8 (2026-05-08): cold-research producer/consumer redirect ─
  //
  // When DIRECTOR_INLINE_RESEARCH_DISABLED=true, instead of running cold research
  // inline (the path below this block, ~line 2205+), queue a research_directive
  // for Research Beaver's autonomous loop to pick up next cycle. Caller's
  // signature is preserved — returns { plan_id, status: 'queued' } so the 12+
  // callers across routes/agents.js, routes/autonomous.js continue working.
  //
  // Default OFF — preserves existing behaviour. Flip via Railway env var after
  // 24h shadow validation confirms Research Beaver consumer logic is reliable.
  // Phase 2 V2 Step 9 (5-day validation gate): delete the cold-research code
  // below this block once flag has been ON for 5 consecutive days clean.
  //
  // Step 8b (2026-05-09): dbBuilder consumer wired — reads cold_research_request
  // directives and executes queued search query in the autonomous 15-min loop.
  if (process.env.DIRECTOR_INLINE_RESEARCH_DISABLED === 'true' && command) {
    const directivesSvc = require('./directives');
    console.log(`[director] Cold-research INLINE DISABLED — queuing as research_directive: "${command}"`);
    try {
      await directivesSvc.writeDirective(
        clientId,
        'db_builder',
        'cold_research_request',
        { command, limit: limit ?? null, plan_id, batchIndex },
        {
          reason: `Cold research command queued via directorExecute redirect: "${command}"`,
          severity: 'normal',
          expiresInHours: 24,
        }
      );
    } catch (err) {
      console.error('[director] Failed to queue research_directive:', err.message);
      // Fall through — better to run cold research inline than silently lose the command.
      // (The flag's whole point is to NOT lose work; if directive write fails, we degrade gracefully.)
    }

    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'cold_research_queued',
      metadata: {
        plan_id, command, limit,
        reason: 'DIRECTOR_INLINE_RESEARCH_DISABLED',
        consumer: 'db_builder',
      },
    }).catch(() => {});

    return {
      success: true,
      queued: true,
      plan_id,
      status: 'queued',
      message: `Research directive queued. Research Beaver will process within ~15 minutes.`,
    };
  }

  // ── Diagnostics: track counts at each filtering stage ──
  const diagnostics = {
    research_source: null,
    search_query: null,
    raw_from_research: 0,
    after_title_filter: 0,
    after_verification_gate: 0,
    after_icp_gate: 0,
    after_dedup: 0,
    saved: 0,
    messages_drafted: 0,
    messages_failed: 0,
    reason: null,
  };

  // Cross-agent memory: Captain reads ALL agent memories at kickoff
  let memoryContext = '';
  try {
    const { rows: memories } = await pool.query(
      `SELECT agent, key, content FROM agent_memory
       WHERE client_id = $1 AND memory_type != 'secret'
       ORDER BY updated_at DESC LIMIT 20`,
      [clientId]
    );
    if (memories.length > 0) {
      const memLines = memories.slice(0, 5).map(m =>
        `[${m.agent}/${m.key}]: ${JSON.stringify(m.content).substring(0, 300)}`
      );
      const rawMemory = '\n\nAGENT MEMORY CONTEXT:\n' + memLines.join('\n');
      memoryContext = rawMemory.substring(0, 2000);
    }
  } catch (err) {
    console.warn('[director] Failed to load agent memory context:', err.message);
    memoryContext = '\n\n[MEMORY UNAVAILABLE — previous context could not be loaded]';
  }

  // Load ICP memory for the ICP gate below — must be in directorExecute scope
  const icpMemory = await getMemory(clientId, 'director', 'icp') || {};

  // ── ICP Pre-flight check ─────────────────────────────────
  // Captain Beaver rule: before ANY kickoff, confirm ICP is defined in memory.
  //
  // IMPORTANT: The previous implementation allowed keyword-in-command to satisfy
  // this gate ("malaysia agency founder" in the text would bypass the check even
  // when icpMemory was empty). This was exactly how off-ICP leads slipped through:
  // command-level keyword matches don't feed Research Beaver's query builder —
  // Research reads icpMemory directly and falls back to DEFAULT_INDUSTRIES (SaaS,
  // training, fintech, global) when memory is empty. Result: US/UK leads in a
  // Malaysia-only ICP.
  //
  // Now we require actual icpMemory to have the three fields populated. If the
  // user hasn't configured ICP (via migration seed, UI, or API PUT), we block.
  const hasIndustry = !!(icpMemory.industries);
  const hasGeo = !!(icpMemory.geographies || icpMemory.location);
  const hasTitle = !!(icpMemory.job_titles || icpMemory.who);

  const missingIcpFields = [];
  if (!hasIndustry) missingIcpFields.push('industries');
  if (!hasGeo) missingIcpFields.push('geographies');
  if (!hasTitle) missingIcpFields.push('job_titles');

  if (missingIcpFields.length > 0) {
    const icpQuestion = `Before I brief the crew, I need a bit more context. Your ICP is missing: ${missingIcpFields.join(', ')}. Could you tell me: who exactly are we targeting (title/role), what industry/sector, and which geography? This helps Research Beaver find the right leads.`;

    // Store question in agent_memory so frontend can surface it
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'director', $2, $3::jsonb, 'config', NOW())
       ON CONFLICT (client_id, agent, key)
       DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
      [clientId, `icp_question_${plan_id}`, JSON.stringify({ question: icpQuestion, missing: missingIcpFields, asked_at: new Date().toISOString() })]
    );

    await updateExecStatus(clientId, plan_id, {
      status: 'needs_input',
      phase: 'captain',
      question: icpQuestion,
      missing_fields: missingIcpFields,
      started_at: new Date().toISOString(),
      beavers: {
        research: { status: 'idle', task: 'Waiting for ICP', found: 0, passed: 0 },
        sales:    { status: 'idle', task: 'Waiting', drafted: 0, approved: 0 },
        enforcer: { status: 'idle', task: 'Waiting', reviewed: 0, rejected: 0 },
        captain:  { status: 'working', task: 'Checking ICP pre-flight', approved: 0 },
      },
      progress: { total: 0, complete: 0 },
    });

    // Poll for user answer up to 60 seconds (6 attempts × 10s), then proceed
    const MAX_POLL_ATTEMPTS = 6;
    let icpAnswered = false;
    for (let poll = 0; poll < MAX_POLL_ATTEMPTS; poll++) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      const answerRow = await getMemory(clientId, 'director', `icp_answer_${plan_id}`);
      if (answerRow && answerRow.answer) {
        // Merge answer into icpMemory and proceed
        if (answerRow.industries) icpMemory.industries = answerRow.industries;
        if (answerRow.geographies) icpMemory.geographies = answerRow.geographies;
        if (answerRow.job_titles) icpMemory.job_titles = answerRow.job_titles;
        icpAnswered = true;
        await logsService.createLog(clientId, {
          agent: 'director',
          action: 'icp_answer_received',
          metadata: { plan_id, answer: answerRow },
        });
        break;
      }
    }

    if (!icpAnswered) {
      // Timeout: Captain proceeds with best judgment, logs assumption
      const assumption = `ICP answer not received within 15 min. Proceeding with command context and defaults. Command: "${command || 'none'}"`;
      await logsService.createLog(clientId, {
        agent: 'director',
        action: 'icp_preflight_timeout',
        metadata: { plan_id, missing: missingIcpFields, assumption },
      });
      console.warn('[captain] ICP pre-flight timeout — proceeding with best judgment:', assumption);
    }
  }

  // Post-ICP-check status update
  await updateExecStatus(clientId, plan_id, {
    status: 'executing',
    phase: 'research',
    beavers: {
      research: { status: 'working', task: 'Starting lead search', found: 0, passed: 0 },
      sales:    { status: 'idle', task: 'Waiting for leads', drafted: 0, approved: 0 },
      enforcer: { status: 'idle', task: 'Waiting', reviewed: 0, rejected: 0 },
      captain:  { status: 'done', task: 'ICP pre-flight complete', approved: 0 },
    },
    progress: { total: 0, complete: 0 },
    started_at: new Date().toISOString(),
  });

  // ── Step 0: DB-first — process uncontacted leads already in pipeline ──
  // Check for existing leads that haven't had messages drafted yet.
  // Process fresh DB leads first, then source only the approval-ready output
  // shortfall. This keeps "find 5" tied to delivered approvals, not attempts.
  const commandTarget = parseRequestedLeadCount(command, null);
  const targetLimit = limit || commandTarget || 50;
  const campaignRequested = Number(requestedTarget) || targetLimit;

  let dbLeadsCount = 0;
  let dbPipelineResult = null;
  let dbApprovedCount = 0;
  let dbDraftedCount = 0;
  let dbRejectedCount = 0;
  let dbSkippedCount = 0;
  let signalLeadsCount = 0;
  let signalPipelineLeadCount = 0;
  let signalApprovedCount = 0;
  let signalDraftedCount = 0;
  let signalRejectedCount = 0;
  let signalSkippedCount = 0;
  let remainingTarget = targetLimit;

  try {
    // 2026-05-14: NOT EXISTS narrowed to ACTIVE-state messages only.
    // Was: any prior message excluded the lead (even rejected drafts), creating
    // a permanent dead-state where leads with old filter/prompt rejections could
    // never be re-attempted. After the 2026-05-14 filter narrow + Research Beaver
    // prompt rewrite, those rejected drafts no longer reflect current ICP — leads
    // should be retryable. Now only ACTIVE messages (sent / approved / queued /
    // pending) block re-drafting. Rejected drafts no longer permanently kill a lead.
    const { rows: uncontactedLeads } = await pool.query(
      `SELECT l.* FROM leads l
       WHERE l.client_id = $1
         AND l.deleted_at IS NULL
         AND l.status = 'new'
         AND l.pipeline_stage = 'prospecting'
         AND NULLIF(BTRIM(l.name), '') IS NOT NULL
         AND NULLIF(BTRIM(l.company), '') IS NOT NULL
         AND LOWER(BTRIM(l.company)) NOT IN ('unknown', 'unknown company', 'independent', 'self-employed', 'self employed', 'stealth', 'confidential')
         AND (l.email IS NOT NULL OR l.linkedin_url IS NOT NULL)
         AND (
           (l.email IS NOT NULL AND (l.email_verified IS TRUE OR l.email_source = 'hunter'))
           OR (
             l.linkedin_url IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM messages ml
                WHERE ml.client_id = $1
                  AND ml.lead_id = l.id
                  AND ml.channel = 'linkedin'
                  AND ml.status NOT IN ('deleted')
             )
           )
         )
         AND (
           SELECT COUNT(*)::int
             FROM messages mr
            WHERE mr.client_id = $1
              AND mr.lead_id = l.id
              AND mr.status IN ('rejected', 'ranger_rejected')
         ) < 2
          AND NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.lead_id = l.id AND m.client_id = $1
              AND m.status IN (
                'pending_ranger', 'pending_approval', 'approved',
                'pending_send', 'sending', 'sent', 'delivered',
                'linkedin_requested', 'awaiting_accept'
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM pipeline_traces pt
            WHERE pt.client_id = $1 AND pt.lead_id = l.id
              AND pt.stage = 'enrolled'
              AND (pt.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date =
                  (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
          )
          ${leadSelectionFeedbackExclusionSql('l')}
        ORDER BY
         CASE
           WHEN l.email IS NOT NULL AND (l.email_verified IS TRUE OR l.email_source = 'hunter') THEN 0
           ELSE 1
         END,
         CASE l.signal_tier WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
         l.created_at DESC
       LIMIT $2`,
      [clientId, targetLimit]
    );

    if (uncontactedLeads.length > 0) {
      dbLeadsCount = uncontactedLeads.length;
      console.log(`[director] DB-first: found ${dbLeadsCount} uncontacted leads — handing to Sales Beaver while researching gap`);
      diagnostics.research_source = 'database_first';

      await updateExecStatus(clientId, plan_id, {
        status: 'executing',
        phase: 'sales',
        beavers: {
          research: { status: 'working', task: `Processing ${dbLeadsCount} DB leads + searching for more`, found: dbLeadsCount, passed: dbLeadsCount },
          sales:    { status: 'working', task: 'Drafting messages for existing leads', drafted: 0, approved: 0 },
          enforcer: { status: 'idle', task: 'Waiting', reviewed: 0, rejected: 0 },
          captain:  { status: 'done', task: 'DB-first + parallel research', approved: 0 },
        },
        progress: { total: dbLeadsCount, complete: 0 },
      });

      // Completion-driven: process DB leads first, then source only the actual
      // output shortfall. Enrolled/drafted leads do not satisfy MJ's requested count.
      dbPipelineResult = await processExistingLeadsPipeline(clientId, plan_id, uncontactedLeads, {
        allowPersonalisationSearch: allowsPaidPersonalisation(allowPaidSignal, maxPaidSignalQueries),
      })
        .catch(err => {
          console.error('[director] DB-first pipeline failed:', err.message);
          return null;
        });

      dbApprovedCount = Number(dbPipelineResult?.summary?.approved) || 0;
      dbDraftedCount = Number(dbPipelineResult?.summary?.messages_drafted) || 0;
      dbRejectedCount = Number(dbPipelineResult?.summary?.rejected) || 0;
      dbSkippedCount = Number(dbPipelineResult?.summary?.skipped) || 0;
      remainingTarget = Math.max(0, targetLimit - dbApprovedCount);

      if (remainingTarget === 0) {
        console.log(`[director] DB-first: ${dbApprovedCount}/${targetLimit} approval-ready outputs produced — target met, skipping external research`);
        if (dbPipelineResult?.summary) {
          dbPipelineResult.summary.requested = campaignRequested;
          dbPipelineResult.summary.delivered = deliveredSoFar + dbApprovedCount;
          dbPipelineResult.summary.shortfall = 0;
          dbPipelineResult.summary.target_fulfilled = true;
        }
        await logsService.createLog(clientId, {
          agent: 'director',
          action: 'campaign_target_fulfilled',
          metadata: { plan_id, requested: campaignRequested, delivered: deliveredSoFar + dbApprovedCount, source: 'database_first' },
        }).catch(() => {});
        return dbPipelineResult;
      }

      console.log(`[director] DB-first: ${dbApprovedCount}/${targetLimit} approval-ready outputs — ${remainingTarget} more needed from research`);
    } else {
      console.log('[director] DB-first: no uncontacted leads in pipeline — proceeding to external research');
    }
  } catch (err) {
    console.warn('[director] DB-first check failed, proceeding to external research:', err.message);
  }

  if (remainingTarget > 0 && allowPaidSignal === false) {
    const delivered = deliveredSoFar + dbApprovedCount;
    const drafted = draftedSoFar + dbDraftedCount;
    const rejected = rejectedSoFar + dbRejectedCount;
    const leadsFound = leadsFoundSoFar + dbLeadsCount;
    const shortfall = Math.max(0, campaignRequested - delivered);
    const blocker = 'paid_signal_disabled_for_source_mode';
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'paid_signal_disabled_stop',
      metadata: {
        plan_id,
        requested: campaignRequested,
        delivered,
        shortfall,
        source_mode: sourceMode,
        boundary: 'explicit_no_paid_signal',
      },
    }).catch(() => {});
    await updateExecStatus(clientId, plan_id, {
      status: shortfall > 0 ? 'blocked' : 'completed',
      phase: 'captain',
      beavers: {
        research: { status: 'blocked', task: `Paid signal disabled for ${sourceMode}`, found: leadsFound, passed: dbLeadsCount },
        sales:    { status: drafted > 0 ? 'done' : 'idle', task: `${drafted} messages drafted`, drafted, approved: delivered },
        enforcer: { status: drafted > 0 ? 'done' : 'idle', task: `${delivered} approved, ${rejected} rejected`, reviewed: drafted, rejected },
        captain:  { status: shortfall > 0 ? 'blocked' : 'done', task: `${delivered}/${campaignRequested} requested outputs delivered`, approved: delivered },
      },
      progress: { total: campaignRequested, complete: Math.min(campaignRequested, delivered) },
      started_at: new Date().toISOString(),
      blocker,
      source_mode: sourceMode,
    });
    return {
      plan_id,
      status: shortfall > 0 ? 'blocked' : 'completed',
      leads_found: leadsFound,
      messages_drafted: drafted,
      messages_failed: 0,
      summary: {
        requested: campaignRequested,
        delivered,
        shortfall,
        target_fulfilled: shortfall === 0,
        blocker,
        source_mode: sourceMode,
        db_leads_processed: dbLeadsCount,
        leads_found: leadsFound,
        messages_drafted: drafted,
        approved: delivered,
        rejected,
        skipped: dbSkippedCount,
        reason: `Paid signal sourcing is disabled for ${sourceMode}; stopping instead of spending to chase the shortfall.`,
      },
      diagnostics,
    };
  }

  const searchCapacity = await getSearchProviderCapacity(clientId);
  diagnostics.search_capacity = searchCapacity;
  const paidSignalCap = normalisePaidSignalCap(maxPaidSignalQueries);
  const minimumPaidQueriesNeeded = paidSignalCap !== null
    ? Math.min(paidSignalCap, minPaidQueriesForExternalTarget(remainingTarget))
    : minPaidQueriesForExternalTarget(remainingTarget);
  const insufficientSearchCapacity = remainingTarget > 0
    && Number(searchCapacity.remainingPaidQueries || 0) < minimumPaidQueriesNeeded;
  if (!searchCapacity.hasCapacity || insufficientSearchCapacity) {
    const delivered = deliveredSoFar + dbApprovedCount;
    const drafted = draftedSoFar + dbDraftedCount;
    const rejected = rejectedSoFar + dbRejectedCount;
    const leadsFound = leadsFoundSoFar + dbLeadsCount;
    const shortfall = Math.max(0, campaignRequested - delivered);
    const blocker = searchCapacity.hasCapacity ? 'paid_search_capacity_insufficient' : 'paid_search_capacity_exhausted';
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'campaign_target_unfulfilled',
      metadata: {
        plan_id,
        requested: campaignRequested,
        delivered,
        shortfall,
        blocker,
        providers: searchCapacity.providers,
        required_paid_queries: minimumPaidQueriesNeeded,
        remaining_paid_queries: searchCapacity.remainingPaidQueries,
      },
    }).catch(() => {});
    await updateExecStatus(clientId, plan_id, {
      status: shortfall > 0 ? 'blocked' : 'completed',
      phase: 'captain',
      beavers: {
        research: { status: 'blocked', task: 'No paid search capacity available', found: 0, passed: 0 },
        sales:    { status: 'done', task: `${drafted} messages drafted`, drafted, approved: delivered },
        enforcer: { status: 'done', task: `${delivered} approved, ${rejected} rejected`, reviewed: drafted, rejected },
        captain:  { status: shortfall > 0 ? 'blocked' : 'done', task: `${delivered}/${campaignRequested} requested outputs delivered`, approved: delivered },
      },
      progress: { total: campaignRequested, complete: Math.min(campaignRequested, delivered) },
      started_at: new Date().toISOString(),
      blocker,
      required_paid_queries: minimumPaidQueriesNeeded,
      remaining_paid_queries: searchCapacity.remainingPaidQueries,
    });
    return {
      plan_id,
      status: shortfall > 0 ? 'blocked' : 'completed',
      leads_found: leadsFound,
      messages_drafted: drafted,
      messages_failed: 0,
      summary: {
        requested: campaignRequested,
        delivered,
        shortfall,
        target_fulfilled: shortfall === 0,
        blocker,
        required_paid_queries: minimumPaidQueriesNeeded,
        remaining_paid_queries: searchCapacity.remainingPaidQueries,
        db_leads_processed: dbLeadsCount,
        leads_found: leadsFound,
        messages_drafted: drafted,
        approved: delivered,
        rejected,
        skipped: dbSkippedCount,
      },
      diagnostics,
    };
  }

  // ── Step 1: Research Beaver (with retry loop) ───────────

  // Retry loop: keep searching until we have enough leads that pass ALL Director gates
  // Max 3 rounds to cap API spend (each round = 1 search batch + verification)
  let campaignSearchBudgetRemaining = Math.min(
    Number(searchCapacity.remainingPaidQueries) || 0,
    paidSignalCap !== null
      ? Math.min(paidSignalCap, minPaidQueriesForExternalTarget(remainingTarget))
      : minPaidQueriesForExternalTarget(remainingTarget)
  );
  diagnostics.source_mode = sourceMode;
  diagnostics.max_paid_signal_queries = paidSignalCap;

  // Step 0b: Signal-first sourcing. This is the primary cold-sourcing brain:
  // signal -> company -> decision-maker -> Sales/Enforcer. Generic profile
  // research is only the fallback for any output shortfall.
  if (remainingTarget > 0 && campaignSearchBudgetRemaining > 0) {
    const dailyAttemptClaimed = await claimDailyPaidSignalAttempt(clientId, {
      sourceMode,
      plan_id,
      maxPaidSignalQueries: campaignSearchBudgetRemaining,
    });
    if (!dailyAttemptClaimed) {
      const delivered = deliveredSoFar + dbApprovedCount;
      const drafted = draftedSoFar + dbDraftedCount;
      const rejected = rejectedSoFar + dbRejectedCount;
      const leadsFound = leadsFoundSoFar + dbLeadsCount;
      const shortfall = Math.max(0, campaignRequested - delivered);
      const blocker = 'daily_web_linkedin_topup_already_attempted';
      diagnostics.daily_web_linkedin_topup_deduped = true;
      await updateExecStatus(clientId, plan_id, {
        status: shortfall > 0 ? 'blocked' : 'completed',
        phase: 'captain',
        beavers: {
          research: { status: 'blocked', task: 'Daily web/LinkedIn top-up already attempted', found: leadsFound, passed: dbLeadsCount },
          sales:    { status: drafted > 0 ? 'done' : 'idle', task: `${drafted} messages drafted`, drafted, approved: delivered },
          enforcer: { status: drafted > 0 ? 'done' : 'idle', task: `${delivered} approved, ${rejected} rejected`, reviewed: drafted, rejected },
          captain:  { status: shortfall > 0 ? 'blocked' : 'done', task: `${delivered}/${campaignRequested} requested outputs delivered`, approved: delivered },
        },
        progress: { total: campaignRequested, complete: Math.min(campaignRequested, delivered) },
        started_at: new Date().toISOString(),
        blocker,
        source_mode: sourceMode,
      });
      return {
        plan_id,
        status: shortfall > 0 ? 'blocked' : 'completed',
        leads_found: leadsFound,
        messages_drafted: drafted,
        messages_failed: 0,
        summary: {
          requested: campaignRequested,
          delivered,
          shortfall,
          target_fulfilled: shortfall === 0,
          blocker,
          source_mode: sourceMode,
          leads_found: leadsFound,
          messages_drafted: drafted,
          approved: delivered,
          rejected,
          reason: 'Daily web/LinkedIn top-up already ran for this MYT day; blocked duplicate paid search.',
        },
        diagnostics,
      };
    }
    const signalPlan = buildSignalFirstSourcingPlan(remainingTarget, campaignSearchBudgetRemaining);
    const signalBudget = signalPlan.paidQueryBudget;
    campaignSearchBudgetRemaining = Math.max(0, campaignSearchBudgetRemaining - signalBudget);
    diagnostics.signal_first_budget_reserved = signalBudget;
    diagnostics.signal_first_requested = signalPlan.maxSignalLeads;
    diagnostics.signal_first_buffer_leads = signalPlan.bufferLeads;
    try {
      const { runSignalHunt, saveSignalLeads } = require('./signalHunt');
      await logsService.createLog(clientId, {
        agent: 'director',
        action: 'signal_first_started',
        metadata: {
          plan_id,
          remaining_target: remainingTarget,
          paid_query_budget: signalBudget,
          max_signal_leads: signalPlan.maxSignalLeads,
          buffer_leads: signalPlan.bufferLeads,
          source_mode: sourceMode,
        },
      }).catch(() => {});

      const signalLeads = await runSignalHunt(clientId, {
        maxLeads: signalPlan.maxSignalLeads,
        icp: icpMemory,
        maxPaidQueries: signalBudget,
        plan_id,
      });
      diagnostics.signal_first_raw = Array.isArray(signalLeads) ? signalLeads.length : 0;

      if (Array.isArray(signalLeads) && signalLeads.length > 0) {
        const savedSignalLeads = await saveSignalLeads(clientId, signalLeads);
        signalLeadsCount = savedSignalLeads.length;
        diagnostics.signal_first_saved = signalLeadsCount;
        diagnostics.signal_first_save_stats = savedSignalLeads.saveStats || null;

        if (savedSignalLeads.length > 0) {
          const signalLeadsForPipeline = savedSignalLeads.slice(0, remainingTarget);
          signalPipelineLeadCount = signalLeadsForPipeline.length;
          diagnostics.signal_first_processed = signalPipelineLeadCount;

          const signalPipelineResult = await processExistingLeadsPipeline(clientId, plan_id, signalLeadsForPipeline, {
            allowPersonalisationSearch: allowsPaidPersonalisation(allowPaidSignal, maxPaidSignalQueries),
          })
            .catch(err => {
              console.error('[director] Signal-first pipeline failed:', err.message);
              return null;
            });
          signalApprovedCount = Number(signalPipelineResult?.summary?.approved) || 0;
          signalDraftedCount = Number(signalPipelineResult?.summary?.messages_drafted) || 0;
          signalRejectedCount = Number(signalPipelineResult?.summary?.rejected) || 0;
          signalSkippedCount = Number(signalPipelineResult?.summary?.skipped) || 0;
          remainingTarget = Math.max(0, remainingTarget - signalApprovedCount);
          diagnostics.signal_first_approved = signalApprovedCount;
        }
      }
    } catch (err) {
      diagnostics.signal_first_error = err.message;
      await logsService.createLog(clientId, {
        agent: 'director',
        action: 'signal_first_failed',
        metadata: { plan_id, error: err.message },
      }).catch(() => {});
    }
  }

  if (remainingTarget === 0) {
    const delivered = deliveredSoFar + dbApprovedCount + signalApprovedCount;
    const drafted = draftedSoFar + dbDraftedCount + signalDraftedCount;
    const rejected = rejectedSoFar + dbRejectedCount + signalRejectedCount;
    const leadsFound = leadsFoundSoFar + dbLeadsCount + signalLeadsCount;
    const summary = {
      requested: campaignRequested,
      delivered,
      shortfall: 0,
      target_fulfilled: true,
      leads_found: leadsFound,
      messages_drafted: drafted,
      approved: delivered,
      rejected,
      db_leads_processed: dbLeadsCount,
      signal_leads_processed: signalPipelineLeadCount,
      signal_leads_saved: signalLeadsCount,
      db_approved: dbApprovedCount,
      signal_approved: signalApprovedCount,
    };
    await updateExecStatus(clientId, plan_id, {
      status: 'completed',
      phase: 'captain',
      beavers: {
        research: { status: 'done', task: `${leadsFound} leads saved signal-first`, found: leadsFound, passed: signalPipelineLeadCount + dbLeadsCount },
        sales:    { status: 'done', task: `${drafted} messages drafted`, drafted, approved: delivered },
        enforcer: { status: 'done', task: `${delivered} approved, ${rejected} rejected`, reviewed: drafted, rejected },
        captain:  { status: 'done', task: `${delivered}/${campaignRequested} requested outputs delivered`, approved: delivered },
      },
      progress: { total: campaignRequested, complete: campaignRequested },
      started_at: new Date().toISOString(),
    });
    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'campaign_target_fulfilled',
      metadata: { plan_id, requested: campaignRequested, delivered, source: 'signal_first' },
    }).catch(() => {});
    return {
      plan_id,
      status: 'completed',
      leads_found: leadsFound,
      messages_drafted: drafted,
      messages_failed: 0,
      summary,
      diagnostics,
      results: [
        ...(dbLeadsCount > 0 ? [{ step: 0, agent: 'research_beaver', status: 'completed', result: `${dbLeadsCount} existing DB lead${dbLeadsCount !== 1 ? 's' : ''} processed` }] : []),
        { step: 1, agent: 'signal_hunt', status: 'completed', result: `${signalPipelineLeadCount} signal lead${signalPipelineLeadCount !== 1 ? 's' : ''} processed; ${signalLeadsCount} saved` },
        { step: 2, agent: 'sales_beaver', status: 'completed', result: `${drafted} message${drafted !== 1 ? 's' : ''} drafted` },
        { step: 3, agent: 'ranger', status: 'completed', result: `${delivered} approved` },
      ],
    };
  }

  if (Number(diagnostics.signal_first_budget_reserved || 0) > 0) {
    const delivered = deliveredSoFar + dbApprovedCount + signalApprovedCount;
    const drafted = draftedSoFar + dbDraftedCount + signalDraftedCount;
    const rejected = rejectedSoFar + dbRejectedCount + signalRejectedCount;
    const leadsFound = leadsFoundSoFar + dbLeadsCount + signalLeadsCount;
    const shortfall = Math.max(0, campaignRequested - delivered);
    const blocker = diagnostics.signal_first_error ? 'signal_first_failed' : 'signal_first_unfulfilled';
    diagnostics.campaign_search_budget_remaining = campaignSearchBudgetRemaining;
    diagnostics.no_generic_fallback = true;

    if (shortfall > 0) {
      const attemptApproved = dbApprovedCount + signalApprovedCount;
      const attemptLeadsFound = dbLeadsCount + signalLeadsCount;

      if (attemptApproved > 0 && completionAttempt < maxCompletionAttempts) {
        await logsService.createLog(clientId, {
          agent: 'captain_beaver',
          action: 'captain_continue_signal_first_shortfall',
          metadata: {
            plan_id,
            requested: campaignRequested,
            delivered,
            shortfall,
            attempt_approved: attemptApproved,
            attempt_leads_found: attemptLeadsFound,
            completion_attempt: completionAttempt + 1,
            source_mode: sourceMode,
          },
        }).catch(() => {});
        await updateExecStatus(clientId, plan_id, {
          status: 'executing',
          phase: 'captain',
          beavers: {
            research: { status: 'working', task: `Captain is sourcing ${shortfall} replacement output${shortfall !== 1 ? 's' : ''}`, found: leadsFound, passed: signalPipelineLeadCount + dbLeadsCount },
            sales:    { status: drafted > 0 ? 'done' : 'idle', task: `${drafted} messages drafted`, drafted, approved: delivered },
            enforcer: { status: drafted > 0 ? 'done' : 'idle', task: `${delivered} approved, ${rejected} rejected`, reviewed: drafted, rejected },
            captain:  { status: 'working', task: `Continuing ${delivered}/${campaignRequested} campaign shortfall`, approved: delivered },
          },
          progress: { total: campaignRequested, complete: Math.min(campaignRequested, delivered) },
          started_at: new Date().toISOString(),
          continuation_attempt: completionAttempt + 1,
          blocker: 'campaign_target_shortfall',
        });
        return await directorExecute(clientId, {
          plan_id,
          command,
          batchIndex: batchIndex + 1,
          limit: shortfall,
          completionAttempt: completionAttempt + 1,
          maxCompletionAttempts,
          requestedTarget: campaignRequested,
          deliveredSoFar: delivered,
          draftedSoFar: drafted,
          rejectedSoFar: rejected,
          leadsFoundSoFar: leadsFound,
          allowPaidSignal,
          sourceMode,
          maxPaidSignalQueries,
        });
      }

      if (attemptApproved === 0) {
        const captainPrompt = `Captain stopped this campaign because the latest sourcing pass produced zero new approval-ready leads. Delivered so far: ${delivered}/${campaignRequested}. No more paid searches will run until MJ decides whether to widen the signal, adjust ICP, or stop.`;
        const result = {
          plan_id,
          status: 'needs_input',
          leads_found: leadsFound,
          messages_drafted: drafted,
          messages_failed: 0,
          summary: {
            requested: campaignRequested,
            delivered,
            shortfall,
            target_fulfilled: false,
            blocker: 'zero_new_outputs',
            leads_found: leadsFound,
            messages_drafted: drafted,
            approved: delivered,
            rejected,
            db_leads_processed: dbLeadsCount,
            signal_leads_processed: signalPipelineLeadCount,
            signal_leads_saved: signalLeadsCount,
            signal_approved: signalApprovedCount,
            reason: captainPrompt,
          },
          diagnostics,
          question: captainPrompt,
          results: [
            ...(dbLeadsCount > 0 ? [{ step: 0, agent: 'research_beaver', status: 'completed', result: `${dbLeadsCount} existing DB lead${dbLeadsCount !== 1 ? 's' : ''} processed` }] : []),
            { step: 1, agent: 'signal_hunt', status: 'blocked', result: `${signalPipelineLeadCount} signal lead${signalPipelineLeadCount !== 1 ? 's' : ''} processed; ${signalLeadsCount} saved; ${signalApprovedCount} approved` },
            { step: 2, agent: 'captain_beaver', status: 'needs_input', result: captainPrompt },
          ],
        };
        await logsService.createLog(clientId, {
          agent: 'captain_beaver',
          action: 'captain_user_prompt_required',
          metadata: {
            plan_id,
            requested: campaignRequested,
            delivered,
            shortfall,
            blocker: 'zero_new_outputs',
            attempt_leads_found: attemptLeadsFound,
            signal_first_raw: diagnostics.signal_first_raw || 0,
            signal_first_saved: signalLeadsCount,
            signal_first_approved: signalApprovedCount,
            question: captainPrompt,
          },
        }).catch(() => {});
        await updateExecStatus(clientId, plan_id, {
          status: 'needs_input',
          phase: 'captain',
          question: captainPrompt,
          beavers: {
            research: { status: 'blocked', task: 'Latest sourcing pass produced zero approval-ready outputs', found: leadsFound, passed: signalPipelineLeadCount + dbLeadsCount },
            sales:    { status: drafted > 0 ? 'done' : 'idle', task: `${drafted} messages drafted`, drafted, approved: delivered },
            enforcer: { status: drafted > 0 ? 'done' : 'idle', task: `${delivered} approved, ${rejected} rejected`, reviewed: drafted, rejected },
            captain:  { status: 'needs_input', task: `${delivered}/${campaignRequested} delivered; waiting for MJ decision`, approved: delivered },
          },
          progress: { total: campaignRequested, complete: Math.min(campaignRequested, delivered) },
          started_at: new Date().toISOString(),
          blocker: 'zero_new_outputs',
          result,
          completed_at: new Date().toISOString(),
        });
        return result;
      }
    }

    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'signal_first_terminal_block',
      metadata: {
        plan_id,
        blocker,
        requested: campaignRequested,
        delivered,
        shortfall,
        signal_first_raw: diagnostics.signal_first_raw || 0,
        signal_first_saved: signalLeadsCount,
        signal_first_approved: signalApprovedCount,
        signal_first_budget_reserved: diagnostics.signal_first_budget_reserved,
        remaining_paid_queries_not_spent_on_fallback: campaignSearchBudgetRemaining,
      },
    }).catch(() => {});

    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'campaign_target_unfulfilled',
      metadata: {
        plan_id,
        requested: campaignRequested,
        delivered,
        shortfall,
        blocker,
        source: 'signal_first',
        signal_first_raw: diagnostics.signal_first_raw || 0,
        signal_first_saved: signalLeadsCount,
        signal_first_approved: signalApprovedCount,
        remaining_paid_queries_not_spent_on_fallback: campaignSearchBudgetRemaining,
      },
    }).catch(() => {});

    const result = {
      plan_id,
      status: shortfall > 0 ? 'blocked' : 'completed',
      leads_found: leadsFound,
      messages_drafted: drafted,
      messages_failed: 0,
      summary: {
        requested: campaignRequested,
        delivered,
        shortfall,
        target_fulfilled: shortfall === 0,
        blocker,
        leads_found: leadsFound,
        messages_drafted: drafted,
        approved: delivered,
        rejected,
        db_leads_processed: dbLeadsCount,
        signal_leads_processed: signalPipelineLeadCount,
        signal_leads_saved: signalLeadsCount,
        signal_approved: signalApprovedCount,
        generic_research_saved: 0,
        reason: `Signal-first sourcing did not fulfill the request (${delivered}/${campaignRequested} approval-ready). Generic paid fallback was blocked to prevent spend without output.`,
      },
      diagnostics,
      results: [
        ...(dbLeadsCount > 0 ? [{ step: 0, agent: 'research_beaver', status: 'completed', result: `${dbLeadsCount} existing DB lead${dbLeadsCount !== 1 ? 's' : ''} processed` }] : []),
        { step: 1, agent: 'signal_hunt', status: shortfall > 0 ? 'blocked' : 'completed', result: `${signalPipelineLeadCount} signal lead${signalPipelineLeadCount !== 1 ? 's' : ''} processed; ${signalLeadsCount} saved; ${signalApprovedCount} approved` },
        { step: 2, agent: 'director', status: shortfall > 0 ? 'blocked' : 'completed', result: 'Generic paid research fallback blocked by no-burn rule' },
      ],
    };

    await updateExecStatus(clientId, plan_id, {
      status: result.status,
      phase: 'captain',
      beavers: {
        research: { status: shortfall > 0 ? 'blocked' : 'done', task: `Signal-first produced ${signalApprovedCount}/${campaignRequested} approval-ready`, found: leadsFound, passed: signalPipelineLeadCount },
        sales:    { status: drafted > 0 ? 'done' : 'idle', task: `${drafted} messages drafted`, drafted, approved: delivered },
        enforcer: { status: drafted > 0 ? 'done' : 'idle', task: `${delivered} approved, ${rejected} rejected`, reviewed: drafted, rejected },
        captain:  { status: shortfall > 0 ? 'blocked' : 'done', task: `${delivered}/${campaignRequested} requested outputs delivered`, approved: delivered },
      },
      progress: { total: campaignRequested, complete: Math.min(campaignRequested, delivered) },
      started_at: new Date().toISOString(),
      blocker,
      result,
      completed_at: new Date().toISOString(),
    });

    return result;
  }

  const MAX_RESEARCH_ROUNDS = 3;
  let rawLeads = [];
  let currentBatchIndex = batchIndex;
  let allSearchQueries = [];

  for (let round = 0; round < MAX_RESEARCH_ROUNDS; round++) {
    if (campaignSearchBudgetRemaining <= 0) {
      diagnostics.research_circuit_breaker = diagnostics.research_circuit_breaker || 'campaign paid-search budget exhausted';
      break;
    }
    // Phase 2 V2 Step 9 (2026-05-15): research is ICP-driven only. `command` is
    // retained for observability (logged at L2485 in plan_executing metadata) but
    // is NOT passed to researchSearch as a query — that path used to feed the
    // Captain daily-brief paragraph into Brave's q= parameter and returned 0.
    const researchResult = await researchSearch(clientId, {
      query: '',
      command,
      filters: {
        batchIndex: currentBatchIndex,
        limit: remainingTarget,
        maxPaidQueries: Math.max(1, Math.min(campaignSearchBudgetRemaining, remainingTarget * 3)),
      },
    });

    const roundLeads = researchResult?.data?.leads || [];
    if (researchResult?.data?.query) allSearchQueries.push(researchResult.data.query);
    diagnostics.research_source = researchResult?.data?.source || 'unknown';
    const researchDiagnostics = researchResult?.data?.diagnostics || {};
    const verificationStats = researchDiagnostics.verification_stats || {};
    const candidatesTotal = verificationStats.candidates_total ?? researchDiagnostics.candidates_total;
    if (candidatesTotal != null) diagnostics.provider_candidates = Number(candidatesTotal) || 0;
    if (verificationStats.candidates != null || researchDiagnostics.layer1_candidates != null) {
      diagnostics.layer1_candidates = Number(verificationStats.candidates ?? researchDiagnostics.layer1_candidates) || 0;
    }
    if (verificationStats.rejected != null || researchDiagnostics.layer2_rejected != null) {
      diagnostics.research_rejected = Number(verificationStats.rejected ?? researchDiagnostics.layer2_rejected) || 0;
    }
    if (verificationStats.rejection_summary || researchDiagnostics.rejection_summary) {
      diagnostics.rejection_summary = verificationStats.rejection_summary || researchDiagnostics.rejection_summary;
    }
    if (verificationStats.rejection_samples || researchDiagnostics.rejection_samples) {
      diagnostics.rejection_samples = verificationStats.rejection_samples || researchDiagnostics.rejection_samples;
    }
    if (verificationStats.circuit_breaker_tripped || researchDiagnostics.circuit_breaker_tripped) {
      diagnostics.research_circuit_breaker = verificationStats.circuit_breaker_tripped || researchDiagnostics.circuit_breaker_tripped;
    }
    const roundQueryUse = Number(verificationStats.queries_total ?? researchDiagnostics.queries_total) || 0;
    if (roundQueryUse > 0) {
      campaignSearchBudgetRemaining = Math.max(0, campaignSearchBudgetRemaining - roundQueryUse);
      diagnostics.campaign_search_budget_remaining = campaignSearchBudgetRemaining;
    }

    // Deduplicate against leads already collected in previous rounds
    const existingUrls = new Set(rawLeads.map(l => l.linkedin_url).filter(Boolean));
    const newLeads = roundLeads.filter(l => !l.linkedin_url || !existingUrls.has(l.linkedin_url));
    rawLeads.push(...newLeads);

    console.log(`[research] Round ${round + 1}: got ${roundLeads.length} (${newLeads.length} new), total raw: ${rawLeads.length}`);

    if (rawLeads.length >= remainingTarget * 2) {
      console.log(`[research] Have ${rawLeads.length} raw leads (>= ${remainingTarget * 2} buffer) — stopping search`);
      break;
    }

    // If this round returned 0 new leads, stop — query pool is exhausted
    if (newLeads.length === 0) {
      console.log(`[research] Round ${round + 1} returned 0 new leads — query pool exhausted`);
      break;
    }

    currentBatchIndex++;
  }

  diagnostics.raw_from_research = rawLeads.length;
  diagnostics.research_verified = rawLeads.length;
  diagnostics.research_rounds = Math.min(currentBatchIndex - batchIndex + 1, MAX_RESEARCH_ROUNDS);
  diagnostics.search_query = allSearchQueries.join(' | ') || null;

  // ── Step 1b: Captain Beaver verification gate ────────────
  // If a lead came from unverified fallback and has no linkedin_url,
  // it cannot be verified and must be skipped to prevent hallucinated outreach.
  const researchSource = diagnostics.research_source || 'claude';
  const isVerifiedSource = researchSource === 'brave' || researchSource === 'multi';
  // ══════════════════════════════════════════════════════════════
  // CAPTAIN'S QUALITY GATE — strict filtering, fewer but real leads
  // Philosophy: 3 verified leads > 20 garbage leads
  // ══════════════════════════════════════════════════════════════

  // ── Gate 1: Title check (Phase B2: loosened — prefer, don't require) ──
  // Philosophy: 3 real leads > 20 garbage, BUT "real" != "perfect title match".
  // If the title is clearly wrong (intern, assistant, support, recruiter) → reject.
  // If the title is missing or non-standard → ACCEPT, let downstream filters decide.
  // Search often returns profiles without titles, or titles in unusual formats.
  const EXCLUDED_TITLES = /intern|\bjunior\b|executive assistant|test engineer|\bqa\b|quality assurance|trainee|receptionist|talent acquisition|recruiter|recruitment specialist|human resource|clerk/i;

  const titledLeads = rawLeads.filter(lead => {
    const title = lead.title || '';
    const allText = `${title} ${lead.name || ''}`;

    // Reject only CLEARLY excluded titles. Everything else passes.
    if (EXCLUDED_TITLES.test(allText)) {
      console.warn(`[captain] REJECT title: "${title}" (${lead.name} at ${lead.company}) — excluded role`);
      logsService.createLog(clientId, { agent: 'director', action: 'lead_skipped_title', metadata: { name: lead.name, title, reason: 'excluded_role' } }).catch(() => {});
      return false;
    }

    // No title? Accept — let company/industry filter catch obvious non-fits.
    // Non-standard title? Accept — Sales Beaver uses role-based hooks anyway.
    return true;
  });

  diagnostics.after_title_filter = titledLeads.length;

  // ── Gate 2: Must have a usable contact route ──
  const verifiedLeads = titledLeads.filter(lead => {
    const hasLinkedIn = !!lead.linkedin_url;
    const hasVerifiedEmail = !!lead.email && lead.email_verified === true;
    if (!hasLinkedIn && !hasVerifiedEmail) {
      console.warn(`[captain] REJECT: ${lead.name} — no verified email or LinkedIn URL`);
      return false;
    }
    return true;
  });

  diagnostics.after_verification_gate = verifiedLeads.length;

  // ── Gate 3: Company must be real (not "Unknown") ──
  const namedLeads = verifiedLeads.filter(lead => {
    if (!lead.company || lead.company === 'Unknown' || lead.company === 'Unknown Company' || lead.company.length < 3) {
      console.warn(`[captain] REJECT: ${lead.name} — company is unknown or too short ("${lead.company}")`);
      logsService.createLog(clientId, { agent: 'director', action: 'lead_skipped_company', metadata: { name: lead.name, company: lead.company, reason: 'unknown_company' } }).catch(() => {});
      return false;
    }
    return true;
  });

  // ── Gate 4: ICP v2 — country, vertical, persona, score (per MJ direction 2026-04-29) ──
  // Replaces the prior "reject only if explicit foreign signal" geo logic which let through
  // 51 non-MY leads on the Beaver Solutions tenant. New gate REQUIRES SEA-6 country evidence
  // (lead.country, metadata, or Haiku verification) and emits granular rejection statuses.

  // Sector exclusions still apply on top of ICP v2 (these are sector-narrowing for the
  // Beaver Solutions ICP, not country/persona checks).
  const EXCLUDED_INDUSTRIES = /hospital|clinic|medical centre|healthcare|pharmacy|polyclinic|hotel|resort|restaurant|hospitality|retail|e-commerce|ecommerce|supermarket|hypermarket/i;

  const icpGatedLeads = [];
  const rejectedAuditQueue = [];
  for (const lead of namedLeads) {
    const allText = [lead.name || '', lead.company || '', lead.title || '', lead.snippet || '', lead.location || ''].join(' ');

    // ICP v2 hard gate.
    const v2 = applyIcpV2Filter(lead);
    if (!v2.pass) {
      console.warn(`[captain] REJECT ${v2.status}: ${lead.name} at ${lead.company} — ${v2.reason}`);
      rejectedAuditQueue.push({ lead, status: v2.status, reason: v2.reason });
      continue;
    }

    // Sector exclusion (kept as a separate narrow gate — no status enum, just drop).
    if (EXCLUDED_INDUSTRIES.test(allText)) {
      console.warn(`[captain] REJECT industry: ${lead.name} at ${lead.company}`);
      logsService.createLog(clientId, { agent: 'director', action: 'lead_skipped_industry', metadata: { name: lead.name, company: lead.company } }).catch(() => {});
      continue;
    }

    icpGatedLeads.push(lead);
  }

  // Persist rejected leads with status='rejected_*' and deleted_at=NOW() so they show up
  // in the validation SQL but don't pollute the active leads view. Fire-and-forget so the
  // pipeline isn't blocked on audit writes.
  if (rejectedAuditQueue.length > 0) {
    Promise.allSettled(rejectedAuditQueue.map(r => pool.query(
      `INSERT INTO leads (client_id, name, email, company, title, source,
                          pipeline_stage, status, country, linkedin_url, metadata, deleted_at)
       VALUES ($1,$2,$3,$4,$5,'research_beaver','rejected',$6,$7,$8,$9,NOW())
       RETURNING id`,
      [
        clientId,
        r.lead.name || 'Unknown',
        r.lead.email || null,
        r.lead.company || 'Unknown',
        r.lead.title || null,
        r.status,
        (r.lead.country || r.lead.metadata?.country || null),
        r.lead.linkedin_url || null,
        JSON.stringify({ ...(r.lead.metadata || {}), rejection_reason: r.reason, rejected_at: new Date().toISOString(), source: 'icp_v2_filter' }),
      ]
    ))).then(results => {
      const persisted = results.filter(x => x.status === 'fulfilled').length;
      console.log(`[captain] ICP v2 persisted ${persisted}/${rejectedAuditQueue.length} rejected lead audit rows`);
      // Phase D piece 2 — outcome attribution: one rejected event per persisted audit row
      results.forEach((res, i) => {
        if (res.status === 'fulfilled' && res.value?.rows?.[0]?.id) {
          const r = rejectedAuditQueue[i];
          recordOutcome(clientId, {
            outcome: 'rejected',
            leadId: res.value.rows[0].id,
            sourceStrategy: 'research_beaver',
            signalType: r.lead.metadata?.signal || null,
            segment: r.lead.metadata?.industry || null,
            eventData: { gate: 'icp_v2', reason: r.reason, status: r.status },
          });
        }
      });
    }).catch(err => console.warn('[captain] ICP v2 audit batch insert failed:', err.message));
  }

  diagnostics.after_icp_gate = icpGatedLeads.length;
  diagnostics.icp_v2_rejected = rejectedAuditQueue.length;
  if (namedLeads.length !== icpGatedLeads.length) {
    console.log(`[captain] ICP v2 gate: ${namedLeads.length} → ${icpGatedLeads.length} (rejected ${namedLeads.length - icpGatedLeads.length})`);
  }

  // Update status: research phase counts
  await updateExecStatus(clientId, plan_id, {
    status: 'executing',
    phase: 'research',
    beavers: {
      research: { status: 'working', task: `ICP gate: ${icpGatedLeads.length} leads passed`, found: rawLeads.length, passed: icpGatedLeads.length },
      sales:    { status: 'idle', task: 'Waiting for leads', drafted: 0, approved: 0 },
      enforcer: { status: 'idle', task: 'Waiting', reviewed: 0, rejected: 0 },
      captain:  { status: 'working', task: 'Enriching leads', approved: 0 },
    },
    progress: { total: icpGatedLeads.length, complete: 0 },
    started_at: new Date().toISOString(),
  });

  // Mark source for transparency in approval queue
  const markedLeads = icpGatedLeads.map(lead => ({
    ...lead,
    metadata: {
      ...(lead.metadata || {}),
      verified: isVerifiedSource ? true : (lead.verified !== false),
      data_source: lead.data_source || (isVerifiedSource ? researchSource : 'ai_generated'),
    },
  }));

  if (!isVerifiedSource && rawLeads.length !== verifiedLeads.length) {
    console.log(`[captain] Verification gate: ${rawLeads.length} leads from Claude → ${verifiedLeads.length} passed (${rawLeads.length - verifiedLeads.length} skipped, no linkedin_url)`);
  }

  // ── Step 1c: Hunter.io email enrichment ──────────────────
  const enrichedLeads = await enrichLeadsWithHunter(clientId, markedLeads);

  // ── Step 1d: Captain Beaver — name/email alignment check ─
  // Ensures we never send to the wrong person.
  // Rule: email local part must start with the lead's first name (or be from Apollo).
  // If mismatch detected → clear the email, keep the lead, log the issue.
  const cleanedLeads = enrichedLeads.map(lead => {
    if (!lead.email) return lead;
    const emailLocal = lead.email.split('@')[0].toLowerCase();
    const emailFirstName = emailLocal.split('.')[0].split('_')[0].split('+')[0];
    const leadFirstName = (lead.name || '').trim().split(/\s+/)[0].toLowerCase();

    // Only flag if both names are confidently different (not just short/missing)
    if (emailFirstName.length >= 3 && leadFirstName.length >= 3 && emailFirstName !== leadFirstName) {
      console.warn(`[captain] Email mismatch — ${lead.name} (${leadFirstName}) got email for "${emailFirstName}" (${lead.email}). Clearing email.`);
      logsService.createLog(clientId, {
        agent: 'director',
        action: 'email_mismatch_cleared',
        metadata: {
          lead_name: lead.name,
          lead_company: lead.company,
          bad_email: lead.email,
          reason: `Email belongs to "${emailFirstName}", not "${leadFirstName}"`,
        },
      }).catch(() => {});
      return { ...lead, email: null, email_source: null, email_verified: false };
    }
    return lead;
  });

  diagnostics.after_dedup = cleanedLeads.length;

  // ── Step 2: Save leads to DB ─────────────────────────────
  const savedLeads = [];
  for (const lead of cleanedLeads) {
    // Quality gate — reject placeholder/freelance/generic-company leads.
    // Mirrors dbBuilder.js so both sourcing paths apply the same filter.
    const quality = evaluateLeadQuality(lead);
    if (!quality.ok) {
      console.log(`[quality] Rejecting ${lead.name} at ${lead.company || 'NO_COMPANY'} — ${quality.reason}`);
      diagnostics.reason = (diagnostics.reason || '') + ` Rejected ${lead.name}: ${quality.reason}.`;
      await logsService.createLog(clientId, {
        agent: 'research_beaver',
        action: 'lead_quality_reject',
        target_type: 'system',
        metadata: {
          reason: quality.reason,
          name: lead.name,
          company: lead.company,
          source: 'agents_pipeline',
        },
      }).catch(() => {}); // non-blocking
      continue;
    }

    // ── Sprint 7B: Deduplication ──────────────────────────
    if (lead.email) {
      const dup = await pool.query(
        `SELECT id FROM leads WHERE client_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
        [clientId, lead.email]
      );
      if (dup.rows.length > 0) {
        console.log(`[dedup] Skipping ${lead.email} — already in pipeline`);
        continue;
      }
    }
    if (lead.linkedin_url) {
      const dup = await pool.query(
        `SELECT id FROM leads WHERE client_id = $1 AND linkedin_url = $2 AND deleted_at IS NULL LIMIT 1`,
        [clientId, lead.linkedin_url]
      );
      if (dup.rows.length > 0) {
        console.log(`[dedup] Skipping ${lead.linkedin_url} — already in pipeline`);
        continue;
      }
    }

    // Fallback dedup: leads with no email and no LinkedIn — check name+company match
    if (!lead.email && !lead.linkedin_url && lead.name && lead.company) {
      const nameKey = lead.name.toLowerCase().trim();
      const companyKey = lead.company.toLowerCase().trim();
      if (nameKey !== 'unknown contact' && companyKey !== 'unknown company') {
        const dup = await pool.query(
          `SELECT id FROM leads WHERE client_id = $1 AND LOWER(name) = $2 AND LOWER(company) = $3 AND deleted_at IS NULL LIMIT 1`,
          [clientId, nameKey, companyKey]
        );
        if (dup.rows.length > 0) {
          console.log(`[dedup] Skipping ${lead.name} at ${lead.company} — already in pipeline (name+company match)`);
          continue;
        }
      }
    }

    // Validate LinkedIn URL — strip fakes before saving
    const { sanitiseLinkedInUrl } = require('../utils/validateLinkedIn');
    lead.linkedin_url = sanitiseLinkedInUrl(lead.linkedin_url, `research_beaver ${lead.name}`);

    // Tiered contact gate (migration 061, 2026-05-05): assigns A/B tier
    // based on email-verified vs P1-score-with-linkedin. Tier C rejected.
    // Misses logged to research_misses for sourcing-strategy tuning.
    // Manual override via lead.linkedin_only_override.
    const contactGate = require('./contactGate');
    const gateResult = await contactGate.tryPersistSourcedLead(clientId, lead, {
      sourceStrategy: 'research_beaver',
      queryUsed: diagnostics.search_query,
      // A lead that passed Layer-2 verification (verifyCandidate: Haiku-confirmed
      // location + industry + role, no banned title) HAS already cleared the
      // ICP-quality bar. Per MJ's channel spec (2026-05-18) LinkedIn is a valid
      // channel for every lead and no-email leads route to the LinkedIn KPI
      // queue — so a verified lead with a linkedin_url must enter Tier B, not be
      // rejected as Tier C. Without this, every verified no-email lead is
      // dropped after Brave + Haiku credits were already spent on it.
      allowLinkedinOnly: !!lead.linkedin_only_override || lead.verified === true,
    });
    if (!gateResult.passed) {
      console.warn(`[save] Tier C ${lead.name} at ${lead.company} — reason: ${gateResult.missReason}`);
      diagnostics.reason = (diagnostics.reason || '') + ` Tier C ${lead.name}: ${gateResult.missReason}.`;
      continue;
    }
    const leadTier = gateResult.tier;

    try {
      const meta = lead.metadata || {};
      // Map Research Beaver's flat output fields into metadata so they
      // persist in the DB and are available to Sales Beaver + Smart Actions
      if (lead.signal)       meta.signal       = lead.signal;
      if (lead.angle)        meta.angle        = lead.angle;
      if (lead.friction)     meta.friction     = lead.friction;
      if (lead.why_now)      meta.why_now      = lead.why_now;
      if (lead.notes)        meta.notes        = lead.notes;
      // Preserve search snippet + query as fallback context for Sales Beaver
      if (lead.snippet)      meta.snippet      = lead.snippet;
      if (diagnostics.search_query) meta.search_query = diagnostics.search_query;
      if (lead.current_tools?.length)  meta.current_tools = lead.current_tools;
      if (lead.evaluating?.length)     meta.evaluating    = lead.evaluating;
      if (lead.apollo_person_id) {
        meta.apollo_person_id = lead.apollo_person_id;
        meta.apollo_org_id = lead.apollo_org_id;
      }
      meta.source = lead.metadata?.source || 'research_beaver';
      if (lead.metadata?.data_source) meta.data_source = lead.metadata.data_source;
      if (lead.metadata?.verified !== undefined) meta.verified = lead.metadata.verified;

      // Phase 2 V2 Step 6 (2026-05-08): buying_signal_strength + signal_dated_at.
      // directorExecute cold-research path. Research Beaver structured response
      // SHOULD emit these (see Step 6b prompt update). Default to 'rich' here
      // because directorExecute is the cold-research path — these leads only
      // exist because Research found a buying signal. signal_dated_at falls
      // back to NOW() (today's research run) if the signal didn't emit a date.
      const buyingSignalStrength = lead.buying_signal_strength
        || lead.metadata?.buying_signal_strength
        || 'rich';
      const signalDatedAt = lead.signal_dated_at
        || lead.metadata?.signal_dated_at
        || new Date().toISOString();

      const res = await pool.query(
        // ICP+channel patches per MJ direction 2026-04-29 + tiered sourcing migration 061 (2026-05-05).
        // signal_tier resolved from score+verified per spec; country lifted from Haiku verification.
        // lead_tier ('A'|'B') comes from contactGate.tryPersistSourcedLead — written here with tiered_at.
        `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                            pipeline_stage, status, email_verified, email_source,
                            apollo_enriched, apollo_person_id, apollo_org_id, linkedin_url, country, metadata,
                            lead_tier, tiered_at,
                            buying_signal_strength, signal_dated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'research_beaver','prospecting','new',$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),$17,$18)
         ON CONFLICT (client_id, linkedin_url) WHERE linkedin_url IS NOT NULL AND deleted_at IS NULL
         DO NOTHING
         RETURNING *`,
        [
          clientId,
          lead.name || 'Unknown Contact',
          lead.email || null,
          lead.company || 'Unknown Company',
          lead.title || null,
          resolveSignalTier(lead) || lead.signal_tier || null,
          lead.score || lead.quality_score || 0,
          lead.email_verified || false,
          lead.email_source || null,
          !!(lead.metadata?.apollo_person_id),
          lead.metadata?.apollo_person_id || null,
          lead.metadata?.apollo_org_id || null,
          lead.linkedin_url || null,
          lead.country || lead.metadata?.country || lead.verification?.country || lead.verification?.haikuResult?.country || null,
          JSON.stringify({ short_description: lead.short_description || '', ...meta }),
          leadTier,
          buyingSignalStrength, signalDatedAt,
        ]
      );
      if (res.rows.length > 0) {
        savedLeads.push({ ...res.rows[0], short_description: lead.short_description });
        // Phase D piece 2 — outcome attribution: record sourced event
        recordOutcome(clientId, {
          outcome: 'sourced',
          leadId: res.rows[0].id,
          ...attributionFromLead(res.rows[0]),
          eventData: { verified: lead.metadata?.verified ?? null, source_path: 'research_beaver' },
        });
      } else {
        console.log(`[dedup] Skipped duplicate lead at DB level: ${lead.name} (${lead.linkedin_url})`);
      }
    } catch (err) {
      console.error('[pipeline] Failed to save lead:', err.message, err.detail || '');
    }
  }

  diagnostics.saved = savedLeads.length;

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'leads_saved',
    metadata: { count: savedLeads.length, plan_id },
  });

  // ── Dedup awareness: detect when most results are already in pipeline ──
  const dupCount = diagnostics.after_dedup - savedLeads.length;
  const dupRate = diagnostics.after_dedup > 0 ? dupCount / diagnostics.after_dedup : 0;
  if (dupRate > 0.7 && diagnostics.after_dedup >= 5) {
    diagnostics.dedup_warning = `${dupCount} of ${diagnostics.after_dedup} leads already in your pipeline. Try different keywords, a new industry, or a broader location to find fresh prospects.`;
    console.warn(`[captain] High dedup rate: ${Math.round(dupRate * 100)}% — ${dupCount}/${diagnostics.after_dedup} already exist`);
  }

  // Early exit — if all leads were filtered out, log why and return cleanly
  if (savedLeads.length === 0) {
    const deliveredBeforeGeneric = deliveredSoFar + dbApprovedCount + signalApprovedCount;
    const draftedBeforeGeneric = draftedSoFar + dbDraftedCount + signalDraftedCount;
    const rejectedBeforeGeneric = rejectedSoFar + dbRejectedCount + signalRejectedCount;
    const leadsBeforeGeneric = leadsFoundSoFar + dbLeadsCount + signalLeadsCount;
    const remainingShortfall = Math.max(0, campaignRequested - deliveredBeforeGeneric);
    const providerCandidates = Number(diagnostics.provider_candidates) || 0;
    const dupReason = dupCount > 0
      ? `${dupCount} leads already in pipeline (try different keywords). ${diagnostics.after_dedup - dupCount} filtered by ICP/verification.`
      : (rawLeads.length === 0 && providerCandidates > 0
          ? `Research verification rejected all ${providerCandidates} provider/parser candidates.`
          : (rawLeads.length === 0
              ? 'Provider/search parser returned 0 usable candidates.'
              : 'All Research-verified leads were filtered by ICP, contact gate, quality, or dedup.'));

    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'plan_zero_leads',
      metadata: {
        plan_id,
        raw_count: rawLeads.length,
        provider_candidates: providerCandidates,
        research_verified: rawLeads.length,
        research_rejected: diagnostics.research_rejected ?? null,
        rejection_summary: diagnostics.rejection_summary || null,
        rejection_samples: diagnostics.rejection_samples || null,
        dup_count: dupCount,
        reason: dupReason,
      },
    });
    diagnostics.reason = dupReason;
    const zeroResult = {
      plan_id, status: remainingShortfall > 0 ? 'blocked' : 'completed',
      leads_found: leadsBeforeGeneric, messages_drafted: draftedBeforeGeneric,
      messages_failed: 0,
      summary: {
        requested: campaignRequested,
        delivered: deliveredBeforeGeneric,
        shortfall: remainingShortfall,
        target_fulfilled: remainingShortfall === 0,
        leads_found: leadsBeforeGeneric,
        messages_drafted: draftedBeforeGeneric,
        approved: deliveredBeforeGeneric,
        rejected: rejectedBeforeGeneric,
        signal_approved: signalApprovedCount,
        db_approved: dbApprovedCount,
        generic_research_saved: 0,
        reason: `0 generic research leads saved (provider candidates: ${providerCandidates}, research verified: ${rawLeads.length}, already in pipeline: ${dupCount}). ${dupCount > rawLeads.length * 0.5 ? 'Most results are duplicates - try different keywords or a new industry.' : 'Check ICP config and data source.'}`,
      },
      diagnostics,
    };
    await updateExecStatus(clientId, plan_id, {
      status: zeroResult.status,
      result: zeroResult,
      completed_at: new Date().toISOString(),
    });
    return zeroResult;
  }

  // ── Step 3 + 4: Sales Beaver + Ranger — streaming parallel handoff ─────────
  // Each lead that passes Research gates immediately triggers Sales draft + Ranger review.
  // Channels: email, linkedin, instagram — all unique per lead.
  // Ranger retry: max 2 Sales rewrites. On 3rd attempt → Captain decides (skip or manual).

  // Phase B1: Removed hardcoded slice(0, 10) — draft for every saved lead.
  // With auto-fix and loosened gates, more leads survive to Sales drafting.
  const leadsToProcess = savedLeads;
  const savedMessages = [];
  const MAX_RANGER_RETRIES = 2; // 2 Sales rewrites max; 3rd attempt = Captain decision

  let approvedCount = 0;
  let rejectedCount = 0;

  // Tracker for live status updates
  const execStatus = {
    status: 'executing',
    phase: 'sales',
    beavers: {
      research: { status: 'done', task: `${savedLeads.length} leads saved`, found: rawLeads.length, passed: savedLeads.length },
      sales:    { status: 'working', task: 'Starting drafts', drafted: 0, approved: 0 },
      enforcer: { status: 'idle', task: 'Waiting', reviewed: 0, rejected: 0 },
      captain:  { status: 'idle', task: 'Waiting for Enforcer', approved: 0 },
    },
    progress: { total: leadsToProcess.length, complete: 0 },
    started_at: new Date().toISOString(),
  };
  await updateExecStatus(clientId, plan_id, execStatus);

  // ── Per-lead pipeline function (Sales draft + multi-channel + Ranger + Captain) ──
  async function processLeadPipeline(lead) {
    // ── Phase 2 Step 7 (Jules F-03): unified path behind PIPELINE_V2_ENABLED.
    // Flag OFF (default) → the inline body below runs unchanged.
    if (pipeline.isV2Enabled()) {
      const r = await pipeline.processLead(clientId, lead, {
        pipelinePath: 'kickoff_pipeline',
        kickoffId: plan_id,
        command,
        deps: {
          salesGenerate, rangerReview, rangerDraft, captainDraft: captainFallbackDraft, selectChannel, autoFixMessage,
          brandSafetyCheck, searchPersonalisationSignals, recordOutcome, attributionFromLead,
          stripEmDashes, applyIcpV2Filter, hunterService,
          channelHints: CHANNEL_HINTS,
          beaverState: require('./beaverState'),
        },
      });
      if (r.outcome === 'approved') {
        approvedCount++;
        diagnostics.messages_drafted++;
        execStatus.beavers.sales.approved++;
        execStatus.beavers.captain.approved++;
      } else if (r.outcome === 'rejected' || r.outcome === 'brand_safety_rejected') {
        rejectedCount++;
        diagnostics.messages_drafted++;
        execStatus.beavers.enforcer.rejected++;
      } else if (r.outcome === 'blocked_no_email') {
        diagnostics.messages_drafted++;
      } else if (r.outcome === 'manual_review') {
        diagnostics.messages_drafted++;
      } else {
        diagnostics.messages_failed++;
      }
      execStatus.progress.complete++;
      await updateExecStatus(clientId, plan_id, execStatus);
      return;
    }
    if (!lead.id || !lead.name || lead.name === 'Unknown Contact') {
      console.warn('[pipeline] Skipping lead with no identity:', lead.id, lead.name);
      // 2026-05-13: emit pipeline_traces so identity-skip is visible in funnel
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id || null, kickoff_id: plan_id,
        stage: 'icp_rejected', status: 'identity_skip',
        agent: 'director', pipeline_path: 'kickoff_pipeline',
        reason: 'missing_name_or_unknown_contact',
        metadata: { lead_name: lead.name || null },
      }).catch(() => {});
      diagnostics.messages_failed++;
      execStatus.progress.complete++;
      await updateExecStatus(clientId, plan_id, execStatus);
      return;
    }

    // P0-D: per-lead circuit breaker (same as signal_pipeline)
    const { rows: failRows } = await pool.query(
      `SELECT COUNT(*)::int AS fails FROM pipeline_traces
       WHERE client_id = $1 AND lead_id = $2 AND stage = 'draft_failed'
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [clientId, lead.id]
    ).catch(() => ({ rows: [{ fails: 0 }] }));
    if (failRows[0].fails >= 3) {
      console.warn(`[pipeline] Circuit breaker: ${lead.name} has ${failRows[0].fails} draft_failed in 24h — skipping`);
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id, kickoff_id: plan_id,
        stage: 'draft_failed', status: 'circuit_breaker_skip',
        agent: 'director', pipeline_path: 'kickoff_pipeline',
        metadata: { recent_failures: failRows[0].fails },
      }).catch(() => {});
      diagnostics.messages_failed++;
      return;
    }

    const meta = lead.metadata || {};
    const contextParts = [
      `Name: ${lead.name}`,
      `Company: ${lead.company}`,
      `Title: ${lead.title || 'N/A'}`,
    ];
    if (lead.linkedin_url) contextParts.push(`LinkedIn: ${lead.linkedin_url}`);
    const about = lead.short_description || meta.short_description;
    if (about) contextParts.push(`About: ${about}`);
    if (meta.signal) contextParts.push(`Signal (why reaching out now): ${meta.signal}`);
    if (meta.angle) contextParts.push(`Angle to lead with: ${meta.angle}`);
    if (meta.why_now) contextParts.push(`Why now: ${meta.why_now}`);
    if (meta.friction) contextParts.push(`Friction point: ${meta.friction}`);
    if (meta.notes) contextParts.push(`Personalisation hook: ${meta.notes}`);
    // Search context fallback: if no signal, use the snippet + search query
    if (!meta.signal && meta.snippet) contextParts.push(`LinkedIn profile snippet: ${meta.snippet}`);
    if (meta.search_query) contextParts.push(`Search context: ${meta.search_query}`);
    // Campaign command gives Sales Beaver the targeting intent
    if (command) contextParts.push(`Campaign intent: "${command}"`);

    // Search for personalisation signals before drafting
    await assertLlmBudgetOpen(clientId);
    try {
      const signals = await searchPersonalisationSignals(lead);
      if (signals.length > 0) {
        contextParts.push('');
        contextParts.push('RECENT SIGNALS (from web search — reference these if relevant):');
        for (const s of signals) {
          const dateStr = s.date ? ` (${s.date})` : '';
          contextParts.push(`- ${s.text}${dateStr} [source: ${s.source}]`);
        }
        console.log(`[sales-personalise] Found ${signals.length} signals for ${lead.name} at ${lead.company}`);
      }
    } catch (err) {
      console.warn(`[sales-personalise] Skipped for ${lead.name}:`, err.message);
    }

    // Sales Beaver status update
    execStatus.beavers.sales.task = `Drafting for ${lead.name} @ ${lead.company}`;
    execStatus.phase = 'sales';
    await updateExecStatus(clientId, plan_id, execStatus);

    // ── Single-channel selection: pick the BEST channel for this prospect ──
    // Rule: Day 0 goes on ONE channel only. Follow-ups stay on same channel.
    // After FU2 with no reply → escalate to next channel (handled in follow-up phase).
    // CHANNEL_HINTS moved to module scope (Jules F-03) so the signal pipeline shares it.

    // ── Email-priority enrichment via pipeline.enrichEmail ────────────────
    // Autonomous order: public web/domain evidence -> Hunter ->
    // MillionVerifier-backed pattern verification. VP is not used by Beaver
    // kickoff sourcing/enrichment.
    let linkedinAlreadyTried = false;
    await pipeline.enrichEmail(clientId, lead, {
      pipeline_path: 'pipeline',
      hunterService,
    });

    // If email enrichment found no email AND LinkedIn was previously attempted,
    // skip the lead entirely — no new channel available, recycling is waste.
    if (!lead.email && lead.linkedin_url) {
      const prevLinkedinRes = await pool.query(
        `SELECT id FROM messages
          WHERE client_id = $1 AND lead_id = $2 AND channel = 'linkedin'
            AND status NOT IN ('deleted')
          LIMIT 1`,
        [clientId, lead.id]
      );
      if (prevLinkedinRes.rows.length > 0) {
        linkedinAlreadyTried = true;
        console.log(`[pipeline] ${lead.name} — LinkedIn already tried, no enrichment found — skipping`);
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id, kickoff_id: plan_id,
          stage: 'skipped', status: 'channel_exhausted',
          agent: 'director', pipeline_path: 'kickoff_pipeline',
          metadata: { lead_name: lead.name },
        }).catch(() => {});
        diagnostics.messages_failed++;
        return;
      }
    }

    // Channel selection — single source of truth in selectChannel()
    const channelChoice = selectChannel(lead, { linkedinAlreadyTried });
    const selectedChannel = channelChoice.channel;
    const channelReason = channelChoice.reason;
    const kickoffMessageStatus = channelChoice.status;

    console.log(`[pipeline] Channel for ${lead.name}: ${selectedChannel} status=${kickoffMessageStatus} — ${channelReason}`);

    if (kickoffMessageStatus === 'channel_exhausted') {
      console.log(`[pipeline] ${lead.name} — channel exhausted, skipping draft: ${channelReason}`);
      diagnostics.messages_failed++;
      await logsService.createLog(clientId, {
        agent: 'director', action: 'lead_channel_exhausted',
        target_type: 'lead', target_id: lead.id,
        metadata: { reason: channelReason, path: 'kickoff_pipeline', lead_name: lead.name, channel: selectedChannel },
      }).catch(() => {});
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id, kickoff_id: plan_id,
        stage: 'skipped', status: 'channel_exhausted',
        agent: 'director', pipeline_path: 'kickoff_pipeline',
        reason: channelReason,
        metadata: { lead_name: lead.name, channel: selectedChannel },
      }).catch(() => {});
      return;
    }

    // 2026-05-23 SHORT-CIRCUIT (lead-completeness contract):
    // Mirror of the signal-pipeline guard. Incomplete leads must not consume
    // Sales Beaver / Enforcer tokens. Lead stays in `prospecting`; Research
    // Beaver event-driven enrichment moves it back into the pipeline once a
    // verified email or fresh LinkedIn URL lands. Both router sites must
    // ship this together (half-fix rule, corrections.md 2026-04-30).
    if (kickoffMessageStatus === 'blocked_no_email') {
      console.log(`[pipeline] ${lead.name} — incomplete (no usable channel), skipping draft`);
      diagnostics.messages_failed++;
      await logsService.createLog(clientId, {
        agent: 'director', action: 'lead_incomplete',
        target_type: 'lead', target_id: lead.id,
        metadata: { reason: channelReason, path: 'kickoff_pipeline', lead_name: lead.name },
      }).catch(() => {});
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id, kickoff_id: plan_id,
        stage: 'skipped', status: 'blocked_no_email',
        agent: 'director', pipeline_path: 'kickoff_pipeline',
        reason: channelReason,
        metadata: { lead_name: lead.name },
      }).catch(() => {});
      return;
    }

    const hint = CHANNEL_HINTS[selectedChannel];

    // ── Phase 3 pivot (2026-05-08): pre-draft lead readiness gate ─────
    // Replaces the legacy captainValidate post-draft check. We don't waste
    // Sales Beaver tokens on leads with missing name/company/contact-method.
    // captainValidate's placeholder + empty-body checks are dropped — Enforcer
    // already catches both via its rubric. Both pipelines now converge on
    // Enforcer-only post-draft review.
    const readiness = pipeline.leadReadinessGate(lead);
    if (!readiness.ready) {
      console.warn(`[pipeline] Pre-draft skip: ${lead.name || 'unknown'} @ ${lead.company || 'unknown'} — ${readiness.reason}`);
      diagnostics.messages_failed++;
      await logsService.createLog(clientId, {
        agent: 'director', action: 'lead_not_ready',
        target_type: 'lead', target_id: lead.id,
        metadata: { reason: readiness.reason, channel: selectedChannel, path: 'kickoff_pipeline' },
      }).catch(() => {});
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id,
        kickoff_id: plan_id,
        stage: 'icp_rejected',
        status: 'lead_not_ready',
        agent: 'director',
        reason: readiness.reason,
        pipeline_path: 'kickoff_pipeline',
        metadata: { lead_name: lead.name, lead_company: lead.company },
      }).catch(() => {});
      return;
    }

    try {
      // ── Dedup guard BEFORE draft (saves Sonnet tokens) ───────────────
      const existingActive = await pipeline.checkActiveMessage(clientId, lead.id);
      if (existingActive) {
        console.warn(`[pipeline] Dedup guard: ${lead.name} already has an active message — skipping`);
        diagnostics.messages_failed++;
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          stage: 'draft_skipped',
          status: 'dedup_guard',
          agent: 'director',
          reason: 'dedup_guard',
          pipeline_path: 'kickoff_pipeline',
          metadata: { channel: selectedChannel, existing_message_id: existingActive.id },
        }).catch(() => {});
        return;
      }

      // Sales Beaver draft via pipeline.draftWithFallback.
      const draft = await pipeline.draftWithFallback(clientId, {
        lead_id: lead.id,
        channel: selectedChannel,
        context: contextParts.join('\n') + `\n\nCHANNEL INSTRUCTIONS: ${hint}`,
        salesGenerate,
        captainDraft: captainFallbackDraft,
        enableEnforcerFallback: false,
        lead,
        pipeline_path: 'kickoff_pipeline',
        kickoff_id: plan_id,
      });
      const salesResult = draft
        ? { body: draft.body, subject: draft.subject, prompt_variant: draft.prompt_variant }
        : { body: null, subject: null, prompt_variant: null };
      const draftRequiresManualReview = draft?.manualReview === true || draft?.draftSource === 'captain_fallback';
      const effectiveLead = draft?.lead && typeof draft.lead === 'object' ? draft.lead : lead;
      const effectiveMeta = safeJsonObject(effectiveLead.metadata);
      const effectiveSignalPackage = draft?.signal_package || effectiveMeta.signal_package || null;
      const effectiveResearchRepair = draft?.research_repair || effectiveMeta.research_repair || null;
      const evidenceMetadata = {
        ...(effectiveSignalPackage ? { signal_package: effectiveSignalPackage } : {}),
        ...(effectiveResearchRepair ? { research_repair: effectiveResearchRepair } : {}),
      };

      if (!salesResult?.body) {
        console.warn(`[pipeline] Sales draft failed for ${lead.name} (${selectedChannel}): no body`);
        diagnostics.messages_failed++;
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          stage: 'draft_failed',
          status: 'no_body',
          agent: 'sales_beaver',
          reason: 'no_body',
          pipeline_path: 'kickoff_pipeline',
          metadata: { channel: selectedChannel, enrichment_eligible: !!(lead.company && lead.title) },
        }).catch(() => {});
      } else {
        diagnostics.messages_drafted++;
        execStatus.beavers.sales.drafted++;

        // Phase 2 Step 2 (2026-05-08): INSERT via pipeline.persistDraft
        const message = await pipeline.persistDraft(clientId, {
          lead_id: lead.id,
          channel: selectedChannel,
          subject: salesResult.subject || null,
          body: salesResult.body,
          status: draftRequiresManualReview ? 'pending_approval' : kickoffMessageStatus,
          draft_source: draft?.draftSource || 'sales_beaver',
          prompt_variant: salesResult.prompt_variant,
          signal: effectiveMeta.signal || null,
          metadata: {
            ...(draftRequiresManualReview ? { captain_fallback_reason: draft.reason || null } : {}),
            ...evidenceMetadata,
          },
          kickoff_id: plan_id,
          pipeline_path: 'kickoff_pipeline',
        });
        const msgWithMeta = { ...message, lead_name: effectiveLead.name || lead.name, lead_company: effectiveLead.company || lead.company };
        savedMessages.push(msgWithMeta);

        await logsService.createLog(clientId, {
          agent: 'sales_beaver',
          action: 'message_created',
          target_type: 'message',
          target_id: message.id,
          metadata: { lead_id: lead.id, lead_name: effectiveLead.name || lead.name, channel: selectedChannel, status: kickoffMessageStatus, reason: channelReason },
        });
        // (Phase 2 Step 2: drafted trace now emitted internally by pipeline.persistDraft above)

        // Phase D piece 2 — outcome attribution: drafted event
        recordOutcome(clientId, {
          outcome: 'drafted',
          leadId: lead.id,
          messageId: message.id,
          channel: selectedChannel,
          ...attributionFromLead(effectiveLead),
          eventData: { source_path: 'kickoff_pipeline', status: draftRequiresManualReview ? 'pending_approval' : kickoffMessageStatus, reason: channelReason },
        });

        if (draftRequiresManualReview) {
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by, status)
             VALUES ($1, $2, 'captain_fallback', 'pending')`,
            [clientId, message.id]
          ).catch(() => {});
          await logsService.createLog(clientId, {
            agent: 'captain_beaver',
            action: 'captain_fallback_draft',
            target_type: 'message',
            target_id: message.id,
            metadata: { lead_name: effectiveLead.name || lead.name, channel: selectedChannel, reason: draft.reason || null, pipeline_path: 'kickoff_pipeline' },
          }).catch(() => {});
          return;
        }

        // If blocked, skip Enforcer — message is on hold for enrichment.
        if (kickoffMessageStatus === 'blocked_no_email') {
          return;
        }

        // ── Phase 3 pivot (2026-05-08): captainValidate post-draft gate REMOVED ─
        // Lead-data integrity (name/company/contact-method) now checked pre-draft
        // via pipeline.leadReadinessGate above. Placeholder + empty-body checks
        // are dropped — Enforcer's rubric catches both. Per MJ direction:
        // "buying signal is over everything" → Enforcer is THE quality gate.
        // captainValidate function still exists in this file (no callers) and
        // will be removed in Phase 2 Step 7 cleanup.

        // ── Enforcer review pipeline (server gates + AI Enforcer) ──
        await runRangerPipeline(effectiveLead, msgWithMeta);
      }
    } catch (err) {
      console.error('[pipeline] Sales draft/save failed for lead:', lead.name, selectedChannel, err.message);
      diagnostics.messages_failed++;
    }

    execStatus.progress.complete++;
    await updateExecStatus(clientId, plan_id, execStatus);
  }

  // ── Ranger review pipeline per message (Phase A: auto-fix first, then AI review) ──
  async function runRangerPipeline(lead, msg) {
    // ── Phase A: Auto-fix pre-pass BEFORE the Enforcer runs ──
    // Reject → Fix → Retry, not Reject → Drop.
    // autoFixMessage handles em dash, bullets, word count, soft CTAs, banned phrases,
    // multi-questions. Only brand-safety issues reach the Enforcer as hard reject.
    const touchNumber = msg.touch_number || 0;
    const preFixResult = autoFixMessage(msg.body || '', { touchNumber, maxWords: 80 });
    let currentBody = preFixResult.body;
    let currentSubject = stripEmDashes(msg.subject);

    if (preFixResult.fixes.length > 0) {
      console.log(`[pipeline] Auto-fixed message ${msg.id}: ${preFixResult.fixes.join(', ')}`);
      // Persist the fixed body immediately so we review the clean version
      await pool.query(
        `UPDATE messages SET body = $1, metadata = jsonb_set(COALESCE(metadata, '{}'), '{autofix}', $2::jsonb)
         WHERE id = $3 AND client_id = $4`,
        [currentBody, JSON.stringify(preFixResult.fixes), msg.id, clientId]
      );
    }

    execStatus.beavers.enforcer.status = 'working';
    execStatus.phase = 'enforcer';
    execStatus.beavers.enforcer.task = `Checking ${msg.channel} for ${msg.lead_name}`;
    await updateExecStatus(clientId, plan_id, execStatus);
    execStatus.beavers.enforcer.reviewed++;

    // ── Brand-safety hard check (unfixable — drop if any hit) ──
    const safety = brandSafetyCheck(currentBody, {
      name: lead.name, company: lead.company, title: lead.title,
      signal: lead.metadata?.signal, why_now: lead.metadata?.why_now,
    });
    if (!safety.safe) {
      await pool.query(
        `UPDATE messages SET ranger_score = 0, ranger_notes = $1, status = 'ranger_rejected', updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [`Brand safety: ${safety.reason}`, msg.id, clientId]
      );
      await logsService.createLog(clientId, {
        agent: 'enforcer_beaver',
        action: 'message_rejected',
        target_type: 'message',
        target_id: msg.id,
        metadata: { reason: safety.reason, channel: msg.channel, method: 'brand_safety' },
      });
      rejectedCount++;
      execStatus.beavers.enforcer.rejected++;
      execStatus.beavers.enforcer.status = 'done';
      return;
    }

    // ── AI Enforcer review (fail-CLOSED 2026-05-13 — was fail-OPEN) ──
    let rangerResult;
    try {
      rangerResult = await rangerReview(clientId, {
        message_id: msg.id,
        message_body: currentBody,
        lead_context: {
          name: lead.name,
          company: lead.company,
          title: lead.title,
          email: lead.email,
          lead_id: lead.id,
          signal: lead.metadata?.signal,
          angle: lead.metadata?.angle,
          friction: lead.metadata?.friction,
          why_now: lead.metadata?.why_now,
          signal_package: lead.metadata?.signal_package,
          research_repair: lead.metadata?.research_repair,
          channel: msg.channel,
          pipeline_path: 'kickoff_pipeline',
          touch_number: touchNumber,
        },
      });
      // Enforcer may have further polished the body — use its returned version
      if (rangerResult?.body) currentBody = rangerResult.body;
    } catch (err) {
      console.warn('[pipeline] AI Enforcer unavailable, REJECTING for manual review (fail-closed):', err.message);
      // Fail-CLOSED 2026-05-13: cannot validate without Enforcer. Triggers existing
      // rejection flow (Sales redraft up to 2x, then Captain fallback,
      // then ranger_rejected status if all attempts fail).
      rangerResult = {
        approved: false,
        decision: 'reject',
        score: 0,
        notes: `Enforcer unavailable (Claude API failed) — manual review required. Auto-fix applied: ${preFixResult.fixes.join(',') || 'none'}`,
        breakdown: null,
      };
      await logMistake(clientId, 'enforcer_beaver', 'Claude call failed during Enforcer review', err.message, 'Enforcer fail-CLOSED — manual review required');
    }

    if (!rangerResult?.approved) {
      if (rangerResult?.repair_route === 'needs_research_repair') {
        if (rangerResult?.captain_fallback?.body) {
          await surfaceUnrewrittenDraft(clientId, {
            messageId: msg.id,
            body: rangerResult.captain_fallback.body,
            subject: rangerResult.captain_fallback.subject || currentSubject,
            reason: rangerResult?.notes || 'research_repair_exhausted',
            requestedBy: 'captain_fallback',
            agent: 'captain_beaver',
            action: 'captain_fallback_draft',
            note: 'Captain fallback — Research repair already exhausted. Review before sending.',
          });
        } else {
          await pool.query(
            `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW()
             WHERE id = $2 AND client_id = $3`,
            [rangerResult?.required_repair || rangerResult?.notes || 'Routed to Research repair; Sales redraft skipped until Research repairs the lead.', msg.id, clientId]
          );
          rejectedCount++;
          execStatus.beavers.enforcer.rejected++;
        }
        execStatus.beavers.enforcer.status = 'done';
        return;
      }

      // ── Rejection feedback loop: Sales redrafts with Enforcer's specific feedback ──
      // Get current attempt count from DB
      const attemptRow = await pool.query(
        `SELECT ranger_attempt_count FROM messages WHERE id = $1 AND client_id = $2`,
        [msg.id, clientId]
      );
      const attemptCount = attemptRow.rows[0]?.ranger_attempt_count || 0;

      if (attemptCount < 2) {
        // Sales Beaver gets another chance with explicit rejection feedback
        const rejectionFeedback = rangerResult?.reject_reason || rangerResult?.notes || 'Message did not pass quality gates';
        const feedbackContext = [
          `Name: ${lead.name}`,
          `Company: ${lead.company}`,
          `Title: ${lead.title || 'N/A'}`,
          lead.metadata?.signal ? `Signal: ${lead.metadata.signal}` : '',
          lead.metadata?.angle ? `Angle: ${lead.metadata.angle}` : '',
          lead.metadata?.friction ? `Friction: ${lead.metadata.friction}` : '',
          `\nPREVIOUS ATTEMPT REJECTED: ${rejectionFeedback}`,
          `Previous message that was rejected:\n${currentBody}`,
          `\nRewrite the message fixing the issue above. Do NOT repeat the same structure.`,
          `\nCRITICAL REMINDER: Day 0 email body must be 50-60 words MAX (hard reject at 81+). Count your words. Exclude greeting and sign-off from the count. Use ONE sentence per section (hook, pain bridge, question). Shorter is better.`,
        ].filter(Boolean).join('\n');

        try {
          const redraftResult = await salesGenerate(clientId, {
            lead_id: lead.id,
            channel: msg.channel,
            context: feedbackContext,
          });

          if (redraftResult?.body) {
            currentBody = stripEmDashes(redraftResult.body);
            currentSubject = redraftResult.subject || currentSubject;

            // Save updated draft + increment attempt count
            await pool.query(
              `UPDATE messages SET body = $1, subject = $2, ranger_attempt_count = $3,
               ranger_notes = $4, status = 'pending_ranger', updated_at = NOW()
               WHERE id = $5 AND client_id = $6`,
              [currentBody, currentSubject, attemptCount + 1, `Redraft ${attemptCount + 1}: fixing — ${rejectionFeedback}`, msg.id, clientId]
            );

            await logsService.createLog(clientId, {
              agent: 'sales_beaver',
              action: 'message_redrafted',
              target_type: 'message',
              target_id: msg.id,
              metadata: { attempt: attemptCount + 1, rejection_reason: rejectionFeedback, lead_name: lead.name },
            });

            // Re-run Enforcer on the new draft
            rangerResult = await rangerReview(clientId, {
              message_id: msg.id,
              message_body: currentBody,
              lead_context: {
                name: lead.name,
                company: lead.company,
                title: lead.title,
                email: lead.email,
                lead_id: lead.id,
                signal: lead.metadata?.signal,
                angle: lead.metadata?.angle,
                friction: lead.metadata?.friction,
                why_now: lead.metadata?.why_now,
                signal_package: lead.metadata?.signal_package,
                research_repair: lead.metadata?.research_repair,
                channel: msg.channel,
                pipeline_path: 'kickoff_pipeline',
                touch_number: touchNumber,
              },
            });

            // ─── Sales Beaver improvement-after-feedback tracker ──
            // Did the retry actually fix the flagged issue? This metric
            // closes Enforcer's coaching loop — if Sales repeatedly fixes
            // his mistakes after feedback, Enforcer's coaching is landing.
            try {
              const beaverState = require('./beaverState');
              await beaverState.recordImprovementAfterFeedback(clientId, {
                lead_id: lead.id,
                original_message_id: msg.id,
                retry_message_id: msg.id,
                original_reject_reason: rejectionFeedback,
                retry_passed: rangerResult?.approved === true,
              }).catch(() => {});
            } catch (_) { /* non-fatal */ }

            // If still rejected after redraft, Captain writes the manual-review fallback.
            if (!rangerResult?.approved) {
              if (rangerResult?.repair_route === 'needs_research_repair') {
                if (rangerResult?.captain_fallback?.body) {
                  await surfaceUnrewrittenDraft(clientId, {
                    messageId: msg.id,
                    body: rangerResult.captain_fallback.body,
                    subject: rangerResult.captain_fallback.subject || currentSubject,
                    reason: rangerResult?.notes || 'research_repair_exhausted',
                    requestedBy: 'captain_fallback',
                    agent: 'captain_beaver',
                    action: 'captain_fallback_draft',
                    note: 'Captain fallback — Research repair already exhausted. Review before sending.',
                  });
                } else {
                  await pool.query(
                    `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW()
                     WHERE id = $2 AND client_id = $3`,
                    [rangerResult?.required_repair || rangerResult?.notes || 'Routed to Research repair after Sales redraft.', msg.id, clientId]
                  );
                  rejectedCount++;
                  execStatus.beavers.enforcer.rejected++;
                }
                execStatus.beavers.enforcer.status = 'done';
                return;
              }
              const finalRejectReason = rangerResult?.notes || 'Sales Beaver failed after bounded redrafts';
              const surfaced = await surfaceCaptainFallbackDraft(clientId, {
                messageId: msg.id,
                lead,
                channel: msg.channel,
                reason: finalRejectReason,
                rejectedBody: currentBody,
                subject: currentSubject,
                signalPackage: lead.metadata?.signal_package || null,
                note: 'Captain fallback - Sales Beaver failed after bounded redrafts. Review before sending.',
              });
              if (surfaced) {
                execStatus.beavers.enforcer.status = 'done';
                return;
              } else {
                await pool.query(
                  `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2`,
                  [`Sales Beaver failed ${attemptCount + 1} attempts; Captain fallback also failed.`, msg.id]
                );
                rejectedCount++;
                execStatus.beavers.enforcer.rejected++;
                execStatus.beavers.enforcer.status = 'done';
                return;
              }
            }
          }
        } catch (redraftErr) {
          console.warn('[pipeline] Sales redraft failed, marking rejected:', redraftErr.message);
          // Fall through to final rejection below
          rangerResult.approved = false;
        }
      }

      // Final rejection - Sales exhausted all retries, Captain writes manual-review fallback.
      if (!rangerResult?.approved) {
        if (rangerResult?.repair_route === 'needs_research_repair') {
          if (rangerResult?.captain_fallback?.body) {
            await surfaceUnrewrittenDraft(clientId, {
              messageId: msg.id,
              body: rangerResult.captain_fallback.body,
              subject: rangerResult.captain_fallback.subject || currentSubject,
              reason: rangerResult?.notes || 'research_repair_exhausted',
              requestedBy: 'captain_fallback',
              agent: 'captain_beaver',
              action: 'captain_fallback_draft',
              note: 'Captain fallback — Research repair already exhausted. Review before sending.',
            });
          } else {
            await pool.query(
              `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW()
               WHERE id = $2 AND client_id = $3`,
              [rangerResult?.required_repair || rangerResult?.notes || 'Routed to Research repair after Sales retries exhausted.', msg.id, clientId]
            );
            rejectedCount++;
            execStatus.beavers.enforcer.rejected++;
          }
          execStatus.beavers.enforcer.status = 'done';
          return;
        }
        const finalRejectReason = rangerResult?.notes || 'Sales Beaver failed after bounded redrafts';
        const surfaced = await surfaceCaptainFallbackDraft(clientId, {
          messageId: msg.id,
          lead,
          channel: msg.channel,
          reason: finalRejectReason,
          rejectedBody: currentBody,
          subject: currentSubject,
          signalPackage: lead.metadata?.signal_package || null,
          note: 'Captain fallback - Sales Beaver failed after bounded redrafts. Review before sending.',
        });
        if (surfaced) {
          execStatus.beavers.enforcer.status = 'done';
          return;
        } else {
          await pool.query(
            `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2`,
            ['Sales failed after bounded redrafts and Captain fallback did not produce a draft. Manual message required.', msg.id]
          );
          rejectedCount++;
          execStatus.beavers.enforcer.rejected++;
          execStatus.beavers.enforcer.status = 'done';
          return;
        }
      }
    }

    // ── Final pre-save auto-fix pass (catches anything that slipped through) ──
    // Phase A: we no longer reject here. We run autoFixMessage again as a safety net.
    const finalFix = autoFixMessage(currentBody, { touchNumber, maxWords: 80 });
    if (finalFix.fixes.length > 0) {
      console.log(`[enforcer] Final pass fixes for ${msg.id}: ${finalFix.fixes.join(', ')}`);
      currentBody = finalFix.body;
    }

    // ── Enforcer approved → auto-approve / borderline / manual decision ──
    // Phase 2 Step 6 (Jules F-11): shared pipeline.applyEnforcerDecision.
    await pipeline.applyEnforcerDecision(clientId, {
      msg,
      lead,
      rangerResult,
      finalBody: currentBody,
      subject: currentSubject,
      kickoffId: null,
      pipelinePath: msg.metadata?.pipeline_path || 'kickoff_pipeline',
      source: 'kickoff_pipeline',
    });
    approvedCount++;
    execStatus.beavers.sales.approved++;
    execStatus.beavers.enforcer.status = 'done';
    execStatus.beavers.captain.status = 'done';
    execStatus.beavers.captain.approved++;
  }

  // ── Run pipeline: process leads sequentially (each lead triggers parallel channel drafts) ──
  for (const lead of leadsToProcess) {
    await processLeadPipeline(lead);
  }

  // Combine DB-first + research counts for final summary
  const totalLeadsFound = leadsFoundSoFar + savedLeads.length + dbLeadsCount + signalLeadsCount;
  const totalMessagesDrafted = draftedSoFar + dbDraftedCount + signalDraftedCount + diagnostics.messages_drafted;
  const attemptApproved = dbApprovedCount + signalApprovedCount + approvedCount;
  const totalApproved = deliveredSoFar + attemptApproved;
  const totalRejected = rejectedSoFar + dbRejectedCount + signalRejectedCount + rejectedCount;
  const targetShortfall = Math.max(0, campaignRequested - totalApproved);
  const targetFulfilled = targetShortfall === 0;

  if (!targetFulfilled && completionAttempt < maxCompletionAttempts) {
    const retryCapacity = await getSearchProviderCapacity(clientId);
    if (retryCapacity.hasCapacity) {
      await logsService.createLog(clientId, {
        agent: 'director',
        action: 'campaign_completion_retry',
        metadata: {
          plan_id,
          requested: campaignRequested,
          delivered: totalApproved,
          shortfall: targetShortfall,
          completion_attempt: completionAttempt + 1,
          providers: retryCapacity.providers,
        },
      }).catch(() => {});
      return await directorExecute(clientId, {
        plan_id,
        command,
        batchIndex: batchIndex + 1,
        limit: targetShortfall,
        completionAttempt: completionAttempt + 1,
        maxCompletionAttempts,
        requestedTarget: campaignRequested,
        deliveredSoFar: totalApproved,
        draftedSoFar: totalMessagesDrafted,
        rejectedSoFar: totalRejected,
        leadsFoundSoFar: totalLeadsFound,
        allowPaidSignal,
        sourceMode,
        maxPaidSignalQueries,
      });
    }
  }

  // Final status update: output complete or truthfully blocked.
  await updateExecStatus(clientId, plan_id, {
    status: targetFulfilled ? 'completed' : 'blocked',
    phase: 'captain',
    beavers: {
      research: { status: 'done', task: `${savedLeads.length} new leads found`, found: rawLeads.length, passed: savedLeads.length },
      sales:    { status: 'done', task: `${totalMessagesDrafted} messages drafted`, drafted: totalMessagesDrafted, approved: totalApproved },
      enforcer: { status: 'done', task: `${totalApproved} approved, ${totalRejected} rejected`, reviewed: totalMessagesDrafted, rejected: totalRejected },
      captain:  { status: targetFulfilled ? 'done' : 'blocked', task: `${totalApproved}/${campaignRequested} requested outputs delivered`, approved: totalApproved },
    },
    progress: { total: campaignRequested, complete: Math.min(campaignRequested, totalApproved) },
    started_at: new Date().toISOString(),
  });

  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'plan_completed',
    metadata: {
      plan_id,
      requested: campaignRequested,
      delivered: totalApproved,
      target_fulfilled: targetFulfilled,
      shortfall: targetShortfall,
      leads_found: totalLeadsFound,
      db_leads: dbLeadsCount,
      research_leads: savedLeads.length,
      messages_drafted: totalMessagesDrafted,
      approved: totalApproved,
      rejected: totalRejected,
    },
  });

  const { rows: [fuRow] } = await pool.query(
    `SELECT COUNT(*) FROM messages WHERE client_id = $1 AND status IN ('pending_approval', 'pending_send') AND metadata->>'is_followup' = 'true'`,
    [clientId]
  );
  const followupsPending = parseInt(fuRow.count, 10);

  const summary = {
    requested: campaignRequested,
    delivered: totalApproved,
    shortfall: targetShortfall,
    target_fulfilled: targetFulfilled,
    leads_found: totalLeadsFound,
    messages_drafted: totalMessagesDrafted,
    approved: totalApproved,
    rejected: totalRejected,
    new_outreach_pending: totalApproved,
    followups_pending: followupsPending,
    pending_your_approval: totalApproved + followupsPending,
    db_leads_processed: dbLeadsCount,
    db_approved: dbApprovedCount,
    signal_leads_processed: signalPipelineLeadCount,
    signal_leads_saved: signalLeadsCount,
    signal_approved: signalApprovedCount,
    research_approved: approvedCount,
  };

  await logsService.createLog(clientId, {
    agent: 'director',
    action: targetFulfilled ? 'campaign_target_fulfilled' : 'campaign_target_unfulfilled',
    metadata: {
      plan_id,
      requested: campaignRequested,
      delivered: totalApproved,
      shortfall: targetShortfall,
      target_fulfilled: targetFulfilled,
      completion_attempt: completionAttempt,
      providers: diagnostics.search_capacity?.providers || null,
    },
  }).catch(() => {});

  // ─── Daily KPI report to Captain (Sales + Enforcer perspectives) ──
  // Mirrors the Research Beaver pattern in services/research.js. Each beaver
  // self-reports its 24h output to agent_memory so Captain's morning brief
  // can read agent-perspective deltas instead of recomputing from raw tables.
  // Failure non-fatal — directorExecute completes regardless.
  try {
    const beaverState = require('./beaverState');
    const passRate = totalMessagesDrafted > 0
      ? Math.round((totalApproved / totalMessagesDrafted) * 100)
      : null;

    beaverState.reportDailyKPIs(clientId, 'sales_beaver', {
      drafted: totalMessagesDrafted,
      drafted_failed: diagnostics.messages_failed || 0,
      approved_first_pass: totalApproved,
      first_pass_rate_pct: passRate,
      followups_pending: followupsPending,
      run_kind: signalLeadsCount > 0 ? 'signal_first' : (dbLeadsCount > 0 ? 'pool_drain' : 'cold_research'),
      plan_id,
    }).catch(err => console.warn('[sales_beaver] daily KPI report failed:', err.message));

    // Note: Enforcer KPIs persist under agent='ranger' to match the
    // canonical name beaverState.readAllBeaversKPIsForToday() reads from.
    beaverState.reportDailyKPIs(clientId, 'ranger', {
      reviewed: totalMessagesDrafted,
      approved: totalApproved,
      rejected: totalRejected,
      approve_rate_pct: passRate,
      plan_id,
    }).catch(err => console.warn('[ranger] daily KPI report failed:', err.message));
  } catch (err) {
    console.warn('[directorExecute] beaverState KPI wiring failed:', err.message);
  }

  // Post-campaign learning — fire-and-forget, never blocks the response
  try {
    const { postCampaignDebrief } = require('./learningEngine');
    postCampaignDebrief(clientId, {
      planId: plan_id,
      leadsFound: totalLeadsFound,
      messagesDrafted: totalMessagesDrafted,
      enforcerPassed: totalApproved,
      enforcerFailed: totalRejected,
    }).catch(() => {});
  } catch { /* learningEngine optional */ }

  return {
    plan_id,
    status: targetFulfilled ? 'completed' : 'blocked',
    leads: savedLeads.map(l => ({ name: l.name, company: l.company, title: l.title })),
    leads_found: totalLeadsFound,
    messages_drafted: totalMessagesDrafted,
    messages_failed: diagnostics.messages_failed,
    summary,
    diagnostics,
    results: [
      ...(dbLeadsCount > 0 ? [{ step: 0, agent: 'research_beaver', status: 'completed', result: `${dbLeadsCount} existing lead${dbLeadsCount !== 1 ? 's' : ''} processed from DB` }] : []),
      ...(signalLeadsCount > 0 ? [{ step: 1, agent: 'signal_hunt', status: 'completed', result: `${signalPipelineLeadCount} signal lead${signalPipelineLeadCount !== 1 ? 's' : ''} processed first; ${signalLeadsCount} saved` }] : []),
      { step: 1, agent: 'research_beaver', status: 'completed', result: `${savedLeads.length} new lead${savedLeads.length !== 1 ? 's' : ''} found via research` },
      { step: 2, agent: 'sales_beaver', status: 'completed', result: `${totalMessagesDrafted} message${totalMessagesDrafted !== 1 ? 's' : ''} drafted (1 message per lead, best channel)` },
      { step: 3, agent: 'ranger', status: 'completed', result: `${totalApproved} approved${totalRejected > 0 ? `, ${totalRejected} rejected by server gates` : ''}` },
      { step: 4, agent: 'director', status: targetFulfilled ? 'completed' : 'blocked', result: [
        totalApproved > 0 ? `${totalApproved} new outreach in approval queue` : 'All new outreach failed Ranger QA',
        followupsPending > 0 ? `${followupsPending} follow-up${followupsPending !== 1 ? 's' : ''} awaiting review` : null,
        !targetFulfilled ? `${targetShortfall} short of requested ${campaignRequested}` : null,
      ].filter(Boolean).join(' + ') || 'Nothing in queue' },
    ],
  };
}

/**
 * =========================
 * DIRECTOR — BRIEF
 * =========================
 */
async function directorBrief(clientId) {
  const [leadsRes, messagesRes, approvalsRes, logsRes, leadsWeekRes] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM leads WHERE client_id = $1 AND deleted_at IS NULL', [clientId]),
    pool.query('SELECT COUNT(*) FROM messages WHERE client_id = $1', [clientId]),
    pool.query(
      `SELECT COUNT(*)
         FROM approvals a
         JOIN messages m ON m.id = a.message_id AND m.client_id = a.client_id
        WHERE a.client_id = $1
          AND a.status IN ('pending', 'pending_approval')
          AND COALESCE(a.notes, '') <> 'linkedin_requested'
          AND m.status = 'pending_approval'`,
      [clientId]
    ),
    pool.query('SELECT agent, action, created_at FROM logs WHERE client_id = $1 ORDER BY created_at DESC LIMIT 5', [clientId]),
    pool.query("SELECT COUNT(*) FROM leads WHERE client_id = $1 AND deleted_at IS NULL AND created_at >= NOW() - INTERVAL '7 days'", [clientId]),
  ]);

  const stats = {
    total_leads: parseInt(leadsRes.rows[0].count, 10),
    messages_sent: parseInt(messagesRes.rows[0].count, 10),
    pending_approvals: parseInt(approvalsRes.rows[0].count, 10),
    leads_this_week: parseInt(leadsWeekRes.rows[0].count, 10),
  };

  let summary = `Pipeline has ${stats.total_leads} leads, ${stats.messages_sent} messages generated, and ${stats.pending_approvals} reviewable approval${stats.pending_approvals !== 1 ? 's' : ''} waiting in the app. LinkedIn awaiting accept is not counted as review work.`;

  if (callAgent) {
    try {
      const result = await callAgent(
        'brief_writer',
        `Stats: ${JSON.stringify(stats)}. Recent activity: ${JSON.stringify(logsRes.rows.map(l => `${l.agent}: ${l.action}`))}.`,
        { stats }
      );
      if (result?.summary) summary = result.summary;
    } catch {
      // use default summary
    }
  }

  return { summary, stats };
}

/**
 * =========================
 * CLIENT PERSONA
 * =========================
 */
async function getClientPersona(clientId) {
  const res = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'system' AND key = 'client_persona' LIMIT 1`,
    [clientId]
  );
  return res.rows[0]?.content || {};
}

async function upsertClientPersona(clientId, data) {
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
     VALUES ($1, 'system', 'persona', 'client_persona', $2)
     ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $2, updated_at = NOW()`,
    [clientId, JSON.stringify(data)]
  );
  return data;
}

function buildPersonaContext(persona) {
  if (!persona || Object.keys(persona).length === 0) return '';
  return `\n\nCLIENT CONTEXT — you are writing outreach on behalf of this company:\n${JSON.stringify(persona, null, 2)}\n`;
}

/**
 * =========================
 * DIRECTOR — ICP
 * =========================
 */
async function directorGetICP(clientId) {
  const res = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
    [clientId]
  );
  return res.rows[0]?.content || {};
}

async function directorUpsertICP(clientId, data) {
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
     VALUES ($1, 'director', 'icp', 'icp', $2)
     ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $2, updated_at = NOW()`,
    [clientId, JSON.stringify(data)]
  );
  return data;
}

/**
 * =========================
 * SALES BEAVER — PROPOSAL
 * =========================
 * Generate a personalised proposal document for a lead after a qualified conversation.
 */
async function salesProposal(clientId, leadId) {
  // Fetch lead details
  const leadRes = await pool.query(
    `SELECT name, company, title, metadata FROM leads WHERE id = $1 AND client_id = $2 LIMIT 1`,
    [leadId, clientId]
  );
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found');

  // Fetch conversation history
  const historyRes = await pool.query(
    `SELECT subject, body, reply_snippet, created_at FROM messages
     WHERE lead_id = $1 AND client_id = $2
     ORDER BY created_at ASC LIMIT 10`,
    [leadId, clientId]
  );
  const history = historyRes.rows;

  const [persona, fileConfig] = await Promise.all([
    getClientPersona(clientId),
    getClientConfig(clientId),
  ]);
  const personaContext = buildPersonaContext(persona);
  const fileContext = buildClientContext(fileConfig);
  const meta = lead.metadata || {};

  const prompt = `Generate a personalised sales proposal for this prospect.

LEAD:
- Name: ${lead.name}
- Company: ${lead.company}
- Title: ${lead.title || 'N/A'}
- Pain signal: ${meta.signal || meta.friction || 'Not specified'}
- Angle used: ${meta.angle || 'General pain'}

CONVERSATION HISTORY:
${history.map(m => `Sent: ${m.body}${m.reply_snippet ? `\nTheir reply: ${m.reply_snippet}` : ''}`).join('\n---\n')}

Write a full proposal document. Sections:
1. Problem Statement (use their words/signals — be specific, not generic)
2. Our Approach (what we do and how it applies to their situation)
3. Expected Outcome (specific, measurable where possible)
4. Investment (keep placeholder: "RM X,XXX/month — finalised in our call")
5. Next Step (one clear action — usually a short call to confirm fit)

Rules:
- Every line must be specific to this prospect — no generic filler
- Use the conversation history to reference things they've said or signals detected
- Tone: professional but conversational, not corporate
- No bullet points in the main body — use short paragraphs${personaContext}${fileContext}

Return JSON only:
{"subject":"Proposal subject line","body":"Full proposal document as flowing text","pain_summary":"One sentence: the core pain we're solving for them","value_hypothesis":"One sentence: the outcome we deliver"}`;

  if (!callAgent) throw new Error('Claude not available');

  const result = await callAgent('sales_beaver', prompt, { lead_id: leadId, clientId, channel: 'email', mode: 'proposal' });

  await logsService.createLog(clientId, {
    agent: 'sales_beaver',
    action: 'proposal_generated',
    target_type: 'lead',
    target_id: leadId,
    metadata: { lead_name: lead.name, lead_company: lead.company },
  });

  return {
    lead_id: leadId,
    lead_name: lead.name,
    lead_company: lead.company,
    subject: result?.subject || `Proposal for ${lead.company}`,
    body: result?.body || '',
    pain_summary: result?.pain_summary || '',
    value_hypothesis: result?.value_hypothesis || '',
  };
}

/**
 * =========================
 * WIN/LOSS LEARNING CAPTURE
 * =========================
 * Captures outcome data when a deal is won, lost, or goes cold.
 * Builds a learning object and appends it to the director's weekly_learnings memory.
 * Per CLAUDE.md: "After every deal outcome (won/lost/cold), extract what signals
 * were missed and feed into weekly_learnings."
 */
async function captureWinLoss(clientId, { lead_id, outcome, notes }) {
  if (!['won', 'lost', 'cold'].includes(outcome)) {
    throw Object.assign(new Error('outcome must be won, lost, or cold'), { status: 400 });
  }

  // 1. Load lead
  const { rows: [lead] } = await pool.query(
    `SELECT id, name, company, status, pipeline_stage, created_at, metadata
     FROM leads WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [lead_id, clientId]
  );
  if (!lead) {
    throw Object.assign(new Error('Lead not found'), { status: 404 });
  }

  // 2. Load all messages for this lead
  const { rows: messages } = await pool.query(
    `SELECT id, subject, body, channel, status, created_at, sent_at, metadata
     FROM messages WHERE lead_id = $1 AND client_id = $2
     ORDER BY created_at ASC`,
    [lead_id, clientId]
  );

  // 3. Build learning object
  const firstMessage = messages[0] || {};
  const lastMessage = messages[messages.length - 1] || {};
  const pipelineStart = lead.created_at ? new Date(lead.created_at) : null;
  const pipelineEnd = lastMessage.sent_at ? new Date(lastMessage.sent_at) : new Date();
  const daysInPipeline = pipelineStart
    ? Math.max(0, Math.round((pipelineEnd - pipelineStart) / (1000 * 60 * 60 * 24)))
    : 0;

  const learning = {
    outcome,
    lead_name: lead.name,
    company: lead.company,
    channel_used: firstMessage.channel || null,
    hook_used: firstMessage.subject || null,
    messages_sent: messages.filter(m => m.status === 'sent').length,
    days_in_pipeline: daysInPipeline,
    signal_that_triggered: lead.metadata?.signal || lead.metadata?.source || null,
    notes: notes || null,
    captured_at: new Date().toISOString(),
  };

  // 4. Append to agent_memory key 'weekly_learnings' for agent 'director' (max 50)
  const existing = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'weekly_learnings' LIMIT 1`,
    [clientId]
  );
  let learnings = [];
  if (existing.rows.length > 0) {
    const prev = existing.rows[0].content;
    learnings = Array.isArray(prev) ? prev : [];
  }
  learnings.unshift(learning);
  learnings = learnings.slice(0, 50); // cap at 50 entries

  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
     VALUES ($1, 'director', 'learnings', 'weekly_learnings', $2)
     ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $2, updated_at = NOW()`,
    [clientId, JSON.stringify(learnings)]
  );

  // 5. Update lead status to reflect outcome
  const stageMap = { won: 'closed_won', lost: 'closed_lost', cold: 'cold' };
  await pool.query(
    `UPDATE leads SET status = $1, pipeline_stage = $2, updated_at = NOW()
     WHERE id = $3 AND client_id = $4`,
    [outcome, stageMap[outcome], lead_id, clientId]
  );

  // 6. Log to activity log
  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'win_loss_captured',
    target_type: 'lead',
    target_id: lead_id,
    metadata: learning,
  });

  return learning;
}

module.exports = {
  researchSearch,
  salesGenerate,
  salesProposal,
  rangerReview,
  rangerDraft,
  captainFallbackDraft,
  directorPlan,
  directorExecute,
  directorBrief,
  directorGetICP,
  directorUpsertICP,
  getClientPersona,
  upsertClientPersona,
  // Memory helpers (Sprint 9)
  getMemory,
  logMistake,
  getRangerRejectionPatterns,
  // Pipeline helpers
  updateExecStatus,
  captainValidate,
  processExistingLeadsPipeline,  // NEW: exposed for Captain Beaver create_lead tool + POST /api/myclaw/leads
  autoFixMessage,                // NEW: exposed for Captain Beaver draft flow
  brandSafetyCheck,              // NEW: exposed for Captain Beaver draft flow
  applyIcpV2Filter,              // 2026-05-06: exposed for kickoff pool re-validation against legacy MNC junk
  selectChannel,                 // 2026-05-06: exposed for callers that want to test channel routing without a full draft
  // Win/Loss capture
  captureWinLoss,
  // Code-level Enforcer gates
  codeEnforcerGates,
  // Fix 6: Founder feedback loop
  getFounderFeedback,
  _test: {
    salesSignalPreflight,
    signalDraftGuidance,
    buildSalesSignalContext,
    enforcerEvidenceGate,
    captainFallbackDraft,
    getSignalPackage,
    signalPackageMissingFields,
    buildSignalFirstSourcingPlan,
  },
};
