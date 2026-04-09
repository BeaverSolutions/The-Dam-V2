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
const serperService = require('./serper');
const agentsService = require('./agents');

let callAgent;
try { callAgent = require('./claude').callAgent; } catch { callAgent = null; }

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

  // ── Follow-up: LinkedIn URLs of recent leads ──
  if (/linkedin/i.test(lower) && /provid|show|give|get|their|url|link/i.test(lower)) {
    return { intent: 'show_linkedin', filters };
  }

  // ── Outreach / Sales trigger ──
  if (/\b(?:outreach|draft|message|email|send|contact|reach out|write to|do outreach)\b/i.test(lower)) {
    return { intent: 'do_outreach', filters };
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

async function handleShowLinkedin(clientId, filters = {}) {
  const limit = Math.min(Number(filters.limit) || 20, 50);
  const result = await pool.query(
    `SELECT name, title, company, linkedin_url
     FROM leads
     WHERE client_id = $1 AND deleted_at IS NULL AND linkedin_url IS NOT NULL AND linkedin_url != ''
     ORDER BY created_at DESC LIMIT $2`,
    [clientId, limit]
  );

  if (result.rows.length === 0) {
    return formatResponse('No leads with LinkedIn URLs found. Run a search first.');
  }

  const lines = result.rows.map((r, i) =>
    `${i + 1}. ${r.name} — ${r.title || 'N/A'} @ ${r.company || '—'}\n   ${r.linkedin_url}`
  );

  return formatResponse(
    `LinkedIn URLs for your ${result.rowCount} most recent lead${result.rowCount !== 1 ? 's' : ''}:\n\n${lines.join('\n\n')}`
  );
}

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

// ── Outreach handler — triggers Sales Beaver for recent leads ────────────────
async function handleDoOutreach(clientId, command) {
  // Get recent uncontacted leads
  const limitMatch = command.match(/\b(\d+)\b/);
  const limit = limitMatch ? parseInt(limitMatch[1], 10) : 15;

  const { rows: leads } = await pool.query(
    `SELECT id, name, company, title, email, linkedin_url,
            metadata->>'signal' AS signal, metadata->>'angle' AS angle, metadata->>'friction' AS friction
     FROM leads
     WHERE client_id = $1
       AND deleted_at IS NULL
       AND pipeline_stage IN ('researched', 'qualified', 'prospecting', 'outreach_ready')
       AND status = 'new'
       AND id NOT IN (
         SELECT DISTINCT lead_id FROM messages
         WHERE client_id = $1 AND status NOT IN ('ranger_rejected')
       )
     ORDER BY created_at DESC
     LIMIT $2`,
    [clientId, limit]
  );

  if (leads.length === 0) {
    return formatResponse(
      'No new leads ready for outreach. Run a search first to find leads, then try again.'
    );
  }

  let drafted = 0;
  let approved = 0;
  let failed = 0;

  for (const lead of leads) {
    try {
      const channel = lead.email ? 'email' : 'linkedin';

      // Build lead context for Sales Beaver
      const leadContext = `Name: ${lead.name}, Company: ${lead.company || 'Unknown'}, Title: ${lead.title || 'Unknown'}${lead.signal ? `, Signal: ${lead.signal}` : ''}${lead.angle ? `, Angle: ${lead.angle}` : ''}${lead.friction ? `, Friction: ${lead.friction}` : ''}`;

      // 1. Sales Beaver drafts the message
      const salesResult = await agentsService.salesGenerate(clientId, {
        lead_id: lead.id,
        channel,
        context: leadContext,
      });

      if (!salesResult?.body) {
        console.warn(`[myclaw] Sales draft failed for ${lead.name}: no body`);
        failed++;
        continue;
      }

      // 2. Save draft to messages table (mirrors Director pipeline)
      const msgRes = await pool.query(
        `INSERT INTO messages (client_id, lead_id, channel, subject, body, status)
         VALUES ($1, $2, $3, $4, $5, 'pending_ranger')
         RETURNING *`,
        [clientId, lead.id, channel, salesResult.subject || null, salesResult.body]
      );
      const message = msgRes.rows[0];
      drafted++;

      await logsService.createLog(clientId, {
        agent: 'sales_beaver',
        action: 'message_created',
        target_type: 'message',
        target_id: message.id,
        metadata: { lead_id: lead.id, lead_name: lead.name, channel, source: 'myclaw_outreach' },
      });

      // 3. Enforcer reviews the message
      const rangerResult = await agentsService.rangerReview(clientId, {
        message_id: message.id,
        message_body: salesResult.body,
        lead_context: { name: lead.name, company: lead.company, title: lead.title, signal: lead.signal, angle: lead.angle, friction: lead.friction },
      });

      if (rangerResult?.decision === 'approve' || rangerResult?.decision === 'approve_with_edits') {
        // Update message with Enforcer results and move to pending_approval
        const finalBody = rangerResult.decision === 'approve_with_edits' && rangerResult.suggested_edit
          ? rangerResult.suggested_edit
          : salesResult.body;

        await pool.query(
          `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
           ranger_breakdown = $5, status = 'pending_approval', updated_at = NOW()
           WHERE id = $6 AND client_id = $7`,
          [finalBody, salesResult.subject || null, rangerResult?.score || 80, rangerResult?.feedback || 'Enforcer approved',
           JSON.stringify(rangerResult?.breakdown || null), message.id, clientId]
        );

        // Create approval queue entry
        await pool.query(
          `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system')`,
          [clientId, message.id]
        );

        await logsService.createLog(clientId, {
          agent: 'enforcer_beaver',
          action: 'message_approved',
          target_type: 'message',
          target_id: message.id,
          metadata: { channel, score: rangerResult?.score, source: 'myclaw_outreach' },
        });

        approved++;
      } else {
        // Ranger rejected — mark message and log
        await pool.query(
          `UPDATE messages SET ranger_score = $1, ranger_notes = $2, status = 'ranger_rejected', updated_at = NOW()
           WHERE id = $3 AND client_id = $4`,
          [rangerResult?.score || 0, rangerResult?.reject_reason || rangerResult?.feedback || 'Rejected', message.id, clientId]
        );

        await logsService.createLog(clientId, {
          agent: 'enforcer_beaver',
          action: 'message_rejected',
          target_type: 'message',
          target_id: message.id,
          metadata: { channel, score: rangerResult?.score, reason: rangerResult?.reject_reason, source: 'myclaw_outreach' },
        });
      }
    } catch (err) {
      console.warn(`[myclaw] Outreach failed for ${lead.name}:`, err.message);
      failed++;
    }
  }

  const parts = [`Outreach complete: ${drafted} drafted, ${approved} approved by Enforcer.`];
  if (failed > 0) parts.push(`${failed} failed.`);
  if (approved > 0) parts.push(`\n${approved} message${approved !== 1 ? 's are' : ' is'} in your **Approval Queue** — review and send when ready.`);
  if (drafted > 0 && approved === 0) parts.push('\nAll messages were rejected by Enforcer. Check the rejection notes in Messages.');

  return formatResponse(parts.join(' '));
}

// ── Claude fallback — handles anything Lodge Master can't classify ─────────────
// Uses Claude to understand intent and generate a helpful response
async function handleWithClaude(clientId, command) {
  if (!callAgent) {
    return formatResponse("I'm Lodge Master. I can find leads, check approvals, show pipeline stats, and start outreach. What do you need?");
  }

  try {
    // Get quick pipeline context to ground Claude's response
    const [leadsRow, approvalsRow] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM leads WHERE client_id = $1 AND deleted_at IS NULL`, [clientId]),
      pool.query(`SELECT COUNT(*) FROM approvals WHERE client_id = $1 AND status = 'pending'`, [clientId]),
    ]);

    const context = `Leads in pipeline: ${leadsRow.rows[0].count}. Pending approvals: ${approvalsRow.rows[0].count}.`;

    const prompt = `You are Lodge Master, a pipeline assistant for a B2B sales automation tool.

Pipeline context: ${context}

User said: "${command}"

Respond helpfully in 1-3 sentences. If the user wants to find leads, tell them to say "Find N [role] in [location]". If they want outreach, tell them to say "do outreach to [N] leads". Be concise and direct. Do not use bullet points.

Return JSON: {"message": "your response here"}`;

    const result = await callAgent('research_beaver', prompt, { clientId });
    const message = result?.message || result?.raw || "I can find leads, start outreach, check approvals, or show pipeline stats. What do you need?";
    return formatResponse(message);
  } catch {
    return formatResponse("I can find leads, start outreach, check approvals, or show pipeline stats. What do you need?");
  }
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
// MyClaw skips Haiku verification — user is doing manual research and will judge quality.
// We call Serper directly with diverse queries built from the command.
async function handleResearchExecute(clientId, query) {
  try {
    const targetCount = extractLimit(query) || 5;
    const serperQueries = buildSerperQueries(query, targetCount);
    const accumulated = [];
    const seenUrls = new Set();

    console.log(`[myclaw] Research target: ${targetCount} leads. Queries: ${serperQueries.length}`);

    for (const sq of serperQueries) {
      if (accumulated.length >= targetCount) break;

      const remaining = targetCount - accumulated.length;
      const results = await serperService.searchLinkedInProfiles(sq, Math.min(remaining + 3, 10));

      const fresh = results.filter(l => {
        if (!l.linkedin_url) return false;
        const key = l.linkedin_url;
        if (seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      });

      accumulated.push(...fresh);
      console.log(`[myclaw] Query "${sq}": ${fresh.length} fresh, total=${accumulated.length}/${targetCount}`);
    }

    // Save leads to DB
    const final = accumulated.slice(0, targetCount);
    if (final.length > 0) {
      await saveLeadsToDB(clientId, final);
    }

    if (final.length === 0) {
      return formatResponse(
        `No leads found for "${query}". Try being more specific — e.g. "Find 10 marketing agency founders KL".`
      );
    }

    const lines = final.map((lead, i) => {
      const company = lead.company && lead.company !== 'Unknown' ? lead.company : '—';
      const title = lead.title || 'N/A';
      return `${i + 1}. ${lead.name} — ${title} @ ${company}`;
    });

    const shortfall = targetCount - final.length;
    const note = shortfall > 0
      ? `\n\nNote: Only ${final.length}/${targetCount} found. Try a different industry or location.`
      : '\n\nLeads saved to pipeline. Ready for outreach.';

    return formatResponse(
      `Found ${final.length} lead${final.length !== 1 ? 's' : ''} for "${query}":\n\n${lines.join('\n')}${note}`
    );
  } catch (err) {
    console.error('[myclaw] Research failed:', err.message);
    return formatResponse(`Research failed: ${err.message}`);
  }
}

// Save raw Serper leads to DB (no Haiku verification — MyClaw manual mode)
async function saveLeadsToDB(clientId, leads) {
  const { v4: uuidv4Lead } = require('uuid');
  for (const lead of leads) {
    try {
      await pool.query(
        `INSERT INTO leads (id, client_id, name, title, company, linkedin_url, email, pipeline_stage, status, data_source, signal_tier, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'researched', 'new', $8, 'P3', NOW(), NOW())
         ON CONFLICT (client_id, linkedin_url) DO NOTHING`,
        [uuidv4Lead(), clientId, lead.name, lead.title || '', lead.company || '', lead.linkedin_url || '', lead.email || '', lead.data_source || 'serper']
      );
    } catch (err) {
      console.warn('[myclaw] saveLeadsToDB skip:', err.message);
    }
  }
}

// Build diverse Serper queries from the user's command
function buildSerperQueries(command, targetCount) {
  const lower = command.toLowerCase();

  // Extract role
  const ROLES = ['Founder', 'CEO', 'Co-Founder', 'Managing Director', 'Owner', 'Director', 'MD', 'CTO', 'Partner'];
  const roles = ROLES.filter(r => lower.includes(r.toLowerCase()));
  const activeRoles = roles.length > 0 ? roles : ['Founder', 'CEO', 'Director'];

  // Extract industry
  const INDUSTRY_TERMS = [
    'marketing', 'digital marketing', 'advertising', 'agency', 'consulting',
    'SaaS', 'technology', 'software', 'fintech', 'e-commerce', 'logistics',
    'recruitment', 'HR', 'creative', 'media', 'design', 'property', 'training',
  ];
  const industries = INDUSTRY_TERMS.filter(i => lower.includes(i.toLowerCase()));
  const activeIndustries = industries.length > 0 ? industries : INDUSTRY_TERMS.slice(0, 6);

  // Build queries — title × industry combinations with Sdn Bhd anchor
  const queries = [];
  for (const role of activeRoles.slice(0, 4)) {
    for (const industry of activeIndustries.slice(0, 6)) {
      queries.push(`${role} ${industry} "Sdn Bhd"`);
      if (queries.length >= targetCount * 3) break;
    }
    if (queries.length >= targetCount * 3) break;
  }

  // Shuffle for variety
  return queries.sort(() => Math.random() - 0.5).slice(0, Math.ceil(targetCount * 1.5));
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
    case 'show_linkedin':
      return handleShowLinkedin(clientId, intent.filters || {});
    case 'do_outreach':
      return handleDoOutreach(clientId, command);
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
      // If Lodge Master can't classify, use Claude as the brain
      if (intent.reply) return formatResponse(intent.reply);
      return handleWithClaude(clientId, command);
  }
}

module.exports = { handleChat, isMyClawMessage: (cmd) => /^(?:@?(?:my)?claw|hey\s+claw|@?lodge(?:\s*master)?)[,:\s]*/i.test(cmd.trim()) };
