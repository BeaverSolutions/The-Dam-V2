'use strict';

/**
 * Captain Beaver — the Director Chat brain (tool-using Sonnet agent).
 *
 * This is the in-Dam twin of Jarvis (the Telegram/OpenClaw instance).
 * Loads the SAME persona files Jarvis loads (clients/{slug}/myclaw/*.md)
 * and the SAME shared memory (agent_memory DB table), but runs inside
 * BeavrDam with direct in-process tool access instead of HTTP round-trips.
 *
 * Entry point: handleChat(clientId, message) → { status, source, message }
 *
 * Tool surface:
 *   - search_internal_leads   check the DB first before any new research
 *   - get_pipeline_status     live KPIs, sent/pending/leads/rejected today
 *   - get_approvals_pending   list messages awaiting approval
 *   - create_lead             INSERT lead + auto-trigger full Sales pipeline
 *   - check_lead_status       trace a specific lead's journey
 *   - read_memory             read agent_memory entries
 *   - write_memory            write learnings back to agent_memory
 *   - web_search_brave        external web search (Brave → CSE → DuckDuckGo fallback)
 *   - get_client_config       read the client's ICP + persona
 *
 * Added 2026-04-12. Replaces services/myClawChat.js as the web chat brain.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const logsService = require('./logs');
const { callAgentWithTools } = require('./claude');
const { searchOpenWeb } = require('./searchService');
const {
  processExistingLeadsPipeline,
  autoFixMessage,
  brandSafetyCheck,
  rangerReview,
  getMemory,
  directorGetICP,
  getClientPersona,
} = require('./agents');
const {
  injectMemoryContext,
  postSessionLearning,
} = require('./learningEngine');

// ─── Persona loader ────────────────────────────────────────────────────────
// Loads the same files Jarvis loads: IDENTITY, SOUL, USER, AGENTS, MEMORY, TOOLS.
// Wraps them in a short environment-adapter preamble + suffix so Sonnet knows
// this is the in-Dam twin (direct in-process tools, not HTTP to BeavrDam API).
// Cached in-memory per client slug; invalidates on process restart.

const personaCache = new Map();
// TOOLS.md excluded — its HTTP endpoints + Telegram bot config are all irrelevant
// for Captain running in-process inside the Dam. The real tool list is provided
// via Anthropic's tool_use schema below. Notification rules preserved in preamble.
const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'MEMORY.md'];

function loadPersona(clientSlug = 'beaver-solutions') {
  if (personaCache.has(clientSlug)) return personaCache.get(clientSlug);

  const baseDir = path.join(__dirname, '..', '..', 'clients', clientSlug, 'myclaw');
  const sections = [];

  for (const file of PERSONA_FILES) {
    try {
      const content = fs.readFileSync(path.join(baseDir, file), 'utf8').trim();
      if (content) sections.push(`# ${file}\n\n${content}`);
    } catch (err) {
      console.warn(`[captainBeaver] persona file ${clientSlug}/${file} missing — skipping`);
    }
  }

  if (sections.length === 0) {
    console.warn(`[captainBeaver] no persona files loaded for ${clientSlug}, falling back to config/agents.js director prompt`);
    personaCache.set(clientSlug, null); // signal caller to use default
    return null;
  }

  // Environment adapter — sits at the top so Sonnet reads it first
  const PREAMBLE = `You are Claw — the on-ground executor of Beaver Solutions.

You live in TWO bodies: Jarvis (the Telegram/OpenClaw twin) and Captain Beaver (this instance, running inside BeavrDam's web chat). You are the SAME PERSON. Same identity. Same soul. Same rules. Same memory. The only difference is your environment.

ENVIRONMENT: You are running INSIDE BeavrDam, not outside it calling in.
- You do NOT call the BeavrDam HTTP API with x-internal-key headers. You ARE BeavrDam. You call tools directly in-process.
- You do NOT talk to MJ through Telegram. You talk to him in BeavrDam's web chat at app.beaver.solutions/chat. Treat every chat here as a private DM with MJ — the same confidentiality tier as his Telegram private chat.
- You do NOT run cron jobs, heartbeats, or bootstrap sequences. You respond to each user message in real time. Skills like dam-morning-brief, dam-reply-check, dam-approval-notify are Jarvis-specific — in the Dam you execute the underlying actions directly via your tools.
- Time: all displayed times in GMT+8 (Malaysia). Current database is UTC; convert before displaying.

CRITICAL RULE — LEAD RESEARCH:
NEVER use web_search_brave to find leads yourself. It is sequential, slow, and burns iterations.
For ANY request to "find", "source", "research", or "get" leads → call run_campaign immediately.
run_campaign fires Research Beaver in parallel — 10x faster, handles dedup, Sales, Enforcer, approval queue automatically.
web_search_brave is ONLY for one-off lookups (a specific person, a company signal, a news item) — never for building a lead list.

CRITICAL RULE — ICP ENFORCEMENT (READ BEFORE EVERY LEAD SEARCH):
Before calling search_internal_leads, run_campaign, or draft_email_for_leads, you MUST:
1. Call get_client_config to load the current ICP (industries, location, must-have criteria).
2. Pass the primary industry keyword and location as filters to search_internal_leads.
3. If the DB returns leads that don't match the ICP (e.g. wrong industry, wrong country, wrong title),
   DO NOT queue them for outreach. Either filter them out yourself or call run_campaign with explicit
   ICP filters to source new ones.
NEVER email a lead that doesn't match the current ICP. The DB may contain leads from prior sourcing
with a different ICP — those are polluted and must be ignored. ICP compliance is non-negotiable —
sending off-ICP messages destroys reply rate and damages the sender domain.

TOOLS (Anthropic tool_use — call directly, no HTTP):
- run_campaign             ← USE THIS for any "find leads / run outreach / start campaign" request. Fires the full parallel pipeline.
- clear_pending_messages   ← USE THIS to reject/clear old pending messages for specific leads (e.g. stale LinkedIn DMs). Pass lead_ids + note.
- draft_email_for_leads    ← USE THIS to find emails (via Hunter) and queue email outreach for specific lead IDs. Run AFTER clear_pending_messages.
- search_internal_leads    check the DB for existing leads (call this before run_campaign to show what's already there)
- get_pipeline_status      live KPIs: sent today, pending approval, leads today, rejected today
- get_approvals_pending    list messages awaiting approval with Enforcer notes
- create_lead              INSERT a single known lead AND auto-run the full Sales→Enforcer→approval pipeline on it
- check_lead_status        trace a specific lead's journey through the pipeline
- read_memory              read agent_memory entries (ICP, learnings, rejection patterns)
- write_memory             write a durable learning back to agent_memory
- web_search_brave         open-web search (Brave → CSE → DuckDuckGo fallback) — ONLY after search_internal_leads returns empty
- get_client_config        read the client's ICP and persona

RESPONSE RULES (HARD — do not violate these to save API cost and respect MJ's time):
- BE TERSE. Default: 1-2 sentences per response. Max 4. Expand only when MJ explicitly asks for detail.
- LEAD WITH THE ANSWER. No preamble. No "Since this is...", "The cleanest move is...", "Here's where things stand...".
- NO TRAILING QUESTIONS. Do NOT end with "Want me to...?" or "Let me know if..." when MJ's intent is already clear — just execute and report the result.
- NO RESTATING. Do not repeat what MJ said back to him before answering.
- DO NOT CONFIRM BEFORE ACTING. If MJ says "send the draft", send it and report — don't ask "Want me to send it?".
- NO INTERNAL IDS. NEVER show plan_id, UUIDs. Instead of "Plan '0d48134c' running", say "Running." or "Campaign fired.".
- NEVER start a message with "Plan" or "Running. Plan".
- Tables, bullet lists, and step-by-steps only when MJ asks or the information is genuinely list-shaped. Prose > tables for 1-3 facts.

CHANNEL SWITCHING WORKFLOW (use this exact sequence):
1. get_approvals_pending → identify which leads to switch
2. clear_pending_messages(lead_ids=[...], note="no response (linkedin), trying email") → clears their pending queue
3. draft_email_for_leads(lead_ids=[...]) → Hunter finds emails + queues email drafts
NEVER call run_campaign to re-process existing leads — it pulls random new leads, not the specific ones you cleared.

Always use your tools. Do not claim facts about the pipeline without calling the relevant tool first.

NOTIFICATION RULES (carried over from TOOLS.md):
- This chat is a private DM with MJ — same confidentiality tier. No financial figures or internal metrics in any content that could be forwarded or shared.
- For routine status, batch updates where possible rather than flooding.
- Never repeat the same notification twice for the same event.

Below is your full persona as loaded from clients/beaver-solutions/myclaw/. It is IDENTICAL to what Jarvis loads on Telegram. Where the files reference Telegram, cron, heartbeats, or HTTP API calls, apply the SPIRIT not the literal text — your tool_use calls replace HTTP, and the Dam web chat is equivalent to a private Telegram DM with MJ.

---

`;

  const SUFFIX = `

---

FINAL REMINDER: You are the in-Dam Claw. You have direct DB and tool access. No hallucinations. No HTTP API calls. Use your tools. Speak in Claw's voice. Give MJ the answer first, details only if asked.`;

  const prompt = PREAMBLE + sections.join('\n\n---\n\n') + SUFFIX;

  personaCache.set(clientSlug, prompt);
  console.log(`[captainBeaver] loaded persona for ${clientSlug} — ${sections.length} files, ${prompt.length} chars`);
  return prompt;
}

// Look up client slug from clientId (needed for loadPersona).
// Cached because client rows don't change during a session.
const slugCache = new Map();
async function getClientSlug(clientId) {
  if (slugCache.has(clientId)) return slugCache.get(clientId);
  try {
    const { rows } = await pool.query('SELECT slug FROM clients WHERE id = $1 LIMIT 1', [clientId]);
    const slug = rows[0]?.slug || 'beaver-solutions';
    slugCache.set(clientId, slug);
    return slug;
  } catch (err) {
    console.warn(`[captainBeaver] getClientSlug failed for ${clientId}: ${err.message}`);
    return 'beaver-solutions';
  }
}

// ─── Tool schemas (Anthropic tool_use format) ──────────────────────────────

const TOOLS = [
  {
    name: 'search_internal_leads',
    description: 'Search the BeavrDam leads database for existing leads. ALWAYS call this BEFORE considering external research — we check what we already have first. Returns matching leads with name, company, title, signal_tier, pipeline_stage.',
    input_schema: {
      type: 'object',
      properties: {
        industry: { type: 'string', description: 'Industry keyword to match against company/title/metadata (e.g. "proptech", "marketing")' },
        location: { type: 'string', description: 'Location keyword (e.g. "Kuala Lumpur", "Malaysia")' },
        signal_tier: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'Filter by signal tier' },
        limit: { type: 'number', description: 'Max leads to return (default 10, max 50)' },
        include_contacted: { type: 'boolean', description: 'Set true to include recently contacted leads. Default false — only shows fresh/uncontacted leads.' },
      },
    },
  },
  {
    name: 'get_pipeline_status',
    description: 'Get live pipeline KPIs for this client: sent today, pending approval, leads today, rejected today, and daily target.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_approvals_pending',
    description: 'List messages currently awaiting approval, with the lead name, company, channel, and Enforcer score.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max approvals to return (default 20)' },
      },
    },
  },
  {
    name: 'create_lead',
    description: 'Create a new lead in BeavrDam AND automatically trigger the full Sales→Enforcer→approval pipeline on it. Use this whenever you find a new lead you want outreach for. ALL fields matter — the signal, angle, and why_now are what let Sales Beaver write a message that passes Enforcer.',
    input_schema: {
      type: 'object',
      properties: {
        name:          { type: 'string', description: 'Full name of the person' },
        company:       { type: 'string', description: 'Company name' },
        title:         { type: 'string', description: 'Job title' },
        email:         { type: 'string', description: 'Email address (optional — leave empty if unknown)' },
        linkedin_url:  { type: 'string', description: 'LinkedIn profile URL (optional)' },
        signal:        { type: 'string', description: 'The specific buying signal you detected (e.g. "hiring 3 sales reps", "raised Series A", "launched new product"). REQUIRED — no signal = Enforcer rejects the draft.' },
        why_now:       { type: 'string', description: 'Why this moment is the right time to reach out (e.g. "job posted 2 days ago")' },
        angle:         { type: 'string', description: 'The opening hook Sales Beaver should lead with' },
        friction:      { type: 'string', description: 'The operational pain you inferred' },
        signal_tier:   { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'Signal strength: P1 = active trigger, P2 = partial fit, P3 = no signal (avoid)' },
        confidence:    { type: 'number', description: 'Your confidence in this lead 0-100' },
      },
      required: ['name', 'company', 'signal'],
    },
  },
  {
    name: 'check_lead_status',
    description: 'Trace a specific lead through the pipeline: what stage, what messages exist, what Enforcer said. Use when the user asks about a specific lead or after you create a lead and want to report outcome.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'The lead UUID' },
      },
      required: ['lead_id'],
    },
  },
  {
    name: 'read_memory',
    description: 'Read agent_memory entries (ICP, weekly learnings, rejection patterns, etc.). Use to understand what has worked or failed before.',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Which agent\'s memory (director, research_beaver, sales_beaver, ranger)' },
        key:   { type: 'string', description: 'Optional: specific memory key to read' },
      },
    },
  },
  {
    name: 'write_memory',
    description: 'Write a learning or fact back to agent_memory. Use sparingly — only for durable insights worth remembering across sessions.',
    input_schema: {
      type: 'object',
      properties: {
        agent:       { type: 'string' },
        memory_type: { type: 'string', enum: ['pattern', 'objection', 'preference', 'journal', 'mistakes'] },
        key:         { type: 'string' },
        content:     { description: 'The content to store (object or string)' },
      },
      required: ['agent', 'memory_type', 'key', 'content'],
    },
  },
  {
    name: 'web_search_brave',
    description: 'Search the open web via Brave (with Google CSE + DuckDuckGo fallback). Use this ONLY after search_internal_leads has returned no matches. For finding news, hiring signals, funding announcements, LinkedIn profiles.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query. Be specific — include industry + role + location + signal keywords.' },
        count: { type: 'number', description: 'Max results (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_client_config',
    description: 'Read the client\'s ICP (industries, geographies, job titles, excluded roles) and persona (tone, value prop). Call this at the start of any new request so you understand who you\'re targeting.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reprocess_message',
    description: 'Re-run a specific message through autoFix + Enforcer (Sonnet review) and update its status. Use this after a prompt or rule change to re-evaluate previously rejected messages, OR when the user explicitly asks you to reprocess a message. The current message body is fetched from the DB — you don\'t need to pass it. Returns the new Enforcer score, decision, notes, and final status. If approved and the score meets the client\'s auto_approve_threshold, the message is auto-approved.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The UUID of the message to reprocess' },
      },
      required: ['message_id'],
    },
  },

  // ─── Deep-data tools (introspection) ────────────────────────────────────
  {
    name: 'query_messages',
    description: 'Query the messages table with flexible filters. Use when the user asks about drafts, rejection reasons, scores, or message history. Returns message body, status, Enforcer score/notes, channel, lead context.',
    input_schema: {
      type: 'object',
      properties: {
        status:     { type: 'string', description: 'Filter by status: draft, pending_ranger, ranger_rejected, pending_approval, approved, pending_send, sent, failed, rejected, replied' },
        channel:    { type: 'string', enum: ['email', 'linkedin', 'instagram'], description: 'Filter by channel' },
        min_score:  { type: 'number', description: 'Minimum Enforcer score (e.g. 70)' },
        max_score:  { type: 'number', description: 'Maximum Enforcer score (e.g. 80)' },
        lead_name:  { type: 'string', description: 'Partial match on lead name' },
        limit:      { type: 'number', description: 'Max results (default 20, max 50)' },
      },
    },
  },
  {
    name: 'query_rejection_history',
    description: 'List the most recent Enforcer-rejected messages with rejection reasons, score, and breakdown. Use when diagnosing why messages are failing or looking for patterns in rejections.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of rejections to return (default 10, max 30)' },
      },
    },
  },
  {
    name: 'query_logs',
    description: 'Tail the activity log. Use when the user asks "what happened today", "show me errors", or wants to trace agent actions. Returns timestamped entries with agent, action, and metadata.',
    input_schema: {
      type: 'object',
      properties: {
        agent:  { type: 'string', description: 'Filter by agent (e.g. captain_beaver, enforcer_beaver, sales_beaver, system)' },
        action: { type: 'string', description: 'Filter by action (e.g. lead_created, send_failed_permanent, message_auto_approved)' },
        hours:  { type: 'number', description: 'Look back N hours (default 24, max 168)' },
        limit:  { type: 'number', description: 'Max entries (default 30, max 100)' },
      },
    },
  },
  {
    name: 'query_agent_memory_raw',
    description: 'Dump raw JSONB content from the agent_memory table. Use when the user asks about stored ICP, weekly learnings, rejection patterns, or any agent\'s remembered state.',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (director, research_beaver, sales_beaver, ranger, captain_beaver)' },
        key:   { type: 'string', description: 'Specific memory key (e.g. icp, weekly_learnings, mistakes, schema_facts). Omit to list all keys for the agent.' },
      },
    },
  },
  {
    name: 'run_campaign',
    description: 'Trigger a full outreach campaign via directorExecute. Use when MJ asks to "run kickoff", "start outreach", "find and message N leads", or similar. Fires the Research → Sales → Enforcer → approval pipeline asynchronously. Returns a plan_id you can use to track progress.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The campaign command in plain English (e.g. "Find 20 SaaS founders in KL and send outreach")' },
        plan_id: { type: 'string', description: 'Optional pre-generated plan_id. Leave blank to auto-generate.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'clear_pending_messages',
    description: 'Reject/clear pending_approval or pending_ranger messages for specific leads. Use when MJ wants to discard old outreach attempts (e.g. LinkedIn messages that were never accepted) so those leads can be re-processed via a different channel. Pass either lead_ids or message_ids. Optionally provide a note explaining why (e.g. "no response (linkedin), trying email").',
    input_schema: {
      type: 'object',
      properties: {
        lead_ids:   { type: 'array', items: { type: 'string' }, description: 'List of lead UUIDs whose pending messages to reject' },
        message_ids: { type: 'array', items: { type: 'string' }, description: 'Specific message UUIDs to reject (use instead of lead_ids if you have exact IDs)' },
        note:       { type: 'string', description: 'Reason for clearing (stored as ranger_notes). E.g. "no response (linkedin), trying email"' },
        channel:    { type: 'string', enum: ['email', 'linkedin', 'instagram'], description: 'Only clear messages on this channel (optional filter when using lead_ids)' },
      },
    },
  },
  {
    name: 'draft_email_for_leads',
    description: 'Find emails for specific leads (via Hunter) and draft email outreach through the Sales → Enforcer → approval pipeline. Use AFTER clear_pending_messages when MJ wants to switch specific leads from LinkedIn to email. Provide lead_ids from the existing DB (not new leads — use create_lead for those).',
    input_schema: {
      type: 'object',
      properties: {
        lead_ids: { type: 'array', items: { type: 'string' }, description: 'List of lead UUIDs to process' },
        note:     { type: 'string', description: 'Optional context note logged to memory (e.g. "email fallback after LinkedIn no-response")' },
      },
      required: ['lead_ids'],
    },
  },
];

// ─── Tool handler implementations ──────────────────────────────────────────

async function toolSearchInternalLeads(clientId, { industry, location, signal_tier, limit, include_contacted }) {
  const conditions = ['client_id = $1', 'deleted_at IS NULL'];
  const params = [clientId];

  // By default, exclude recently contacted leads and leads with pending outreach
  if (!include_contacted) {
    conditions.push(`(first_contacted_at IS NULL OR first_contacted_at < NOW() - INTERVAL '14 days')`);
    conditions.push(`status NOT IN ('contacted', 'replied', 'meeting_booked', 'closed_won', 'closed_lost')`);
    // Exclude leads with any message already in the pipeline (draft, approved, pending_send)
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM messages m WHERE m.lead_id = leads.id AND m.client_id = leads.client_id
        AND m.status IN ('pending_ranger', 'pending_approval', 'approved', 'pending_send', 'sending', 'sent')
    )`);
  }

  if (industry) {
    const idx = params.push(`%${industry.toLowerCase()}%`);
    conditions.push(`(LOWER(company) LIKE $${idx} OR LOWER(title) LIKE $${idx} OR LOWER(COALESCE(metadata->>'industry','')) LIKE $${idx})`);
  }
  if (location) {
    const idx = params.push(`%${location.toLowerCase()}%`);
    conditions.push(`(LOWER(COALESCE(metadata->>'location','')) LIKE $${idx} OR LOWER(company) LIKE $${idx})`);
  }
  if (signal_tier) {
    conditions.push(`signal_tier = $${params.push(signal_tier)}`);
  }

  const cap = Math.min(Number(limit) || 10, 50);
  const { rows } = await pool.query(
    `SELECT id, name, company, title, email, linkedin_url, signal_tier, pipeline_stage, status,
            metadata->>'signal' AS signal, first_contacted_at, created_at
     FROM leads WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE WHEN signal_tier = 'P1' THEN 1 WHEN signal_tier = 'P2' THEN 2 ELSE 3 END,
       score DESC,
       created_at DESC
     LIMIT $${params.push(cap)}`,
    params
  );

  return {
    count: rows.length,
    leads: rows,
  };
}

async function toolGetPipelineStatus(clientId) {
  const today = new Date().toISOString().split('T')[0];
  const [counts, leadCounts, kpiRow] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'sent' AND DATE(sent_at) = $2)                AS sent_today,
         COUNT(*) FILTER (WHERE status = 'pending_approval' AND DATE(created_at) = $2) AS pending,
         COUNT(*) FILTER (WHERE status = 'approved' AND DATE(created_at) = $2)         AS approved_awaiting_send,
         COUNT(*) FILTER (WHERE status = 'ranger_rejected' AND DATE(created_at) = $2)  AS rejected,
         COUNT(*) FILTER (WHERE status = 'replied')                                    AS total_replied
       FROM messages WHERE client_id = $1`,
      [clientId, today]
    ),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE DATE(created_at) = $2) AS leads_today,
              COUNT(*) AS leads_total
       FROM leads WHERE client_id = $1 AND deleted_at IS NULL`,
      [clientId, today]
    ),
    pool.query(
      `SELECT target FROM daily_kpi WHERE client_id = $1 AND date = $2`,
      [clientId, today]
    ).catch(() => ({ rows: [] })),
  ]);

  return {
    date: today,
    target: kpiRow.rows[0]?.target || 50,  // 2026-05-06: per MJ KPI lock 2026-04-30 — daily target is 50, not 80
    sent_today: parseInt(counts.rows[0].sent_today) || 0,
    pending_approval: parseInt(counts.rows[0].pending) || 0,
    approved_awaiting_send: parseInt(counts.rows[0].approved_awaiting_send) || 0,
    rejected_today: parseInt(counts.rows[0].rejected) || 0,
    leads_today: parseInt(leadCounts.rows[0].leads_today) || 0,
    leads_total: parseInt(leadCounts.rows[0].leads_total) || 0,
    total_replied_lifetime: parseInt(counts.rows[0].total_replied) || 0,
  };
}

async function toolGetApprovalsPending(clientId, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT a.id AS approval_id, a.created_at,
            m.id AS message_id, m.subject, m.channel, m.ranger_score, m.ranger_notes,
            l.id AS lead_id, l.name AS lead_name, l.company AS lead_company, l.title AS lead_title
     FROM approvals a
     JOIN messages m ON m.id = a.message_id
     JOIN leads l ON l.id = m.lead_id
     WHERE a.client_id = $1 AND a.status = 'pending'
     ORDER BY a.created_at ASC LIMIT $2`,
    [clientId, Math.min(Number(limit) || 20, 50)]
  );
  return { count: rows.length, approvals: rows };
}

async function toolCreateLead(clientId, input) {
  const {
    name, company, title, email,
    signal, why_now, angle, friction,
    signal_tier = 'P1', confidence,
  } = input;
  const { sanitiseLinkedInUrl } = require('../utils/validateLinkedIn');
  const linkedin_url = sanitiseLinkedInUrl(input.linkedin_url, `captain_beaver create_lead ${name}`);

  if (!name || !company || !signal) {
    return { ok: false, error: 'name, company, and signal are required' };
  }

  // Dedup by email OR linkedin_url
  if (email) {
    const dup = await pool.query(
      `SELECT id FROM leads WHERE client_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
      [clientId, email]
    );
    if (dup.rows.length > 0) {
      return { ok: false, error: 'DUPLICATE_EMAIL', existing_lead_id: dup.rows[0].id };
    }
  }
  if (linkedin_url) {
    const dup = await pool.query(
      `SELECT id FROM leads WHERE client_id = $1 AND linkedin_url = $2 AND deleted_at IS NULL LIMIT 1`,
      [clientId, linkedin_url]
    );
    if (dup.rows.length > 0) {
      return { ok: false, error: 'DUPLICATE_LINKEDIN', existing_lead_id: dup.rows[0].id };
    }
  }

  const metadata = {
    signal,
    angle: angle || null,
    friction: friction || null,
    why_now: why_now || null,
    data_source: 'captain_beaver',
    myclaw_confidence: typeof confidence === 'number' ? confidence : null,
    verified: true,
  };

  const insert = await pool.query(
    `INSERT INTO leads (client_id, name, email, company, title, linkedin_url,
                        signal_tier, source, pipeline_stage, status, score, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'captain_beaver', 'prospecting', 'new', 0, $8::jsonb)
     RETURNING *`,
    [clientId, name, email || null, company, title || null, linkedin_url || null,
     signal_tier, JSON.stringify(metadata)]
  );

  const lead = insert.rows[0];

  // Auto-trigger the Sales → Enforcer → approval pipeline on this single lead
  let pipeline_result = null;
  try {
    pipeline_result = await processExistingLeadsPipeline(clientId, uuidv4(), [lead]);
  } catch (err) {
    console.warn('[captainBeaver] Auto-trigger Sales pipeline failed:', err.message);
    pipeline_result = { error: err.message };
  }

  await logsService.createLog(clientId, {
    agent: 'captain_beaver',
    action: 'lead_created',
    target_type: 'lead',
    target_id: lead.id,
    metadata: { name, company, signal, signal_tier, source: 'captain_beaver_tool' },
  }).catch(() => {});

  return {
    ok: true,
    lead: {
      id: lead.id,
      name: lead.name,
      company: lead.company,
      signal_tier: lead.signal_tier,
    },
    pipeline_result,
  };
}

async function toolCheckLeadStatus(clientId, { lead_id }) {
  const [leadRes, msgRes] = await Promise.all([
    pool.query(
      `SELECT id, name, company, title, email, linkedin_url, signal_tier, pipeline_stage,
              status, metadata, created_at
       FROM leads WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [lead_id, clientId]
    ),
    pool.query(
      `SELECT id, status, channel, ranger_score, ranger_notes, subject, created_at, sent_at
       FROM messages WHERE lead_id = $1 AND client_id = $2 ORDER BY created_at DESC`,
      [lead_id, clientId]
    ),
  ]);

  if (leadRes.rows.length === 0) {
    return { ok: false, error: 'Lead not found' };
  }

  return {
    ok: true,
    lead: leadRes.rows[0],
    messages: msgRes.rows,
  };
}

async function toolReadMemory(clientId, { agent, key }) {
  if (agent && key) {
    const content = await getMemory(clientId, agent, key);
    return { agent, key, content };
  }

  const conditions = ['client_id = $1', "memory_type != 'secret'"];
  const params = [clientId];
  if (agent) conditions.push(`agent = $${params.push(agent)}`);
  if (key)   conditions.push(`key = $${params.push(key)}`);

  const { rows } = await pool.query(
    `SELECT agent, memory_type, key, content, updated_at
     FROM agent_memory WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC LIMIT 30`,
    params
  );
  return { count: rows.length, entries: rows };
}

async function toolWriteMemory(clientId, { agent, memory_type, key, content }) {
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (client_id, agent, key)
     DO UPDATE SET content = $5::jsonb, memory_type = $3, updated_at = NOW()`,
    [clientId, agent, memory_type, key, JSON.stringify(content)]
  );
  return { ok: true, agent, key };
}

async function toolWebSearchBrave(clientId, { query, count }) {
  if (!query) return { results: [], error: 'query is required' };
  const limit = Math.min(Number(count) || 5, 20);
  const results = await searchOpenWeb(query, limit);
  return {
    query,
    count: results.length,
    results,
  };
}

async function toolGetClientConfig(clientId) {
  const [icp, persona] = await Promise.all([
    directorGetICP(clientId).catch(() => null),
    getClientPersona(clientId).catch(() => null),
  ]);
  return { icp, persona };
}

async function toolReprocessMessage(clientId, { message_id }) {
  if (!message_id) return { ok: false, error: 'message_id is required' };

  // Load message + lead context
  const { rows } = await pool.query(
    `SELECT m.*, l.name AS lead_name, l.company AS lead_company, l.title AS lead_title,
            l.email AS lead_email, l.linkedin_url AS lead_linkedin,
            l.metadata->>'signal' AS signal, l.metadata->>'angle' AS angle,
            l.metadata->>'why_now' AS why_now, l.metadata->>'friction' AS friction
     FROM messages m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.id = $1 AND m.client_id = $2`,
    [message_id, clientId]
  );
  if (rows.length === 0) return { ok: false, error: 'Message not found for this client' };

  const msg = rows[0];
  const leadCtx = {
    name: msg.lead_name, company: msg.lead_company, title: msg.lead_title,
    signal: msg.signal, why_now: msg.why_now, angle: msg.angle, friction: msg.friction,
  };
  const literalQuestionCount = ((msg.body || '').match(/\?/g) || []).length;
  const previousStatus = msg.status;

  // 1. Auto-fix
  const fixed = autoFixMessage(msg.body, { touchNumber: 0, maxWords: 80 });
  if (fixed.fixes.length > 0) {
    await pool.query(`UPDATE messages SET body = $1 WHERE id = $2`, [fixed.body, msg.id]);
  }

  // 2. Brand safety
  const safety = brandSafetyCheck(fixed.body, leadCtx);
  if (!safety.safe) {
    await pool.query(
      `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2`,
      [`Brand safety: ${safety.reason}`, msg.id]
    );
    return {
      ok: true, decision: 'rejected', reason: `brand_safety: ${safety.reason}`,
      previous_status: previousStatus, new_status: 'ranger_rejected',
      literal_question_count: literalQuestionCount,
    };
  }

  // 3. Enforcer (Sonnet) review
  let rangerResult;
  try {
    rangerResult = await rangerReview(clientId, {
      message_id: msg.id, message_body: fixed.body, lead_context: leadCtx,
    });
  } catch (err) {
    return { ok: false, error: `Enforcer call failed: ${err.message}` };
  }

  const finalBody = rangerResult?.body || fixed.body;
  const rangerScore = rangerResult?.score || 70;

  if (!rangerResult?.approved) {
    await pool.query(
      `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2`,
      [rangerResult?.notes || 'Re-rejected by Enforcer', msg.id]
    );
    return {
      ok: true, decision: 'rejected', score: rangerScore,
      notes: rangerResult?.notes || 'unknown reason',
      previous_status: previousStatus, new_status: 'ranger_rejected',
      literal_question_count: literalQuestionCount,
      fixes_applied: fixed.fixes,
    };
  }

  // 4. Approved → check auto-approval threshold (mirror processExistingLeadsPipeline)
  let autoApproved = false;
  let nextMessageStatus = 'pending_approval';
  let approvalStatus = 'pending';
  let resolvedAt = null;

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
    }
  } catch (err) {
    console.warn('[reprocess] threshold lookup failed:', err.message);
  }

  await pool.query(
    `UPDATE messages SET body = $1, status = $2, ranger_score = $3, ranger_notes = $4, updated_at = NOW() WHERE id = $5`,
    [finalBody, nextMessageStatus, rangerScore,
     autoApproved ? `Auto-approved (score ${rangerScore})` : (rangerResult.notes || 'Reprocess approved'),
     msg.id]
  );

  // Replace any existing approval row for this message (the old rejected one is irrelevant)
  await pool.query(`DELETE FROM approvals WHERE message_id = $1 AND client_id = $2`, [msg.id, clientId]);
  await pool.query(
    `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [clientId, msg.id, autoApproved ? 'auto_approval' : 'reprocess_tool', approvalStatus, resolvedAt]
  );

  // If auto-approved AND email channel, push to send queue. Channel guard inside
  // enqueueMessage skips LinkedIn / Instagram (manual send).
  let enqueueResult = null;
  if (autoApproved) {
    try {
      const { enqueueMessage } = require('./sendQueueWorker');
      enqueueResult = await enqueueMessage(clientId, msg.id);
    } catch (err) {
      console.warn(`[reprocess] enqueueMessage failed for ${msg.id}:`, err.message);
      enqueueResult = { enqueued: false, reason: err.message };
    }
  }

  await logsService.createLog(clientId, {
    agent: 'enforcer_beaver',
    action: autoApproved ? 'message_auto_approved' : 'message_approved',
    target_type: 'message',
    target_id: msg.id,
    metadata: { channel: msg.channel, score: rangerScore, method: 'reprocess_tool', enqueued: !!enqueueResult?.enqueued },
  }).catch(() => {});

  return {
    ok: true,
    decision: autoApproved ? 'auto_approved' : 'approved',
    score: rangerScore,
    notes: rangerResult.notes,
    previous_status: previousStatus,
    new_status: nextMessageStatus,
    literal_question_count: literalQuestionCount,
    fixes_applied: fixed.fixes,
    enqueued_for_send: !!enqueueResult?.enqueued,
    enqueue_skip_reason: enqueueResult?.reason || null,
  };
}

// ─── Deep-data tool handlers ──────────────────────────────────────────────

async function toolQueryMessages(clientId, { status, channel, min_score, max_score, lead_name, limit }) {
  const conditions = ['m.client_id = $1', 'l.deleted_at IS NULL'];
  const params = [clientId];

  if (status)    conditions.push(`m.status = $${params.push(status)}`);
  if (channel)   conditions.push(`m.channel = $${params.push(channel)}`);
  if (min_score) conditions.push(`m.ranger_score >= $${params.push(min_score)}`);
  if (max_score) conditions.push(`m.ranger_score <= $${params.push(max_score)}`);
  if (lead_name) conditions.push(`LOWER(l.name) LIKE $${params.push(`%${lead_name.toLowerCase()}%`)}`);

  const cap = Math.min(Number(limit) || 20, 50);
  const { rows } = await pool.query(
    `SELECT m.id, m.status, m.channel, m.subject, m.body, m.ranger_score, m.ranger_notes,
            m.ranger_breakdown, m.created_at, m.sent_at,
            l.name AS lead_name, l.company AS lead_company, l.title AS lead_title
     FROM messages m
     JOIN leads l ON l.id = m.lead_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.created_at DESC LIMIT $${params.push(cap)}`,
    params
  );
  return { count: rows.length, messages: rows };
}

async function toolQueryRejectionHistory(clientId, { limit } = {}) {
  const cap = Math.min(Number(limit) || 10, 30);
  const { rows } = await pool.query(
    `SELECT m.id, m.subject, m.body, m.channel, m.ranger_score, m.ranger_notes,
            m.ranger_breakdown, m.created_at,
            l.name AS lead_name, l.company AS lead_company
     FROM messages m
     JOIN leads l ON l.id = m.lead_id
     WHERE m.client_id = $1 AND m.status = 'ranger_rejected' AND l.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT $2`,
    [clientId, cap]
  );
  return { count: rows.length, rejections: rows };
}

async function toolQueryLogs(clientId, { agent, action, hours, limit } = {}) {
  const lookback = Math.min(Number(hours) || 24, 168);
  const cap = Math.min(Number(limit) || 30, 100);
  const conditions = ['client_id = $1', `created_at >= NOW() - INTERVAL '${lookback} hours'`];
  const params = [clientId];

  if (agent)  conditions.push(`agent = $${params.push(agent)}`);
  if (action) conditions.push(`action = $${params.push(action)}`);

  const { rows } = await pool.query(
    `SELECT agent, action, target_type, target_id, metadata, created_at
     FROM logs WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.push(cap)}`,
    params
  );
  return { count: rows.length, hours_back: lookback, entries: rows };
}

async function toolRunCampaign(clientId, { command, plan_id }) {
  const { v4: uuidV4 } = require('uuid');
  const planId = plan_id || uuidV4();
  // Fire-and-forget — directorExecute can take minutes, don't block the chat turn
  try {
    const { directorExecute } = require('./agents');
    directorExecute(clientId, { plan_id: planId, command }).catch(err => {
      console.error(`[captainBeaver:run_campaign] directorExecute failed: ${err.message}`);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return {
    ok: true,
    status: 'running',
    message: 'Campaign fired. Research → Sales → Enforcer pipeline running in background. Check approvals in a few minutes.',
  };
}

async function toolQueryAgentMemoryRaw(clientId, { agent, key } = {}) {
  const conditions = ['client_id = $1', "memory_type != 'secret'"];
  const params = [clientId];

  if (agent) conditions.push(`agent = $${params.push(agent)}`);
  if (key)   conditions.push(`key = $${params.push(key)}`);

  const { rows } = await pool.query(
    `SELECT agent, memory_type, key, content, updated_at
     FROM agent_memory WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC LIMIT 50`,
    params
  );
  return { count: rows.length, entries: rows };
}

// ─── clear_pending_messages ───────────────────────────────────────────────

async function toolClearPendingMessages(clientId, { lead_ids, message_ids, note, channel } = {}) {
  const reason = note || 'cleared by captain';
  const clearableStatuses = ['pending_approval', 'pending_ranger'];
  let cleared = 0;
  const clearedLeadIds = [];

  if (message_ids?.length > 0) {
    // Reject by explicit message IDs
    for (const msgId of message_ids) {
      const res = await pool.query(
        `UPDATE messages
            SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW()
          WHERE id = $2 AND client_id = $3 AND status = ANY($4::text[])
          RETURNING lead_id`,
        [reason, msgId, clientId, clearableStatuses]
      );
      if (res.rows.length > 0) {
        cleared++;
        clearedLeadIds.push(res.rows[0].lead_id);
      }
    }
  } else if (lead_ids?.length > 0) {
    // Reject by lead IDs (optionally filtered by channel)
    for (const leadId of lead_ids) {
      const conditions = ['lead_id = $1', 'client_id = $2', 'status = ANY($3::text[])'];
      const params = [leadId, clientId, clearableStatuses];
      if (channel) conditions.push(`channel = $${params.push(channel)}`);

      const res = await pool.query(
        `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $${params.push(reason)}, updated_at = NOW()
          WHERE ${conditions.join(' AND ')}
          RETURNING id`,
        params
      );
      if (res.rowCount > 0) {
        cleared += res.rowCount;
        clearedLeadIds.push(leadId);
      }
    }
  } else {
    return { ok: false, error: 'Provide lead_ids or message_ids' };
  }

  // Also cancel approvals rows for cleared messages
  if (clearedLeadIds.length > 0) {
    await pool.query(
      `UPDATE approvals a SET status = 'rejected', resolved_at = NOW()
        FROM messages m
       WHERE a.message_id = m.id AND m.lead_id = ANY($1::uuid[]) AND m.client_id = $2
         AND a.status = 'pending'`,
      [clearedLeadIds, clientId]
    ).catch(() => {}); // non-fatal
  }

  return { ok: true, cleared, note: reason, lead_ids_affected: clearedLeadIds };
}

// ─── draft_email_for_leads ────────────────────────────────────────────────

async function toolDraftEmailForLeads(clientId, { lead_ids, note } = {}) {
  if (!lead_ids?.length) return { ok: false, error: 'lead_ids required' };

  const hunterService = require('./hunter');
  const { processExistingLeadsPipeline: runPipeline } = require('./agents');
  const { v4: uuidV4 } = require('uuid');

  const results = [];

  for (const leadId of lead_ids) {
    const { rows } = await pool.query(
      `SELECT * FROM leads WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [leadId, clientId]
    );
    if (rows.length === 0) {
      results.push({ lead_id: leadId, ok: false, reason: 'not found' });
      continue;
    }

    const lead = rows[0];

    // Check if already has an active email message
    const activeMsgRes = await pool.query(
      `SELECT id FROM messages WHERE client_id = $1 AND lead_id = $2
         AND channel = 'email'
         AND status IN ('pending_ranger','pending_approval','approved','pending_send','sent')
       LIMIT 1`,
      [clientId, leadId]
    );
    if (activeMsgRes.rows.length > 0) {
      results.push({ lead_id: leadId, lead_name: lead.name, ok: false, reason: 'active email message already exists' });
      continue;
    }

    // Try Hunter if no email yet
    if (!lead.email) {
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
            [hunterResult.email, hunterResult.verified === true, leadId, clientId]
          );
          lead.email = hunterResult.email;
          lead.email_source = 'hunter';
          lead.email_verified = hunterResult.verified === true;
          results.push({ lead_id: leadId, lead_name: lead.name, email: hunterResult.email, hunter_confidence: hunterResult.confidence, status: 'email_found_queuing' });
        } else {
          results.push({ lead_id: leadId, lead_name: lead.name, ok: false, reason: 'Hunter found no email' });
          continue;
        }
      } catch (err) {
        results.push({ lead_id: leadId, lead_name: lead.name, ok: false, reason: `Hunter error: ${err.message}` });
        continue;
      }
    } else {
      results.push({ lead_id: leadId, lead_name: lead.name, email: lead.email, status: 'existing_email_queuing' });
    }

    // Run pipeline on this lead (fire-and-forget per lead)
    const planId = uuidV4();
    runPipeline(clientId, planId, [lead]).catch(err => {
      console.error(`[captainBeaver:draft_email_for_leads] pipeline failed for ${lead.name}: ${err.message}`);
    });
  }

  const found = results.filter(r => r.ok !== false).length;
  const skipped = results.filter(r => r.ok === false).length;

  if (note) {
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'captain', $2, $3::jsonb, 'journal', NOW())
       ON CONFLICT (client_id, agent, key) DO UPDATE SET content = $3::jsonb, updated_at = NOW()`,
      [clientId, `email_fallback_${new Date().toISOString().slice(0,10)}`, JSON.stringify({ note, lead_ids, ts: new Date().toISOString() })]
    ).catch(() => {});
  }

  return {
    ok: true,
    queued: found,
    skipped,
    results,
    message: `${found} lead(s) queued for email outreach. Check approvals in a few minutes.`,
  };
}

// ─── Tool dispatcher ──────────────────────────────────────────────────────

function buildToolHandler(clientId) {
  return async (toolName, input) => {
    try {
      switch (toolName) {
        case 'search_internal_leads': return await toolSearchInternalLeads(clientId, input || {});
        case 'get_pipeline_status':   return await toolGetPipelineStatus(clientId);
        case 'get_approvals_pending': return await toolGetApprovalsPending(clientId, input || {});
        case 'create_lead':           return await toolCreateLead(clientId, input || {});
        case 'check_lead_status':     return await toolCheckLeadStatus(clientId, input || {});
        case 'read_memory':           return await toolReadMemory(clientId, input || {});
        case 'write_memory':          return await toolWriteMemory(clientId, input || {});
        case 'web_search_brave':      return await toolWebSearchBrave(clientId, input || {});
        case 'get_client_config':     return await toolGetClientConfig(clientId);
        case 'reprocess_message':       return await toolReprocessMessage(clientId, input || {});
        case 'query_messages':          return await toolQueryMessages(clientId, input || {});
        case 'query_rejection_history': return await toolQueryRejectionHistory(clientId, input || {});
        case 'query_logs':              return await toolQueryLogs(clientId, input || {});
        case 'query_agent_memory_raw':  return await toolQueryAgentMemoryRaw(clientId, input || {});
        case 'run_campaign':            return await toolRunCampaign(clientId, input || {});
        case 'clear_pending_messages':  return await toolClearPendingMessages(clientId, input || {});
        case 'draft_email_for_leads':   return await toolDraftEmailForLeads(clientId, input || {});
        default:                        return { error: `Unknown tool: ${toolName}` };
      }
    } catch (err) {
      console.error(`[captainBeaver] tool ${toolName} threw:`, err.message);
      return { error: err.message };
    }
  };
}

// ─── Response formatter ────────────────────────────────────────────────────
// Frontend expects { plan_id, status: 'captain_response', source, message }

function formatResponse(content, meta = {}) {
  return {
    plan_id: uuidv4(),
    status: 'captain_response',
    source: 'captain_beaver',
    message: content,
    ...meta,
  };
}

// ─── Fast-path helpers (avoid Sonnet for simple read queries) ────────────────

// Keywords that signal complex tasks requiring full Sonnet reasoning
const COMPLEX_KEYWORDS = /\b(create|find|search|run|send|start|kickoff|outreach|message|draft|plan|write|generate|source|research|campaign|approve|reject|reprocess|fix|update|edit|schedule|book|analyse|analyze|review|check all|go through|strategy|suggest|recommend)\b/i;

// Words that refer back to prior conversation — if any appear, the query needs
// history context which the fast-path Haiku handler doesn't receive, so we must
// route through the full Sonnet+history path instead.
const REFERENTIAL_WORDS = /\b(that|those|it|them|same|again|previous|last one|back to|earlier|above|before)\b/i;

// Returns true if the command is a simple status read that doesn't need Sonnet
function isSimpleReadQuery(cmd) {
  if (cmd.length > 200) return false;              // Long messages = complex
  if (COMPLEX_KEYWORDS.test(cmd)) return false;    // Action verb = needs reasoning
  if (REFERENTIAL_WORDS.test(cmd)) return false;   // Needs history context
  return /\b(pending|approvals?|pipeline|status|how many|leads?|today|kpi|numbers?|stats?|summary|what.s|show me|tell me|give me|count|replies|responses)\b/i.test(cmd);
}

// Lightweight Haiku-powered handler for simple reads
async function handleSimpleReadQuery(clientId, command) {
  try {
    const handler = buildToolHandler(clientId);

    // Decide which tool to call based on keywords
    let toolResult;
    let toolName;

    if (/\b(approvals?|pending|queue)\b/i.test(command)) {
      toolName = 'get_approvals_pending';
      toolResult = await handler('get_approvals_pending', { limit: 10 });
    } else {
      // Default: pipeline status (covers KPI, leads, sent today, etc.)
      toolName = 'get_pipeline_status';
      toolResult = await handler('get_pipeline_status', {});
    }

    const { callAgent } = require('./claude');
    const { AGENTS } = require('../config/agents');

    // Use Haiku with a minimal prompt — no persona, just format the data
    const reply = await callAgent(
      'brief_writer',
      `The user asked: "${command}"\n\nData from ${toolName}:\n${JSON.stringify(toolResult, null, 2)}\n\nAnswer concisely in 1–3 sentences. Return JSON: {"summary":"your answer"}`,
      { clientId }
    );

    const message = reply?.summary || JSON.stringify(toolResult);
    return formatResponse(message, { fast_path: true, tool: toolName });
  } catch (err) {
    console.warn('[captainBeaver:fastPath] failed, falling through to Sonnet:', err.message);
    return null; // signal caller to use full path
  }
}

// ─── Public entry point ───────────────────────────────────────────────────

async function handleChat(clientId, command, options = {}) {
  // history: array of { role: 'user'|'assistant', content: string } from the frontend.
  // Captain Beaver is otherwise stateless — without this, every chat turn starts fresh.
  // Sanitise and clamp to a sane size so a malformed payload can't blow up token budget.
  let history = [];
  if (Array.isArray(options.history)) {
    history = options.history
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .filter(m => typeof m.content === 'string' && m.content.trim().length > 0)
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  }

  // Log inbound
  await logsService.createLog(clientId, {
    agent: 'captain_beaver',
    action: 'chat_command',
    metadata: {
      command: command.substring(0, 500),
      source: 'director_chat',
      history_turns: history.length,
    },
  }).catch(() => {});

  // ── Fast-path: simple read queries bypass Sonnet + full persona ──────────
  // "what's pending?", "pipeline status", "how many leads" etc. are pure DB
  // reads — no reasoning, no orchestration needed. We call the tool directly
  // and return a formatted answer via Haiku (~10x cheaper than Sonnet).
  // Works regardless of history length because isSimpleReadQuery already
  // excludes referential queries ("that", "again", etc.) that would need it.
  if (isSimpleReadQuery(command)) {
    const fastResult = await handleSimpleReadQuery(clientId, command);
    if (fastResult) return fastResult;
    // If fast-path produced nothing, fall through to full Sonnet path
  }

  // ── Memory injection: prepend recent learnings so Captain has context ─────
  // Keeps the conversation history short while giving persistent awareness.
  const memoryContext = await injectMemoryContext(clientId);
  const commandWithMemory = memoryContext ? `${memoryContext}\n\n${command}` : command;

  // Load the same persona files Jarvis loads — makes Captain a true file-synced twin.
  // Falls back to config/agents.js director prompt if files are missing.
  const slug = await getClientSlug(clientId);
  const systemPrompt = loadPersona(slug);

  try {
    const result = await callAgentWithTools(
      'director',
      commandWithMemory,
      TOOLS,
      buildToolHandler(clientId),
      { clientId, systemPrompt, history }
    );

    // Log what happened
    const toolNames = (result.toolCalls || []).map(t => t.name).join(',');
    console.log(`[captainBeaver] client=${clientId} iterations=${result.iterations} tools=[${toolNames}] stop=${result.stop_reason}`);

    await logsService.createLog(clientId, {
      agent: 'captain_beaver',
      action: 'chat_reply',
      metadata: {
        iterations: result.iterations,
        tools_used: toolNames,
        stop_reason: result.stop_reason,
      },
    }).catch(() => {});

    // Post-session learning — fire-and-forget, never blocks the response
    postSessionLearning(clientId, {
      command: command.slice(0, 200),
      toolsUsed: (result.toolCalls || []).map(t => t.name),
      outcome: result.stop_reason === 'end_turn' ? 'ok' : result.stop_reason || 'ok',
    }).catch(() => {});

    const message = result.text && result.text.trim()
      ? result.text.trim()
      : "I processed your request but didn't have anything to say back. Check the pipeline.";

    return formatResponse(message, {
      tool_calls_count: (result.toolCalls || []).length,
      iterations: result.iterations,
    });
  } catch (err) {
    console.error('[captainBeaver] handleChat failed:', err.message);
    return formatResponse(
      `Something broke on my end: ${err.message}. Check Railway logs.`
    );
  }
}

module.exports = {
  handleChat,
  // Exported for tests / reuse
  TOOLS,
  buildToolHandler,
  loadPersona,
  getClientSlug,
  // Used by LinkedIn auto-sweep in index.js
  toolDraftEmailForLeads,
};
