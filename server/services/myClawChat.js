'use strict';

/**
 * MyClaw Chat — handles natural language commands directed at MyClaw
 * from the Director Chat interface.
 *
 * Detection: messages prefixed with "claw", "@claw", "@myclaw", "hey claw"
 * are routed here instead of going through the Captain Beaver pipeline.
 *
 * Uses a lightweight Claude call to interpret intent, then queries the
 * database directly (same queries the /api/myclaw/* routes use).
 */

const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const logsService = require('./logs');
const { researchLeads } = require('./research');

// ── Intent classification — fast keyword matching ───────────────────────────
// No Claude call needed here. Keeps it instant and saves tokens.
function classifyIntent(command) {
  const lower = command.toLowerCase();

  // Extract filters from command
  const filters = {};
  const tierMatch = lower.match(/\b(p[123])\b/i);
  if (tierMatch) filters.signal_tier = tierMatch[1].toUpperCase();
  const limitMatch = lower.match(/\b(\d+)\s*(?:leads?|results?)\b/);
  if (limitMatch) filters.limit = parseInt(limitMatch[1], 10);

  // ── RESEARCH COMMANDS (priority) ──
  // "find 20 b2b founders in KL", "search for marketing managers", etc.
  if (/\b(?:find|search|look\s*for|get\s*me|discover)\b/i.test(lower)) {
    return { intent: 'research_execute', query: command };
  }

  if (/approv|queue|review|pending\s*message/i.test(lower)) return { intent: 'check_approvals', filters };
  if (/qualif|ready\s*(?:for|to)\s*(?:outreach|contact)/i.test(lower)) return { intent: 'check_qualified', filters };
  if (/\b(?:count|how\s*many|total)\b.*lead/i.test(lower) || /lead.*\b(?:count|how\s*many|total)\b/i.test(lower)) return { intent: 'lead_count', filters };
  if (/lead|prospect|contact/i.test(lower)) return { intent: 'check_leads', filters };
  if (/memor|learn|mistake|pattern/i.test(lower)) return { intent: 'check_memory', filters };
  if (/status|health|ping|alive|connect/i.test(lower)) return { intent: 'check_status', filters };
  if (/pipeline|summary|overview|dashboard|stats|numbers/i.test(lower)) return { intent: 'pipeline_summary', filters };

  // Greetings and general chat
  if (/^(hi|hey|hello|sup|yo|what'?s?\s*up|how\s*are)/i.test(lower)) {
    return { intent: 'general', reply: "Hey! I'm Lodge Master, your pipeline assistant. I can find leads, check your approvals, pipeline stats, and agent memory. What do you need?" };
  }

  return { intent: 'general', reply: "I'm Lodge Master. Try asking me to:\n- Find 20 b2b founders in KL\n- Check my leads\n- Show approvals\n- Pipeline summary\n- Check agent memory\n- Show status" };
}

// ── Intent handlers ─────────────────────────────────────────────────────────

async function handleCheckApprovals(clientId) {
  const result = await pool.query(
    `SELECT a.id AS approval_id, a.status, a.created_at,
            m.subject, m.body, m.channel, m.ranger_score,
            l.name AS lead_name, l.company AS lead_company
     FROM approvals a
     JOIN messages m ON m.id = a.message_id
     JOIN leads l ON l.id = m.lead_id
     WHERE a.client_id = $1 AND a.status = 'pending'
     ORDER BY a.created_at ASC LIMIT 20`,
    [clientId]
  );

  if (result.rows.length === 0) {
    return formatResponse('No pending approvals right now. The queue is clear.');
  }

  const lines = result.rows.map((r, i) =>
    `${i + 1}. ${r.lead_name} (${r.lead_company}) — ${r.channel} — Ranger: ${r.ranger_score || '?'}/100`
  );

  return formatResponse(
    `You have ${result.rowCount} pending approval${result.rowCount !== 1 ? 's' : ''}:\n\n${lines.join('\n')}\n\nGo to the Approval Queue to review them.`
  );
}

async function handleCheckLeads(clientId, filters = {}) {
  const conditions = ['client_id = $1', 'deleted_at IS NULL'];
  const params = [clientId];

  if (filters.status) conditions.push(`status = $${params.push(filters.status)}`);
  if (filters.signal_tier) conditions.push(`signal_tier = $${params.push(filters.signal_tier)}`);

  const limit = Math.min(Number(filters.limit) || 10, 50);

  const result = await pool.query(
    `SELECT name, company, signal_tier, pipeline_stage, status, email, created_at
     FROM leads WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${params.push(limit)}`,
    params
  );

  if (result.rows.length === 0) {
    return formatResponse('No leads found matching that criteria.');
  }

  const lines = result.rows.map((r, i) =>
    `${i + 1}. ${r.name} — ${r.company} [${r.signal_tier || '?'}] — ${r.pipeline_stage}`
  );

  return formatResponse(
    `Found ${result.rowCount} lead${result.rowCount !== 1 ? 's' : ''}:\n\n${lines.join('\n')}`
  );
}

async function handleCheckQualified(clientId) {
  const result = await pool.query(
    `SELECT name, company, signal_tier, email, linkedin_url
     FROM leads
     WHERE client_id = $1 AND pipeline_stage = 'qualified'
       AND deleted_at IS NULL
     ORDER BY signal_tier ASC, created_at DESC LIMIT 20`,
    [clientId]
  );

  if (result.rows.length === 0) {
    return formatResponse('No qualified leads in the pool right now. Run a research campaign to find some.');
  }

  const lines = result.rows.map((r, i) =>
    `${i + 1}. ${r.name} — ${r.company} [${r.signal_tier}] — ${r.email ? 'has email' : r.linkedin_url ? 'LinkedIn only' : 'no contact'}`
  );

  return formatResponse(
    `${result.rowCount} qualified lead${result.rowCount !== 1 ? 's' : ''} ready for outreach:\n\n${lines.join('\n')}`
  );
}

async function handleCheckMemory(clientId) {
  const result = await pool.query(
    `SELECT agent, memory_type, key, content, updated_at
     FROM agent_memory
     WHERE client_id = $1 AND memory_type != 'secret'
     ORDER BY updated_at DESC LIMIT 15`,
    [clientId]
  );

  if (result.rows.length === 0) {
    return formatResponse('No agent memory entries yet. Memories build up as the crew works.');
  }

  const lines = result.rows.map(r =>
    `[${r.agent}] ${r.key} (${r.memory_type}) — updated ${new Date(r.updated_at).toLocaleDateString()}`
  );

  return formatResponse(
    `Agent memory (${result.rowCount} entries):\n\n${lines.join('\n')}`
  );
}

async function handleCheckStatus(clientId) {
  const myclaw = require('./myclaw');
  const configured = myclaw.isConfigured();

  // Quick DB health check
  const leadCount = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE client_id = $1 AND deleted_at IS NULL`, [clientId]
  );
  const pendingApprovals = await pool.query(
    `SELECT COUNT(*) FROM approvals WHERE client_id = $1 AND status = 'pending'`, [clientId]
  );

  return formatResponse(
    `Lodge Master Status:\n• Connection: ${configured ? 'Connected' : 'Not configured (using Claude fallback)'}\n• Leads in DB: ${leadCount.rows[0].count}\n• Pending approvals: ${pendingApprovals.rows[0].count}\n• System: Operational`
  );
}

async function handleLeadCount(clientId) {
  const result = await pool.query(
    `SELECT pipeline_stage, COUNT(*) AS count
     FROM leads WHERE client_id = $1 AND deleted_at IS NULL
     GROUP BY pipeline_stage ORDER BY count DESC`,
    [clientId]
  );

  if (result.rows.length === 0) {
    return formatResponse('No leads in the pipeline yet.');
  }

  const total = result.rows.reduce((sum, r) => sum + parseInt(r.count), 0);
  const lines = result.rows.map(r => `• ${r.pipeline_stage}: ${r.count}`);

  return formatResponse(
    `Lead pipeline (${total} total):\n\n${lines.join('\n')}`
  );
}

async function handlePipelineSummary(clientId) {
  const [leads, messages, approvals, sent] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM leads WHERE client_id = $1 AND deleted_at IS NULL`, [clientId]),
    pool.query(`SELECT COUNT(*) FROM messages WHERE client_id = $1`, [clientId]),
    pool.query(`SELECT COUNT(*) FROM approvals WHERE client_id = $1 AND status = 'pending'`, [clientId]),
    pool.query(`SELECT COUNT(*) FROM messages WHERE client_id = $1 AND status = 'sent'`, [clientId]),
  ]);

  return formatResponse(
    `Pipeline overview:\n• Total leads: ${leads.rows[0].count}\n• Messages drafted: ${messages.rows[0].count}\n• Messages sent: ${sent.rows[0].count}\n• Pending approvals: ${approvals.rows[0].count}`
  );
}

// ── Build ICP from command keywords ─────────────────────────────────────────
// Extracts industry, title, location from the user's command and merges with
// stored ICP — command keywords take priority
function buildIcpFromCommand(command, baseIcp = {}) {
  const lower = command.toLowerCase();

  const industryMap = {
    // 'b2b' intentionally omitted — it's a business model, not a LinkedIn industry
    // Falls through to DEFAULT_INDUSTRIES (consulting, agency, SaaS, etc.)
    'saas': 'SaaS',
    'marketing': 'marketing',
    'agency': 'agency',
    'digital': 'digital agency',
    'property': 'property',
    'proptech': 'proptech',
    'fintech': 'fintech',
    'ecommerce': 'ecommerce',
    'e-commerce': 'ecommerce',
    'edtech': 'edtech',
    'healthtech': 'healthtech',
    'logistics': 'logistics',
    'consulting': 'consulting',
    'recruitment': 'recruitment',
    'tech': 'tech',
    'software': 'software',
    'design': 'design',
    'creative': 'creative',
    'media': 'media',
    'advertising': 'advertising',
    'seo': 'SEO',
    'hr': 'HR',
    'legal': 'legal',
    'accounting': 'accounting',
    'insurance': 'insurance',
    'f&b': 'F&B',
    'food': 'food',
  };

  const titleMap = {
    'founder': 'Founder',
    'co-founder': 'Co-Founder',
    'ceo': 'CEO',
    'coo': 'COO',
    'cmo': 'CMO',
    'cto': 'CTO',
    'director': 'Director',
    'md': 'Managing Director',
    'managing director': 'Managing Director',
    'owner': 'Owner',
    'partner': 'Partner',
  };

  const locationMap = {
    'kl': 'Kuala Lumpur',
    'kuala lumpur': 'Kuala Lumpur',
    'pj': 'Petaling Jaya',
    'petaling jaya': 'Petaling Jaya',
    'klang valley': 'Klang Valley',
    'malaysia': 'Malaysia',
    'penang': 'Penang',
    'johor': 'Johor',
    'singapore': 'Singapore',
  };

  const extractedIndustries = [];
  for (const [kw, label] of Object.entries(industryMap)) {
    if (lower.includes(kw)) extractedIndustries.push(label);
  }

  const extractedTitles = [];
  for (const [kw, label] of Object.entries(titleMap)) {
    if (lower.includes(kw)) extractedTitles.push(label);
  }

  let extractedLocation = '';
  for (const [kw, label] of Object.entries(locationMap)) {
    if (lower.includes(kw)) { extractedLocation = label; break; }
  }

  // If command mentions specific titles, expand with DEFAULT_TITLES variants
  // so we search all seniority levels, not just the one mentioned
  const DEFAULT_TITLES = ['CEO', 'Founder', 'Co-Founder', 'Managing Director', 'Owner', 'Director', 'MD'];
  const mergedTitles = extractedTitles.length > 0
    ? [...new Set([...extractedTitles, ...DEFAULT_TITLES])]
    : [];

  return {
    ...baseIcp,
    ...(extractedIndustries.length > 0 ? { industries: extractedIndustries } : {}),
    ...(mergedTitles.length > 0 ? { job_titles: mergedTitles } : {}),
    ...(extractedLocation ? { geographies: extractedLocation } : {}),
  };
}

// ── Research execution (MyClaw as researcher) ────────────────────────────────
async function handleResearchExecute(clientId, query) {
  try {
    // Load ICP from agent_memory
    const icpRow = await pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
      [clientId]
    );
    const icpMemory = icpRow.rows[0]?.content || {};

    // Augment ICP with keywords parsed from the command
    const commandIcp = buildIcpFromCommand(query, icpMemory);

    // Reset used_queries so manual command always searches with a fresh pool
    await pool.query(
      `DELETE FROM agent_memory WHERE client_id = $1 AND agent = 'research_beaver' AND key = 'used_queries'`,
      [clientId]
    );

    const targetCount = extractLimit(query) || 5;
    const MAX_OUTER_LOOPS = 6; // hard cap — prevents runaway spend
    const accumulated = [];
    const seenUrls = new Set();
    let batchIndex = 0;
    let loopCount = 0;

    console.log(`[myclaw] Research target: ${targetCount} leads for "${query}"`);

    // Loop until we hit targetCount or exhaust sources
    while (accumulated.length < targetCount && loopCount < MAX_OUTER_LOOPS) {
      loopCount++;
      const remaining = targetCount - accumulated.length;
      console.log(`[myclaw] Research loop ${loopCount}: need ${remaining} more leads`);

      const result = await researchLeads(clientId, {
        icpMemory: commandIcp,
        targetCount: remaining,
        batchIndex,
        commandOverride: query,
      });

      const leads = result?.leads || [];
      const fresh = leads.filter(l => {
        const key = l.linkedin_url || `${l.name}||${l.company}`.toLowerCase();
        if (seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      });

      accumulated.push(...fresh);
      console.log(`[myclaw] Loop ${loopCount}: got ${fresh.length} fresh leads, total=${accumulated.length}/${targetCount}`);

      // If no new leads came in, sources are exhausted — stop
      if (fresh.length === 0) {
        console.log('[myclaw] No new leads from loop — sources exhausted');
        break;
      }

      batchIndex++;
    }

    if (accumulated.length === 0) {
      return formatResponse(
        `No leads found for "${query}". Try being more specific about industry, location, or role.`
      );
    }

    const final = accumulated.slice(0, targetCount);
    const lines = final.map((lead, i) => {
      const company = lead.company || 'Unknown';
      const title = lead.title || 'N/A';
      return `${i + 1}. ${lead.name} — ${title} @ ${company}`;
    });

    const shortfall = targetCount - final.length;
    const note = shortfall > 0
      ? `\n\nNote: Only ${final.length}/${targetCount} found — Serper sources exhausted. Try a broader search term.`
      : '\n\nLeads saved to pipeline. Ready for outreach.';

    return formatResponse(
      `Found ${final.length} lead${final.length !== 1 ? 's' : ''} for "${query}":\n\n${lines.join('\n')}${note}`
    );
  } catch (err) {
    console.error('[myclaw] Research failed:', err.message);
    return formatResponse(
      `Research failed: ${err.message}. Check your ICP configuration and try again.`
    );
  }
}

// Helper: extract requested lead count from query
function extractLimit(query) {
  const match = query.match(/\b(\d+)\b/);
  return match ? parseInt(match[1], 10) : null;
}

// ── Response formatter ──────────────────────────────────────────────────────
// Returns in a shape the frontend can render as a chat message from MyClaw
function formatResponse(content) {
  return {
    plan_id: uuidv4(),
    status: 'myclaw_response',
    source: 'myclaw',
    message: content,
  };
}

// ── Main handler ────────────────────────────────────────────────────────────
async function handleChat(clientId, command) {
  // Log the MyClaw interaction
  await logsService.createLog(clientId, {
    agent: 'myclaw',
    action: 'chat_command',
    metadata: { command, source: 'director_chat' },
  }).catch(() => {});

  const intent = classifyIntent(command);

  switch (intent.intent) {
    case 'research_execute':
      return handleResearchExecute(clientId, intent.query);
    case 'check_approvals':
      return handleCheckApprovals(clientId);
    case 'check_leads':
      return handleCheckLeads(clientId, intent.filters || {});
    case 'check_qualified':
      return handleCheckQualified(clientId);
    case 'check_memory':
      return handleCheckMemory(clientId);
    case 'check_status':
      return handleCheckStatus(clientId);
    case 'lead_count':
      return handleLeadCount(clientId);
    case 'pipeline_summary':
      return handlePipelineSummary(clientId);
    case 'general':
    default:
      return formatResponse(
        intent.reply || "Hey! I'm Lodge Master. I can find leads, check your approvals, pipeline status, and agent memory. What do you need?"
      );
  }
}

module.exports = { handleChat, isMyClawMessage: (cmd) => /^(?:@?(?:my)?claw|hey\s+claw|@?lodge(?:\s*master)?)[,:\s]*/i.test(cmd.trim()) };
