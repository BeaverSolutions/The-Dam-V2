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

// ICP+channel patches per MJ direction 2026-04-29
// ─── ICP v2: SEA-only country, persona, vertical hard gates ─────────────────
const ICP_ALLOWED_COUNTRIES = new Set([
  'malaysia','singapore','indonesia','philippines','thailand','vietnam',
  'my','sg','id','ph','th','vn',
]);

// Senior decision-maker titles. If any matches, lead passes title gate.
// Founder/Co-founder/CEO/MD/COO/CMO/CFO/CTO/President/Owner/Principal/Managing Partner
// stand alone. Director/Head/VP/GM/Chief must combine with a sales/growth/marketing function
// (handled in applyIcpV2Filter — these regexes are component-level).
const ICP_SENIOR_STANDALONE = /\b(founder|co-?founder|ceo|chief executive|cmo|coo|cfo|cto|managing director|managing partner|president|owner|principal|proprietor|\bmd\b|chairman|chairwoman)\b/i;
const ICP_SENIOR_LEADER = /\b(director|head\s+of|vp|vice\s+president|general\s+manager|\bgm\b|chief)\b/i;
const ICP_SENIOR_FUNCTION = /\b(sales|business\s+development|\bbd\b|growth|marketing|revenue|commercial|operations|brand|partnerships|comms|communications|client\s+services)\b/i;

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
const ICP_LARGE_GLOBAL_AGENCIES = /\b(wpp|publicis|omnicom|interpublic|\bipg\b|ipg\s+mediabrands|mediabrands|\bbbdo\b|ogilvy|mccann|\bvml\b|dentsu|dentsu\s+creative|carat|iprospect|isobar|havas|grey\s+group|leo\s+burnett|saatchi|\bddb\b|tbwa|\bjwt\b|wunderman|edelman|\bweber\b|burson|fleishman|hill\+knowlton|groupm|mindshare|wavemaker|mediacom|essence|\bmsl\b|spark\s+foundry|zenith|starcom|digitas|\bmrm\b|\binitiative\b|\bub\b|ipg\s+health|huge|r\/ga|akqa|\bsid\s+lee\b)\b/i;
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
  if (!ICP_ALLOWED_COUNTRIES.has(rawCountry)) {
    return { pass: false, status: 'rejected_country', reason: `country "${rawCountry}" is outside SEA-6` };
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
    || lead.email_source === 'hunter'
    || lead.email_source === 'apollo';
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
    && (lead.email_verified === true || lead.email_source === 'hunter' || lead.email_source === 'apollo');
  const isLinkedinOnlyLead = lead.lead_tier === 'B' && lead.linkedin_url;

  if (linkedinFirstOverride && lead.linkedin_url && !linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'pending_ranger', reason: 'linkedin_first_override metadata flag set' };
  }
  if (hasVerifiedEmail) {
    return { channel: 'email', status: 'pending_ranger', reason: `Verified email (${lead.email_source || 'known'})` };
  }
  if (isLinkedinOnlyLead && !linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'pending_ranger', reason: 'Tier B linkedin-only lead' };
  }
  return {
    channel: 'email',
    status: 'blocked_no_email',
    reason: 'No verified email and no linkedin_url — holding for enrichment',
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
       ORDER BY created_at DESC LIMIT 10`,
      [clientId]
    );
    if (res.rows.length === 0) return null;

    const examples = [];

    // Edit examples — show what the founder changed
    const edits = res.rows.filter(r => r.feedback_type === 'edit' && r.edited_body);
    for (const edit of edits.slice(0, 5)) {
      const ctx = edit.lead_context || {};
      examples.push(
        `[EDIT EXAMPLE — ${edit.channel}] Lead: ${ctx.name || 'Unknown'} at ${ctx.company || 'Unknown'}` +
        `\nOriginal draft:\n${edit.original_body}` +
        `\nFounder's corrected version:\n${edit.edited_body}`
      );
    }

    // Rejection examples — show what patterns the founder kills
    const rejections = res.rows.filter(r => r.feedback_type === 'rejection' && r.rejection_reason);
    for (const rej of rejections.slice(0, 5)) {
      const ctx = rej.lead_context || {};
      examples.push(
        `[REJECTED — ${rej.channel}] Lead: ${ctx.name || 'Unknown'} at ${ctx.company || 'Unknown'}` +
        `\nRejected draft:\n${rej.original_body}` +
        `\nReason: ${rej.rejection_reason}`
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
    const [icp, weeklyLearnings, rangerPatterns, salesMistakes, researchMistakes] = await Promise.all([
      getMemory(clientId, 'director', 'icp'),
      getMemory(clientId, 'director', 'weekly_learnings'),
      getRangerRejectionPatterns(clientId),
      getMemory(clientId, 'sales_beaver', 'mistakes'),
      getMemory(clientId, 'research_beaver', 'mistakes'),
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
async function researchSearch(clientId, { query, filters = {} }) {
  const batchIndex = filters.batchIndex || 0;

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'research_search',
    target_type: 'search',
    metadata: { query, filters, batchIndex },
  });

  // Load ICP memory upfront — used by both search query builder and Claude fallback
  const icpMemory = await getMemory(clientId, 'director', 'icp');

  let leads = [];

  // Primary: Multi-source research — Brave (people, signal, company) + Hunter domain search
  // Rotates through 300+ query variations so dedup never exhausts the pool
  try {
    console.log(`[research_beaver] Running multi-source research (batch ${batchIndex})`);
    const result = await researchModule.researchLeads(clientId, {
      icpMemory,
      targetCount: filters.limit || 5,
      batchIndex,
      commandOverride: query, // user's actual command — takes priority over ICP for query building
    });

    const leads = result.leads || [];
    console.log(`[research_beaver] Multi-source returned ${leads.length} leads via ${result.queriesUsed?.length || 0} queries`);

    if (leads.length > 0) {
      return {
        success: true,
        data: { leads, query: result.queriesUsed?.join(' | ') || query, filters, source: 'multi' },
      };
    }

    console.warn('[research_beaver] Multi-source returned 0 leads — trying Apollo fallback');
  } catch (err) {
    console.warn('[research_beaver] Multi-source research failed, trying Apollo:', err.message);
  }

  // Fallback: Apollo (when configured — 275M verified contacts)
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

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'research_no_results',
    target_type: 'system',
    metadata: { query: query?.substring?.(0, 200), source: 'multi', note: 'All sources returned 0 results' },
  });
  const braveConfigured = !!process.env.BRAVE_API_KEY;
  const missingKeys = [];
  if (!braveConfigured) missingKeys.push('BRAVE_API_KEY');
  const keyDiagnostic = missingKeys.length > 0
    ? ` Missing API keys: ${missingKeys.join(', ')}.`
    : ' API keys present — try different ICP keywords or a broader location.';
  return { success: true, data: { leads: [], query, filters, source: 'multi', note: `No results from any source.${keyDiagnostic}`, missing_keys: missingKeys } };

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
const SALES_PROMPT_VARIANT = 'sales_v2_2026_05_05_sonnet';

async function salesGenerate(clientId, { lead_id, channel, context = '' }) {
  await logsService.createLog(clientId, {
    agent: 'sales_beaver',
    action: 'message_generated',
    target_type: 'message',
    target_id: lead_id,
    metadata: { lead_id, channel },
  });

  if (callAgent) {
    try {
      const directivesSvc = require('./directives');
      const [persona, fileConfig, rangerPatterns, salesDirectives, founderFeedback] = await Promise.all([
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
${personaContext}${fileContext}${rangerContext}${captainDirectiveContext}${founderFeedbackContext}`,
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
          };
        }

        console.warn(`[agents] Could not extract body from raw response for lead ${lead_id}. Raw: ${raw.substring(0, 200)}`);
      }
    } catch (err) {
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
function autoFixMessage(body, { touchNumber = 0, maxWords = 80 } = {}) {
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
  const bannedLowerList = [
    'cutting-edge', 'paradigm shift', 'seamless', 'leverage', 'synergy',
    'game-changer', 'innovative', 'revolutionary', 'transformative', 'delve',
    'i hope this email finds you well', 'i wanted to reach out', 'unlock',
    'unleash', 'empower', 'elevate', 'streamline', 'actionable insights',
    'thought leader', 'disruptive', 'data-driven', 'circle back', 'touch base',
    'move the needle', 'best-in-class',
  ];
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
    const firstName = leadContext.name.trim().split(/\s+/)[0];
    if (firstName && firstName.length >= 3) {
      // Look for "Hi <OtherName>," pattern and check it matches
      const greetMatch = body.match(/^Hi\s+(\w+)/i);
      if (greetMatch && greetMatch[1].toLowerCase() !== firstName.toLowerCase()) {
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
const BANNED_PHRASES = [
  'cutting-edge', 'paradigm shift', 'seamless', 'leverage', 'synergy',
  'game-changer', 'innovative', 'revolutionary', 'transformative', 'delve',
  'i hope this email finds you well', 'i wanted to reach out', 'unlock',
  'unleash', 'empower', 'elevate', 'streamline', 'actionable insights',
  'thought leader', 'disruptive', 'data-driven', 'circle back', 'touch base',
  'move the needle', 'best-in-class',
];

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
  const fixed = autoFixMessage(message_body, { touchNumber, maxWords });
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
        { message_id }
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
      await logMistake(clientId, 'ranger', 'Claude call failed during QA review', err.message, 'Ranger fell back to auto-fix only — investigate Claude API');
      // ── Phase A Step 5: Enforcer fail-OPEN when auto-fix already ran ──
      // If auto-fix made changes, the message is mechanically clean.
      // Push to approval queue with a note instead of blocking.
      return {
        message_id,
        approved: true,
        decision: 'approve_with_edits',
        score: 60,
        body: fixedBody,
        fixes_applied: fixesApplied,
        notes: `Enforcer unavailable — auto-fix applied (${fixesApplied.join(',') || 'no changes'}), manual review recommended`,
        issues: [],
        suggestions: [],
      };
    }
  }

  // No Claude agent available — return auto-fixed body as approved
  return {
    message_id,
    approved: true,
    decision: 'approve',
    score: 60,
    body: fixedBody,
    fixes_applied: fixesApplied,
    notes: 'Auto-fix only (Claude agent not configured)',
    issues: [],
    suggestions: [],
  };
}

/**
 * =========================
 * RANGER DRAFT (last resort)
 * =========================
 * Called when Sales Beaver fails all 3 Ranger attempts.
 * The Ranger writes the message itself using its own rules — guaranteed compliant.
 */
async function rangerDraft(clientId, { lead_name, lead_company, lead_title, lead_angle, lead_friction, rejected_body }) {
  if (!callAgent) return null;

  try {
    const [persona, fileConfig] = await Promise.all([
      getClientPersona(clientId),
      getClientConfig(clientId),
    ]);
    const personaContext = buildPersonaContext(persona);
    const fileContext = buildClientContext(fileConfig);

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

Write a Day 0 cold email that passes ALL your own gates:
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
- Close with: Regards, on one line, then sender name on the next line${personaContext}${fileConfig ? '\n\nSender name for sign-off: use sender_name from the client persona above.' : ''}${fileContext}

Return JSON only: {"subject":"Subject line (max 6 words, no em dashes)","body":"Full email including Hi [name], greeting and Regards, sign-off"}`,
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

      return {
        subject: finalSubject,
        body: stripEmDashes(finalBody), // safety net even on Ranger's own draft
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

  // Extract requested lead count from command — e.g. "Find 3 leads" → 3
  // Default: pull daily target from DB, fallback to 50 if not set.
  const countMatch = command.match(/\b(\d+)\b/);
  let requestedCount;
  if (countMatch) {
    requestedCount = parseInt(countMatch[1], 10);
  } else {
    // Use daily KPI target as default lead count for bare "kickoff"
    try {
      const today = new Date().toISOString().split('T')[0];
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
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.client_id = $1)`,
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
 * HUNTER.IO EMAIL ENRICHMENT
 * =========================
 */
async function enrichLeadsWithHunter(clientId, leads) {
  if (!leads || leads.length === 0) return leads;

  // Check if Hunter key is configured — skip enrichment silently if not
  const apiKey = await hunterService.getApiKey(clientId);
  if (!apiKey) return leads;

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

      // Try: name + company domain
      const result = await hunterService.findEmail(clientId, {
        firstName,
        lastName,
        company: lead.company,
      });

      if (result?.email) {
        console.log(`[hunter] Found ${result.email} for ${lead.name} at ${lead.company} (confidence: ${result.confidence})`);
        enriched.push({
          ...lead,
          email: result.email,
          email_verified: result.verified,
          email_source: 'hunter',
        });
        continue;
      }

      // Domain fallback DISABLED — grabbing a random email at the domain causes
      // name-email mismatches (e.g. Rob Go → stephen.lai@nextview.com).
      // Captain Beaver rule: no email is better than the wrong person's email.
      enriched.push(lead); // save lead without email — can be enriched manually later
    } catch (err) {
      console.warn(`[hunter] Enrichment failed for ${lead.name}:`, err.message);
      enriched.push(lead); // always save the lead even without email
    }
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'hunter_enrichment_complete',
    metadata: {
      total: leads.length,
      enriched: enriched.filter(l => l.email_source?.startsWith('hunter')).length,
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
async function processExistingLeadsPipeline(clientId, plan_id, leads) {
  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'signal_pipeline_executing',
    metadata: { plan_id, lead_count: leads.length },
  });

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
  if (dedupedLeads.length < leads.length) {
    console.log(`[signal-pipeline] Same-day dedup: skipped ${leads.length - dedupedLeads.length}/${leads.length} already-enrolled leads`);
  }
  leads = dedupedLeads;

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
  let messagesDrafted = 0;

  for (const lead of leads) {
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

      // Search for personalisation signals before drafting
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

      // ── Email-priority rule ─────────────────────────────────────────────
      // If the lead has no email, ALWAYS try Hunter first before falling back
      // to LinkedIn. MJ's rule: email is the primary channel; LinkedIn is only
      // used when no email is available, and for follow-up escalation after FU2.
      // Phase 2 Step 3 (2026-05-08): Hunter enrichment via pipeline.enrichEmail.
      // signal_pipeline does NOT use VP (kickoff path only) — enableVp omitted.
      await pipeline.enrichEmail(clientId, lead, {
        pipeline_path: 'signal-pipeline',
        hunterService,
      });

      // ── Channel selection ── single source of truth in selectChannel()
      const channelChoice_sp = selectChannel(lead);
      const channel = channelChoice_sp.channel;
      let kickoffMessageStatus = channelChoice_sp.status;
      if (channelChoice_sp.status === 'blocked_no_email') {
        console.log(`[signal-pipeline] ${lead.name} — no verified email, marking blocked_no_email`);
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id, kickoff_id: plan_id,
          stage: 'channel_blocked', status: 'blocked_no_email',
          agent: 'director', pipeline_path: 'signal_pipeline',
          reason: channelChoice_sp.reason,
          metadata: { lead_name: lead.name },
        }).catch(() => {});
      }

      if (channel === 'linkedin') {
        const prevLinkedinRes = await pool.query(
          `SELECT id FROM messages WHERE client_id = $1 AND lead_id = $2 AND channel = 'linkedin' AND status NOT IN ('deleted') LIMIT 1`,
          [clientId, lead.id]
        );
        if (prevLinkedinRes.rows.length > 0) {
          console.log(`[signal-pipeline] ${lead.name} — LinkedIn already tried, Hunter found nothing — skipping`);
          pipelineTrace.traceStage(clientId, {
            lead_id: lead.id, kickoff_id: plan_id,
            stage: 'channel_exhausted', status: 'linkedin_already_tried',
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

      // Sales Beaver + Enforcer fallback via pipeline.draftWithFallback.
      const draft = await pipeline.draftWithFallback(clientId, {
        lead_id: lead.id,
        channel,
        context: contextParts.join('\n'),
        salesGenerate,
        rangerDraft,
        enableEnforcerFallback: true,
        lead,
        leadAngle: meta.angle,
        leadFriction: meta.friction,
        pipeline_path: 'signal-pipeline',
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

      // Phase 2 Step 2 (2026-05-08): persistDraft is the single source of truth
      // for INSERT INTO messages. Composes metadata (source, signal, prompt_variant,
      // blocked_reason) and emits pipeline_traces 'drafted' internally — the
      // explicit traceStage call previously here is removed.
      const msg = await pipeline.persistDraft(clientId, {
        lead_id: lead.id,
        channel,
        subject: draftSubject,
        body: draftBody,
        status: kickoffMessageStatus,
        draft_source: draftSource,
        prompt_variant: salesResult?.prompt_variant,
        signal: meta.signal,
        kickoff_id: plan_id,
        pipeline_path: 'signal_pipeline',
      });

      // Phase D piece 2 — outcome attribution: drafted event (signal-pipeline path)
      recordOutcome(clientId, {
        outcome: 'drafted',
        leadId: lead.id,
        messageId: msg.id,
        channel,
        ...attributionFromLead(lead),
        eventData: { source_path: 'signal_pipeline', status: kickoffMessageStatus, draft_source: draftSource },
      });

      // (Phase 2 Step 2: drafted trace now emitted internally by pipeline.persistDraft above)

      // If blocked, skip Ranger and downstream processing — message is on hold for enrichment.
      if (kickoffMessageStatus === 'blocked_no_email') {
        messagesDrafted++;
        continue;
      }
      messagesDrafted++;

      // Run auto-fix + Enforcer
      const fixed = autoFixMessage(msg.body, { touchNumber: 0, maxWords: 80 });
      if (fixed.fixes.length > 0) {
        await pool.query(
          `UPDATE messages SET body = $1 WHERE id = $2`,
          [fixed.body, msg.id]
        );
      }

      const safety = brandSafetyCheck(fixed.body, {
        name: lead.name, company: lead.company, title: lead.title,
        signal: meta.signal, why_now: meta.why_now,
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
      let rangerFailedOpen = false;
      try {
        rangerResult = await rangerReview(clientId, {
          message_id: msg.id,
          message_body: fixed.body,
          lead_context: {
            name: lead.name, company: lead.company, title: lead.title,
            signal: meta.signal, angle: meta.angle, why_now: meta.why_now,
          },
        });
      } catch (err) {
        // Fail-open: auto-fix was applied, let it through
        rangerResult = { approved: true, score: 55, notes: 'Enforcer unavailable — auto-fix applied', body: fixed.body };
        rangerFailedOpen = true;
      }

      // Phase 1 (2026-05-08): pipeline_traces reviewed (Enforcer ran or failed-open)
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id,
        message_id: msg.id,
        kickoff_id: plan_id,
        stage: 'reviewed',
        status: rangerFailedOpen ? 'fail_open' : (rangerResult?.approved ? 'approved' : 'rejected'),
        agent: 'enforcer_beaver',
        score: rangerResult?.score ?? null,
        reason: rangerResult?.notes || null,
        pipeline_path: 'signal_pipeline',
        metadata: { channel, fail_open: rangerFailedOpen },
      }).catch(() => {});

      const finalBody = rangerResult?.body || fixed.body;

      if (rangerResult?.approved) {
        // ── Auto-approve vs borderline surface (mirrors runRangerPipeline logic) ──
        const rangerScore = rangerResult.score || 70;
        let autoApproved = false;
        let isBorderline = false;
        let nextMessageStatus = 'pending_approval';
        let approvalStatus = 'pending';
        let resolvedAt = null;

        // Fix 5c (2026-05-09): Score-based borderline detection
        // Score 60-79 = borderline regardless of whether Enforcer returned two_thoughts.
        // If two_thoughts are present, use them. If not, extract from feedback text.
        const twoThoughts = rangerResult?.two_thoughts;
        const hasTwoThoughts = twoThoughts && Array.isArray(twoThoughts) && twoThoughts.length > 0;
        if (rangerScore >= 60 && rangerScore < 80) {
          isBorderline = true;
          nextMessageStatus = 'pending_approval';
          console.log(`[pipeline] BORDERLINE ${msg.id}: score ${rangerScore}, surfacing ${hasTwoThoughts ? `with ${twoThoughts.length} suggestions` : 'with feedback (no structured thoughts)'}`);
        } else {
          try {
            const { rows: [clientRow] } = await pool.query(
              `SELECT auto_approve_threshold FROM clients WHERE id = $1 LIMIT 1`,
              [clientId]
            );
            const threshold = clientRow?.auto_approve_threshold;
            if (threshold !== null && threshold !== undefined && rangerScore >= threshold) {
              autoApproved = true;
              nextMessageStatus = (msg.channel === 'email') ? 'pending_send' : 'approved';
              approvalStatus = 'approved';
              resolvedAt = new Date();
              console.log(`[pipeline] AUTO-APPROVED ${msg.id}: score ${rangerScore} >= threshold ${threshold} (channel=${msg.channel}, next=${nextMessageStatus})`);
            }
          } catch (err) {
            console.warn('[pipeline] Failed to read auto_approve_threshold, defaulting to manual:', err.message);
          }
        }

        // Build ranger_notes with two thoughts for borderline
        let rangerNotes;
        if (isBorderline && hasTwoThoughts) {
          const thoughtLines = twoThoughts.map((t, i) =>
            `${i + 1}. ${t.thought}: "${t.current_phrase}" → "${t.suggested_phrase}"`
          ).join('\n');
          rangerNotes = `Borderline (${rangerScore}/100) — two suggestions:\n${thoughtLines}`;
        } else if (isBorderline) {
          rangerNotes = `Borderline (${rangerScore}/100) — ${rangerResult.notes || rangerResult.feedback || 'Review recommended'}`;
        } else if (autoApproved) {
          rangerNotes = `Auto-approved (score ${rangerScore})`;
        } else {
          rangerNotes = rangerResult.notes || 'Signal-sourced, approved';
        }

        if (isBorderline) {
          // Store borderline flag + suggestions (structured or feedback-based)
          const suggestionsPayload = hasTwoThoughts
            ? twoThoughts
            : [{ thought: rangerResult.notes || rangerResult.feedback || 'Review recommended', current_phrase: '', suggested_phrase: '' }];
          await pool.query(
            `UPDATE messages SET body = $1, status = $2, ranger_score = $3, ranger_notes = $4,
             metadata = jsonb_set(jsonb_set(COALESCE(metadata, '{}'), '{borderline}', 'true'), '{enforcer_suggestions}', $5::jsonb),
             updated_at = NOW() WHERE id = $6`,
            [finalBody, nextMessageStatus, rangerScore, rangerNotes, JSON.stringify(suggestionsPayload), msg.id]
          );
        } else {
          await pool.query(
            `UPDATE messages SET body = $1, status = $2, ranger_score = $3, ranger_notes = $4, updated_at = NOW() WHERE id = $5`,
            [finalBody, nextMessageStatus, rangerScore, rangerNotes, msg.id]
          );
        }

        await pool.query(
          `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [clientId, msg.id,
           isBorderline ? 'enforcer_borderline' : (autoApproved ? 'auto_approval' : 'signal_hunt'),
           approvalStatus,
           resolvedAt]
        );

        if (autoApproved) {
          try {
            const { enqueueMessage } = require('./sendQueueWorker');
            const enqResult = await enqueueMessage(clientId, msg.id);
            if (enqResult?.enqueued) {
              console.log(`[pipeline] Auto-approved ${msg.id} → enqueued for send`);
            }
          } catch (err) {
            console.warn(`[pipeline] enqueueMessage failed for ${msg.id}:`, err.message);
          }
        }

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
        // Phase 1 (2026-05-08): pipeline_traces approved (signal_pipeline)
        pipelineTrace.traceStage(clientId, {
          lead_id: lead.id,
          message_id: msg.id,
          kickoff_id: plan_id,
          stage: isBorderline ? 'reviewed' : 'approved',
          status: isBorderline ? 'borderline_surfaced' : (autoApproved ? 'auto_threshold' : 'pipeline_approved'),
          agent: 'enforcer_beaver',
          score: rangerScore,
          pipeline_path: 'signal_pipeline',
          metadata: { channel: msg.channel, next_status: nextMessageStatus, borderline: isBorderline },
        }).catch(() => {});

        approvedCount++;
      } else {
        // Enforcer rejected — try once more with Enforcer writing it himself
        console.warn(`[signal-pipeline] Enforcer rejected ${lead.name}: ${rangerResult?.notes || 'unknown'} — Enforcer drafting fallback`);
        await pool.query(
          `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1 WHERE id = $2`,
          [rangerResult?.notes || 'Rejected by Enforcer', msg.id]
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

        try {
          const enforcerDraft = await rangerDraft(clientId, {
            lead_name: lead.name, lead_company: lead.company, lead_title: lead.title,
            lead_angle: meta.angle, lead_friction: meta.friction,
            rejected_body: finalBody, rejection_notes: rangerResult?.notes,
          });
          // rangerDraft returns {subject, body} — pass the STRING body to SQL, never the whole object
          if (enforcerDraft?.body && typeof enforcerDraft.body === 'string') {
            const enfSubject = enforcerDraft.subject || draftSubject || lead.company;
            // Phase 2 Step 2 (2026-05-08): NEW message via pipeline.persistDraft
            // (don't overwrite the rejected one). Pre-scored at 70 by Enforcer.
            const enfMsg = await pipeline.persistDraft(clientId, {
              lead_id: lead.id,
              channel,
              subject: enfSubject,
              body: enforcerDraft.body,
              status: 'pending_approval',
              ranger_score: 70,
              ranger_notes: 'Enforcer-drafted fallback — Sales Beaver hard-rejected. Review before sending.',
              metadata: { original_rejection: rangerResult?.notes },
              draft_source: 'enforcer_fallback',
              signal: meta.signal,
              kickoff_id: plan_id,
              pipeline_path: 'signal_pipeline',
            });

            // Phase D piece 2 — outcome attribution: drafted event (Enforcer fallback)
            recordOutcome(clientId, {
              outcome: 'drafted',
              leadId: lead.id,
              messageId: enfMsg.id,
              channel,
              ...attributionFromLead(lead),
              eventData: { source_path: 'enforcer_fallback', original_rejection: rangerResult?.notes },
            });

            await pool.query(
              `INSERT INTO approvals (client_id, message_id, requested_by, status) VALUES ($1, $2, 'enforcer_fallback', 'pending')`,
              [clientId, enfMsg.id]
            );
            await logsService.createLog(clientId, {
              agent: 'enforcer_beaver', action: 'enforcer_drafted_fallback',
              target_type: 'message', target_id: enfMsg.id,
              metadata: { lead_name: lead.name, original_rejection: rangerResult?.notes },
            }).catch(() => {});
            // (Phase 2 Step 2: drafted trace now emitted internally by pipeline.persistDraft above —
            //  agent='enforcer_beaver' inferred from draft_source='enforcer_fallback')
            approvedCount++;
            console.log(`[signal-pipeline] Enforcer fallback draft for ${lead.name} → pending_approval`);
          } else {
            // Phase 1 (2026-05-08): pipeline_traces rejected (Enforcer hard-reject, no fallback body)
            pipelineTrace.traceStage(clientId, {
              lead_id: lead.id,
              message_id: msg.id,
              kickoff_id: plan_id,
              stage: 'rejected',
              status: 'enforcer_no_fallback',
              agent: 'enforcer_beaver',
              score: rangerResult?.score ?? null,
              reason: rangerResult?.notes || null,
              pipeline_path: 'signal_pipeline',
              metadata: { channel },
            }).catch(() => {});
            rejectedCount++;
          }
        } catch (fallbackErr) {
          console.warn(`[signal-pipeline] Enforcer fallback failed for ${lead.name}:`, fallbackErr.message);
          // Phase 1 (2026-05-08): pipeline_traces rejected (Enforcer fallback exception)
          pipelineTrace.traceStage(clientId, {
            lead_id: lead.id,
            message_id: msg.id,
            kickoff_id: plan_id,
            stage: 'rejected',
            status: 'enforcer_fallback_error',
            agent: 'enforcer_beaver',
            reason: fallbackErr.message,
            pipeline_path: 'signal_pipeline',
            metadata: { channel },
          }).catch(() => {});
          rejectedCount++;
        }
      }
    } catch (err) {
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
    metadata: { plan_id, leads: leads.length, drafted: messagesDrafted, approved: approvedCount, rejected: rejectedCount },
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
      rejected: rejectedCount,
      icp_audit_rejected: icpAuditRejected,
      silent_drop_count: leads.length - messagesDrafted - rejectedCount,
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
    summary: { leads_found: leads.length, messages_drafted: messagesDrafted, approved: approvedCount, rejected: rejectedCount },
    source: 'signal_hunt',
  };
}

/**
 * =========================
 * DIRECTOR — EXECUTE (full pipeline)
 * =========================
 */
async function directorExecute(clientId, { plan_id, command, batchIndex = 0, limit, use_existing_leads = null }) {
  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'plan_executing',
    metadata: { plan_id, batchIndex, signal_sourced: !!use_existing_leads },
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
    const today = new Date().toISOString().slice(0, 10);
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
        return await processExistingLeadsPipeline(clientId, plan_id, signalLeads);
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
  // Hand DB leads to Sales Beaver WHILE simultaneously doing external research
  // for the remaining gap. Both run in parallel.
  const cmdCountMatch = command && command.match(/\b(\d+)\b/);
  const targetLimit = limit || (cmdCountMatch ? parseInt(cmdCountMatch[1], 10) : 50);

  let dbLeadsPromise = null;
  let dbLeadsCount = 0;

  try {
    const { rows: uncontactedLeads } = await pool.query(
      `SELECT l.* FROM leads l
       WHERE l.client_id = $1
         AND l.deleted_at IS NULL
         AND l.status = 'new'
         AND (l.email IS NOT NULL OR l.linkedin_url IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.lead_id = l.id AND m.client_id = $1
         )
       ORDER BY
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

      // Start Sales pipeline for DB leads in background (non-blocking)
      dbLeadsPromise = processExistingLeadsPipeline(clientId, plan_id, uncontactedLeads)
        .catch(err => {
          console.error('[director] DB-first pipeline failed:', err.message);
          return null;
        });

      // If DB leads fully satisfy target, await result and check actual success count
      if (dbLeadsCount >= targetLimit) {
        const dbResult = await dbLeadsPromise;
        // Count actual successes — don't skip research if most leads failed
        const actualDrafted = dbResult?.summary?.messages_drafted || 0;
        if (actualDrafted >= targetLimit) {
          console.log(`[director] DB-first: ${actualDrafted} drafts produced from ${dbLeadsCount} leads — target met, skipping external research`);
          return dbResult;
        }
        // Some failed — continue to external research to fill the gap
        const gap = targetLimit - actualDrafted;
        console.log(`[director] DB-first: only ${actualDrafted} drafts from ${dbLeadsCount} leads — ${gap} more needed from external research`);
        // Don't return — fall through to external research below
      } else {
        // Otherwise: DB pipeline runs in background while we continue to external research below
        console.log(`[director] DB-first: ${dbLeadsCount} leads processing in parallel, ${targetLimit - dbLeadsCount} more needed from research`);
      }
    } else {
      console.log('[director] DB-first: no uncontacted leads in pipeline — proceeding to external research');
    }
  } catch (err) {
    console.warn('[director] DB-first check failed, proceeding to external research:', err.message);
  }

  // ── Step 1: Research Beaver (with retry loop) ───────────

  // Retry loop: keep searching until we have enough leads that pass ALL Director gates
  // Max 3 rounds to cap API spend (each round = 1 search batch + verification)
  const MAX_RESEARCH_ROUNDS = 3;
  let rawLeads = [];
  let currentBatchIndex = batchIndex;
  let allSearchQueries = [];

  for (let round = 0; round < MAX_RESEARCH_ROUNDS; round++) {
    const researchResult = command
      ? await researchSearch(clientId, { query: command, filters: { batchIndex: currentBatchIndex, limit: targetLimit } })
      : { data: { leads: [] } };

    const roundLeads = researchResult?.data?.leads || [];
    if (researchResult?.data?.query) allSearchQueries.push(researchResult.data.query);
    diagnostics.research_source = researchResult?.data?.source || 'unknown';

    // Deduplicate against leads already collected in previous rounds
    const existingUrls = new Set(rawLeads.map(l => l.linkedin_url).filter(Boolean));
    const newLeads = roundLeads.filter(l => !l.linkedin_url || !existingUrls.has(l.linkedin_url));
    rawLeads.push(...newLeads);

    console.log(`[research] Round ${round + 1}: got ${roundLeads.length} (${newLeads.length} new), total raw: ${rawLeads.length}`);

    if (rawLeads.length >= targetLimit * 2) {
      console.log(`[research] Have ${rawLeads.length} raw leads (>= ${targetLimit * 2} buffer) — stopping search`);
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
  diagnostics.research_rounds = Math.min(currentBatchIndex - batchIndex + 1, MAX_RESEARCH_ROUNDS);
  diagnostics.search_query = allSearchQueries.join(' | ') || null;

  // ── Step 1b: Captain Beaver verification gate ────────────
  // If a lead came from Claude fallback (not Apollo) and has no linkedin_url,
  // it cannot be verified and must be skipped to prevent hallucinated outreach.
  const researchSource = diagnostics.research_source || 'claude';
  const isVerifiedSource = researchSource === 'apollo' || researchSource === 'brave' || researchSource === 'multi';
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

  // ── Gate 2: Must have a LinkedIn URL ──
  const verifiedLeads = titledLeads.filter(lead => {
    if (!lead.linkedin_url) {
      console.warn(`[captain] REJECT: ${lead.name} — no LinkedIn URL`);
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
    if (lead.email_source === 'apollo') return lead; // Apollo matches are trusted

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
      allowLinkedinOnly: !!lead.linkedin_only_override,
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
          lead.score || 0,
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
    const dupReason = dupCount > 0
      ? `${dupCount} leads already in pipeline (try different keywords). ${diagnostics.after_dedup - dupCount} filtered by ICP/verification.`
      : 'All leads filtered by ICP title, LinkedIn verification, or dedup';

    await logsService.createLog(clientId, {
      agent: 'director',
      action: 'plan_zero_leads',
      metadata: { plan_id, raw_count: rawLeads.length, dup_count: dupCount, reason: dupReason },
    });
    diagnostics.reason = dupReason;
    return {
      plan_id, status: 'completed',
      leads_found: 0, messages_drafted: 0,
      messages_failed: 0,
      summary: `0 new leads (raw: ${rawLeads.length}, already in pipeline: ${dupCount}). ${dupCount > rawLeads.length * 0.5 ? 'Most results are duplicates — try different keywords or a new industry.' : 'Check ICP config and data source.'}`,
      diagnostics,
    };
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
    if (!lead.id || !lead.name || lead.name === 'Unknown Contact') {
      console.warn('[pipeline] Skipping lead with no identity:', lead.id, lead.name);
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
    const CHANNEL_HINTS = {
      email: 'Write a cold email following the MANDATORY DAY 0 TEMPLATE exactly. Must have: subject line "{company_name} x {lead_company}", "Hi {first_name}," greeting, congratulation/hook paragraph, pain bridge paragraph, one question, "Regards," sign-off. Under 80 words body.',
      linkedin: 'Write a SHORT LinkedIn DM (NOT an email). 2-3 sentences max, under 50 words total. No subject line. No greeting like "Hi Name,". No sign-off (no "Regards,", no name at end). Just a casual peer-to-peer message ending with one question.',
      instagram: 'Write a casual Instagram DM. 1-2 sentences, under 30 words. No greeting, no sign-off. Reference something about their company. End with a casual question. Most informal channel.',
    };

    // ── Email-priority + VP enrichment via pipeline.enrichEmail ──────────
    // Phase 2 Step 3 (2026-05-08): Hunter + VP enrichment consolidated into
    // pipeline.enrichEmail. Behaviour identical: Hunter always tried first,
    // then VP fallback gated by quality_score >= vp_threshold_score AND
    // daily credit budget. lead.email/email_verified/email_source mutated
    // in place + DB updated. linkedinAlreadyTried tracked separately below.
    let linkedinAlreadyTried = false;
    {
      const tenantConfigService = require('./tenantConfig');
      const vpService = require('./vibeProspecting');
      await pipeline.enrichEmail(clientId, lead, {
        pipeline_path: 'pipeline',
        hunterService,
        enableVp: true,
        vpService,
        tenantConfigService,
      });
    }

    // If neither Hunter NOR VP found an email AND LinkedIn was previously attempted,
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
          stage: 'channel_exhausted', status: 'linkedin_already_tried',
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
        enableEnforcerFallback: false,
        pipeline_path: 'kickoff_pipeline',
      });
      const salesResult = draft
        ? { body: draft.body, subject: draft.subject, prompt_variant: draft.prompt_variant }
        : { body: null, subject: null, prompt_variant: null };

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
          status: kickoffMessageStatus,
          draft_source: 'sales_beaver',
          prompt_variant: salesResult.prompt_variant,
          kickoff_id: plan_id,
          pipeline_path: 'kickoff_pipeline',
        });
        const msgWithMeta = { ...message, lead_name: lead.name, lead_company: lead.company };
        savedMessages.push(msgWithMeta);

        await logsService.createLog(clientId, {
          agent: 'sales_beaver',
          action: 'message_created',
          target_type: 'message',
          target_id: message.id,
          metadata: { lead_id: lead.id, lead_name: lead.name, channel: selectedChannel, status: kickoffMessageStatus, reason: channelReason },
        });
        // (Phase 2 Step 2: drafted trace now emitted internally by pipeline.persistDraft above)

        // Phase D piece 2 — outcome attribution: drafted event
        recordOutcome(clientId, {
          outcome: 'drafted',
          leadId: lead.id,
          messageId: message.id,
          channel: selectedChannel,
          ...attributionFromLead(lead),
          eventData: { source_path: 'kickoff_pipeline', status: kickoffMessageStatus, reason: channelReason },
        });

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
        await runRangerPipeline(lead, msgWithMeta);
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

    // ── AI Enforcer review (fail-OPEN — auto-fix already cleaned mechanics) ──
    let rangerResult;
    try {
      rangerResult = await rangerReview(clientId, {
        message_id: msg.id,
        message_body: currentBody,
        lead_context: {
          name: lead.name,
          company: lead.company,
          title: lead.title,
          signal: lead.metadata?.signal,
          angle: lead.metadata?.angle,
          friction: lead.metadata?.friction,
          why_now: lead.metadata?.why_now,
          touch_number: touchNumber,
        },
      });
      // Enforcer may have further polished the body — use its returned version
      if (rangerResult?.body) currentBody = rangerResult.body;
    } catch (err) {
      console.warn('[pipeline] AI Enforcer unavailable, approving auto-fixed version (fail-open):', err.message);
      // Auto-fix already cleaned mechanics. Ship it to approval queue with low trust score.
      rangerResult = {
        approved: true,
        decision: 'approve_with_edits',
        score: 55,
        notes: `Enforcer unavailable — auto-fix applied (${preFixResult.fixes.join(',') || 'none'})`,
        breakdown: null,
      };
      await logMistake(clientId, 'enforcer_beaver', 'Claude call failed during Enforcer review', err.message, 'Enforcer fell back to auto-fix + manual review');
    }

    if (!rangerResult?.approved) {
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
                signal: lead.metadata?.signal,
                angle: lead.metadata?.angle,
                friction: lead.metadata?.friction,
                why_now: lead.metadata?.why_now,
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

            // If still rejected after redraft → Enforcer drafts it himself
            if (!rangerResult?.approved) {
              const enforcerDraft = await rangerDraft(clientId, {
                lead_name: lead.name, lead_company: lead.company, lead_title: lead.title,
                lead_angle: lead.metadata?.angle, lead_friction: lead.metadata?.friction,
                rejected_body: currentBody,
              });
              // rangerDraft returns {subject, body} — extract the STRING body
              if (enforcerDraft?.body && typeof enforcerDraft.body === 'string') {
                currentBody = enforcerDraft.body;
                currentSubject = enforcerDraft.subject || currentSubject || `${lead.company}`;
                await pool.query(
                  `UPDATE messages SET body = $1, subject = $2, status = 'pending_approval',
                   ranger_score = 70, ranger_notes = $3, updated_at = NOW()
                   WHERE id = $4 AND client_id = $5`,
                  [currentBody, currentSubject,
                   'Enforcer-drafted fallback — Sales Beaver failed after 2 attempts. Review before sending.',
                   msg.id, clientId]
                );
                await pool.query(
                  `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'enforcer_fallback')`,
                  [clientId, msg.id]
                );
                await logsService.createLog(clientId, {
                  agent: 'enforcer_beaver', action: 'enforcer_fallback_draft',
                  target_type: 'message', target_id: msg.id,
                  metadata: { channel: msg.channel, lead_name: lead.name, attempts: attemptCount + 1 },
                }).catch(() => {});
                approvedCount++;
                execStatus.beavers.enforcer.status = 'done';
                rangerResult = { approved: true, score: 70 }; // continue to approval block
              } else {
                // rangerDraft itself failed — last resort, mark rejected
                await pool.query(
                  `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2`,
                  [`Sales Beaver failed ${attemptCount + 1} attempts; Enforcer draft also failed.`, msg.id]
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

      // Final rejection — Sales exhausted all retries, Enforcer drafts his own version
      if (!rangerResult?.approved) {
        const enforcerDraft = await rangerDraft(clientId, {
          lead_name: lead.name, lead_company: lead.company, lead_title: lead.title,
          lead_angle: lead.metadata?.angle, lead_friction: lead.metadata?.friction,
          rejected_body: currentBody,
        });
        // rangerDraft returns {subject, body} — extract the STRING body
        if (enforcerDraft?.body && typeof enforcerDraft.body === 'string') {
          currentBody = enforcerDraft.body;
          currentSubject = enforcerDraft.subject || currentSubject || `${lead.company}`;
          await pool.query(
            `UPDATE messages SET body = $1, subject = $2, status = 'pending_approval',
             ranger_score = 70, ranger_notes = $3, updated_at = NOW()
             WHERE id = $4 AND client_id = $5`,
            [currentBody, currentSubject,
             'Enforcer-drafted fallback — Sales Beaver failed all attempts. Review before sending.',
             msg.id, clientId]
          );
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'enforcer_fallback')`,
            [clientId, msg.id]
          );
          await logsService.createLog(clientId, {
            agent: 'enforcer_beaver', action: 'enforcer_fallback_draft',
            target_type: 'message', target_id: msg.id,
            metadata: { channel: msg.channel, lead_name: lead.name, method: 'enforcer_fallback' },
          }).catch(() => {});
          approvedCount++;
          execStatus.beavers.enforcer.status = 'done';
        } else {
          // Last resort — both Sales and Enforcer failed
          await pool.query(
            `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2`,
            ['Sales and Enforcer both failed to draft. Manual message required.', msg.id]
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

    // ── AI Enforcer approved — decide: auto-approve, borderline surface, or human queue? ──
    const rangerScore = rangerResult?.score || 80;
    let autoApproved = false;
    let isBorderline = false;
    let approvalStatus = 'pending_approval';
    let nextMessageStatus = 'pending_approval';

    // ── Fix 5c (2026-05-09): Score-based borderline detection ──
    // Score 60-79 = borderline regardless of whether Enforcer returned two_thoughts.
    // Never auto-approve borderline drafts — the founder's eye is the value.
    const twoThoughts = rangerResult?.two_thoughts;
    const hasTwoThoughts = twoThoughts && Array.isArray(twoThoughts) && twoThoughts.length > 0;
    if (rangerScore >= 60 && rangerScore < 80) {
      isBorderline = true;
      nextMessageStatus = 'pending_approval';
      console.log(`[enforcer] BORDERLINE ${msg.id}: score ${rangerScore}, surfacing ${hasTwoThoughts ? `with ${twoThoughts.length} suggestions` : 'with feedback (no structured thoughts)'}`);
    } else {
      // Standard auto-approve threshold check for non-borderline
      try {
        const { rows: [clientRow] } = await pool.query(
          `SELECT auto_approve_threshold FROM clients WHERE id = $1 LIMIT 1`,
          [clientId]
        );
        const threshold = clientRow?.auto_approve_threshold;

        if (threshold !== null && threshold !== undefined && rangerScore >= threshold) {
          autoApproved = true;
          approvalStatus = 'approved';
          nextMessageStatus = (msg.channel === 'email') ? 'pending_send' : 'approved';
          console.log(`[enforcer] AUTO-APPROVED ${msg.id}: score ${rangerScore} >= threshold ${threshold} (channel=${msg.channel}, next=${nextMessageStatus})`);
        }
      } catch (err) {
        console.warn('[enforcer] Failed to read auto_approve_threshold, defaulting to manual:', err.message);
      }
    }

    // Build ranger_notes with two thoughts visible for borderline drafts
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

    // Build metadata with borderline flag + suggestions
    const rangerBreakdown = rangerResult?.breakdown || null;
    // Store borderline flag + suggestions (structured or feedback-based)
    const suggestionsPayload = isBorderline
      ? (hasTwoThoughts ? twoThoughts : [{ thought: rangerResult?.notes || rangerResult?.feedback || 'Review recommended', current_phrase: '', suggested_phrase: '' }])
      : null;

    if (isBorderline) {
      await pool.query(
        `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
         ranger_breakdown = $5, status = $6, metadata = jsonb_set(jsonb_set(COALESCE(metadata, '{}'), '{borderline}', 'true'), '{enforcer_suggestions}', $7::jsonb), updated_at = NOW()
         WHERE id = $8 AND client_id = $9`,
        [currentBody, currentSubject, rangerScore, rangerNotes,
         JSON.stringify(rangerBreakdown), nextMessageStatus,
         JSON.stringify(suggestionsPayload), msg.id, clientId]
      );
    } else {
      await pool.query(
        `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
         ranger_breakdown = $5, status = $6, updated_at = NOW()
         WHERE id = $7 AND client_id = $8`,
        [currentBody, currentSubject, rangerScore, rangerNotes,
         JSON.stringify(rangerBreakdown), nextMessageStatus, msg.id, clientId]
      );
    }

    await pool.query(
      `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [clientId, msg.id,
       isBorderline ? 'enforcer_borderline' : (autoApproved ? 'auto_approval' : 'system'),
       autoApproved ? 'approved' : 'pending',
       autoApproved ? new Date() : null]
    );

    // If auto-approved AND email channel, push to send queue. Channel guard
    // inside enqueueMessage skips LinkedIn / Instagram automatically.
    if (autoApproved) {
      try {
        const { enqueueMessage } = require('./sendQueueWorker');
        const enqResult = await enqueueMessage(clientId, msg.id);
        if (enqResult?.enqueued) {
          console.log(`[enforcer] Auto-approved ${msg.id} → enqueued for send`);
        }
      } catch (err) {
        console.warn(`[enforcer] enqueueMessage failed for ${msg.id}:`, err.message);
      }
    }

    // Pipeline trace for borderline surface (Fix 5 visibility)
    if (isBorderline) {
      pipelineTrace.traceStage(clientId, {
        lead_id: lead.id,
        stage: 'reviewed',
        status: 'borderline_surfaced',
        agent: 'enforcer_beaver',
        score: rangerScore,
        pipeline_path: msg.metadata?.pipeline_path || 'unknown',
        metadata: { channel: msg.channel, thoughts_count: twoThoughts.length },
      }).catch(() => {});
    }

    await logsService.createLog(clientId, {
      agent: 'enforcer_beaver',
      action: isBorderline ? 'message_borderline_surfaced' : (autoApproved ? 'message_auto_approved' : 'message_approved'),
      target_type: 'message',
      target_id: msg.id,
      metadata: {
        channel: msg.channel, score: rangerScore,
        method: isBorderline ? 'borderline_two_thoughts' : (autoApproved ? 'auto_threshold' : 'ai_enforcer'),
        borderline: isBorderline,
        thoughts: isBorderline ? twoThoughts : undefined,
      },
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

  // Final status update: pipeline complete
  await updateExecStatus(clientId, plan_id, {
    status: 'completed',
    phase: 'captain',
    beavers: {
      research: { status: 'done', task: `${savedLeads.length} leads found`, found: rawLeads.length, passed: savedLeads.length },
      sales:    { status: 'done', task: `${diagnostics.messages_drafted} messages drafted`, drafted: diagnostics.messages_drafted, approved: approvedCount },
      enforcer: { status: 'done', task: `${approvedCount} approved, ${rejectedCount} rejected`, reviewed: diagnostics.messages_drafted, rejected: rejectedCount },
      captain:  { status: 'done', task: `${approvedCount} queued for your approval`, approved: approvedCount },
    },
    progress: { total: leadsToProcess.length, complete: leadsToProcess.length },
    started_at: new Date().toISOString(),
  });

  // Await DB-first pipeline if it was running in parallel
  if (dbLeadsPromise) {
    console.log(`[director] Awaiting DB-first pipeline completion (${dbLeadsCount} leads)...`);
    await dbLeadsPromise;
  }

  // Combine DB-first + research counts for final summary
  const totalLeadsFound = savedLeads.length + dbLeadsCount;

  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'plan_completed',
    metadata: { plan_id, leads_found: totalLeadsFound, db_leads: dbLeadsCount, research_leads: savedLeads.length, messages_drafted: savedMessages.length, approved: approvedCount },
  });

  const { rows: [fuRow] } = await pool.query(
    `SELECT COUNT(*) FROM messages WHERE client_id = $1 AND status IN ('pending_approval', 'pending_send') AND metadata->>'is_followup' = 'true'`,
    [clientId]
  );
  const followupsPending = parseInt(fuRow.count, 10);

  const summary = {
    leads_found: totalLeadsFound,
    messages_drafted: savedMessages.length,
    approved: approvedCount,
    new_outreach_pending: approvedCount,
    followups_pending: followupsPending,
    pending_your_approval: approvedCount + followupsPending,
    db_leads_processed: dbLeadsCount,
  };

  // ─── Daily KPI report to Captain (Sales + Enforcer perspectives) ──
  // Mirrors the Research Beaver pattern in services/research.js. Each beaver
  // self-reports its 24h output to agent_memory so Captain's morning brief
  // can read agent-perspective deltas instead of recomputing from raw tables.
  // Failure non-fatal — directorExecute completes regardless.
  try {
    const beaverState = require('./beaverState');
    const passRate = diagnostics.messages_drafted > 0
      ? Math.round((approvedCount / diagnostics.messages_drafted) * 100)
      : null;

    beaverState.reportDailyKPIs(clientId, 'sales_beaver', {
      drafted: diagnostics.messages_drafted,
      drafted_failed: diagnostics.messages_failed || 0,
      approved_first_pass: approvedCount,
      first_pass_rate_pct: passRate,
      followups_pending: followupsPending,
      run_kind: dbLeadsCount > 0 ? 'pool_drain' : 'cold_research',
      plan_id,
    }).catch(err => console.warn('[sales_beaver] daily KPI report failed:', err.message));

    // Note: Enforcer KPIs persist under agent='ranger' to match the
    // canonical name beaverState.readAllBeaversKPIsForToday() reads from.
    beaverState.reportDailyKPIs(clientId, 'ranger', {
      reviewed: diagnostics.messages_drafted,
      approved: approvedCount,
      rejected: rejectedCount,
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
      messagesDrafted: diagnostics.messages_drafted,
      enforcerPassed: approvedCount,
      enforcerFailed: rejectedCount,
    }).catch(() => {});
  } catch { /* learningEngine optional */ }

  return {
    plan_id,
    status: 'completed',
    leads: savedLeads.map(l => ({ name: l.name, company: l.company, title: l.title })),
    leads_found: totalLeadsFound,
    messages_drafted: diagnostics.messages_drafted,
    messages_failed: diagnostics.messages_failed,
    summary,
    diagnostics,
    results: [
      ...(dbLeadsCount > 0 ? [{ step: 0, agent: 'research_beaver', status: 'completed', result: `${dbLeadsCount} existing lead${dbLeadsCount !== 1 ? 's' : ''} processed from DB` }] : []),
      { step: 1, agent: 'research_beaver', status: 'completed', result: `${savedLeads.length} new lead${savedLeads.length !== 1 ? 's' : ''} found via research` },
      { step: 2, agent: 'sales_beaver', status: 'completed', result: `${savedMessages.length} message${savedMessages.length !== 1 ? 's' : ''} drafted (1 message per lead, best channel)` },
      { step: 3, agent: 'ranger', status: 'completed', result: `${approvedCount} approved${rejectedCount > 0 ? `, ${rejectedCount} rejected by server gates` : ''}` },
      { step: 4, agent: 'director', status: (approvedCount + followupsPending) > 0 ? 'completed' : 'pending', result: [
        approvedCount > 0 ? `${approvedCount} new outreach in approval queue` : 'All new outreach failed Ranger QA',
        followupsPending > 0 ? `${followupsPending} follow-up${followupsPending !== 1 ? 's' : ''} awaiting review` : null,
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
    pool.query("SELECT COUNT(*) FROM approvals WHERE client_id = $1 AND status = 'pending'", [clientId]),
    pool.query('SELECT agent, action, created_at FROM logs WHERE client_id = $1 ORDER BY created_at DESC LIMIT 5', [clientId]),
    pool.query("SELECT COUNT(*) FROM leads WHERE client_id = $1 AND deleted_at IS NULL AND created_at >= NOW() - INTERVAL '7 days'", [clientId]),
  ]);

  const stats = {
    total_leads: parseInt(leadsRes.rows[0].count, 10),
    messages_sent: parseInt(messagesRes.rows[0].count, 10),
    pending_approvals: parseInt(approvalsRes.rows[0].count, 10),
    leads_this_week: parseInt(leadsWeekRes.rows[0].count, 10),
  };

  let summary = `You have ${stats.total_leads} leads in the pipeline, ${stats.messages_sent} messages generated, and ${stats.pending_approvals} approval${stats.pending_approvals !== 1 ? 's' : ''} waiting for your review.`;

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

  const result = await callAgent('sales_beaver', prompt, { lead_id: leadId, mode: 'proposal' });

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
};
