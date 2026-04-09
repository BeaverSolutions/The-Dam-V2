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

// ── Research execution (MyClaw as researcher) ────────────────────────────────
async function handleResearchExecute(clientId, query) {
  try {
    // Load ICP from agent_memory (same place researchLeads uses)
    const icpRow = await pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
      [clientId]
    );
    const icpMemory = icpRow.rows[0]?.content || {};

    const targetCount = extractLimit(query) || 5;

    // Execute research — same pipeline as Director but triggered directly
    const result = await researchLeads(clientId, {
      icpMemory,
      targetCount,
      commandOverride: query,
    });

    const leads = result?.leads || [];

    if (leads.length === 0) {
      return formatResponse(
        `No leads found for "${query}". Try being more specific about industry, location, or role.`
      );
    }

    const lines = leads.slice(0, 20).map((lead, i) => {
      const company = lead.company || 'Unknown';
      const title = lead.title || 'N/A';
      return `${i + 1}. ${lead.name} — ${title} @ ${company}`;
    });

    return formatResponse(
      `Found ${leads.length} lead${leads.length !== 1 ? 's' : ''} for "${query}":\n\n${lines.join('\n')}\n\nLeads saved to pipeline. Ready for outreach.`
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
