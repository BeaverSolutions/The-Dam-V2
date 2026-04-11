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
 *   - web_search_brave        external web search (Brave → Serper → CSE fallback)
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
  getMemory,
  directorGetICP,
  getClientPersona,
} = require('./agents');

// ─── Persona loader ────────────────────────────────────────────────────────
// Loads the same files Jarvis loads: IDENTITY, SOUL, USER, AGENTS, MEMORY, TOOLS.
// Wraps them in a short environment-adapter preamble + suffix so Sonnet knows
// this is the in-Dam twin (direct in-process tools, not HTTP to BeavrDam API).
// Cached in-memory per client slug; invalidates on process restart.

const personaCache = new Map();
const PERSONA_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'MEMORY.md', 'TOOLS.md'];

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

TOOLS (Anthropic tool_use — call directly, no HTTP):
- search_internal_leads    check the DB for existing leads BEFORE any new research
- get_pipeline_status      live KPIs: sent today, pending approval, leads today, rejected today
- get_approvals_pending    list messages awaiting approval with Enforcer notes
- create_lead              INSERT a lead AND auto-run the full Sales→Enforcer→approval pipeline on it
- check_lead_status        trace a specific lead's journey through the pipeline
- read_memory              read agent_memory entries (ICP, learnings, rejection patterns)
- write_memory             write a durable learning back to agent_memory
- web_search_brave         open-web search (Brave → Serper → CSE fallback) — ONLY after search_internal_leads returns empty
- get_client_config        read the client's ICP and persona

Always use your tools. Do not claim facts about the pipeline without calling the relevant tool first.

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
    description: 'Search the open web via Brave (with Serper + Google CSE fallback). Use this ONLY after search_internal_leads has returned no matches. For finding news, hiring signals, funding announcements, LinkedIn profiles.',
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
];

// ─── Tool handler implementations ──────────────────────────────────────────

async function toolSearchInternalLeads(clientId, { industry, location, signal_tier, limit }) {
  const conditions = ['client_id = $1', 'deleted_at IS NULL'];
  const params = [clientId];

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
            metadata->>'signal' AS signal, created_at
     FROM leads WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.push(cap)}`,
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
    target: kpiRow.rows[0]?.target || 80,
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
    name, company, title, email, linkedin_url,
    signal, why_now, angle, friction,
    signal_tier = 'P1', confidence,
  } = input;

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
        default:                      return { error: `Unknown tool: ${toolName}` };
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
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
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

  // Load the same persona files Jarvis loads — makes Captain a true file-synced twin.
  // Falls back to config/agents.js director prompt if files are missing.
  const slug = await getClientSlug(clientId);
  const systemPrompt = loadPersona(slug);

  try {
    const result = await callAgentWithTools(
      'director',
      command,
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
};
