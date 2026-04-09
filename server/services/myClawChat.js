'use strict';

/**
 * Captain Beaver Chat — the unified brain behind Director Chat.
 *
 * Captain Beaver is the director of operations. All commands in Director Chat
 * route through here. Captain handles: research triggers, outreach, approvals,
 * pipeline queries, memory, and general conversation.
 *
 * External API for OpenClaw integration remains at /api/myclaw/* (backward compat)
 * and /api/captain/* (canonical).
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
    return { intent: 'general', reply: "Hey! I'm Captain Beaver, your pipeline assistant. I can find leads, check your approvals, pipeline stats, and agent memory. What do you need?" };
  }

  return { intent: 'general', reply: "I'm Captain Beaver. Try asking me to:\n- Find 20 b2b founders in KL\n- Check my leads\n- Show approvals\n- Pipeline summary\n- Check agent memory\n- Show status" };
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
    `Captain Beaver Status:\n• Connection: ${configured ? 'Connected' : 'Not configured (using Claude fallback)'}\n• Leads in DB: ${leadCount.rows[0].count}\n• Pending approvals: ${pendingApprovals.rows[0].count}\n• System: Operational`
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
  const rejectionReasons = [];

  for (const lead of leads) {
    try {
      const channel = lead.email ? 'email' : 'linkedin';
      const leadContext = `Name: ${lead.name}, Company: ${lead.company || 'Unknown'}, Title: ${lead.title || 'Unknown'}${lead.signal ? `, Signal: ${lead.signal}` : ''}${lead.angle ? `, Angle: ${lead.angle}` : ''}${lead.friction ? `, Friction: ${lead.friction}` : ''}`;
      const leadCtx = { name: lead.name, company: lead.company, title: lead.title, signal: lead.signal, angle: lead.angle, friction: lead.friction };

      // ── Attempt 1: Sales Beaver drafts ──
      let salesResult = await agentsService.salesGenerate(clientId, { lead_id: lead.id, channel, context: leadContext });

      if (!salesResult?.body) {
        console.warn(`[captain] Sales draft failed for ${lead.name}: no body`);
        failed++;
        continue;
      }

      // Save draft to messages table
      const msgRes = await pool.query(
        `INSERT INTO messages (client_id, lead_id, channel, subject, body, status)
         VALUES ($1, $2, $3, $4, $5, 'pending_ranger') RETURNING *`,
        [clientId, lead.id, channel, salesResult.subject || null, salesResult.body]
      );
      const message = msgRes.rows[0];
      drafted++;

      await logsService.createLog(clientId, {
        agent: 'sales_beaver', action: 'message_created', target_type: 'message', target_id: message.id,
        metadata: { lead_id: lead.id, lead_name: lead.name, channel, source: 'captain_outreach' },
      });

      // ── Review loop: Sales gets 2 attempts, then Enforcer writes from scratch ──
      const MAX_ATTEMPTS = 2;
      let currentBody = salesResult.body;
      let currentSubject = salesResult.subject || null;
      let messageApproved = false;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        // Enforcer reviews
        const rangerResult = await agentsService.rangerReview(clientId, {
          message_id: message.id, message_body: currentBody, lead_context: leadCtx,
        });

        if (rangerResult?.decision === 'approve' || rangerResult?.decision === 'approve_with_edits') {
          const finalBody = rangerResult.decision === 'approve_with_edits' && rangerResult.suggested_edit
            ? rangerResult.suggested_edit : currentBody;

          // Code-level gates
          const codeGate = agentsService.codeEnforcerGates(finalBody, 0);
          if (!codeGate.passed) {
            console.warn(`[captain] Code gate OVERRIDE attempt ${attempt} for ${lead.name}: ${codeGate.reason}`);
            // Treat as rejection — continue to next attempt or Enforcer draft
            if (attempt < MAX_ATTEMPTS) continue;
            break;
          }

          // Approved — save and queue
          await pool.query(
            `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
             ranger_breakdown = $5, status = 'pending_approval', updated_at = NOW()
             WHERE id = $6 AND client_id = $7`,
            [finalBody, currentSubject, rangerResult?.score || 80, rangerResult?.feedback || 'Enforcer approved',
             JSON.stringify(rangerResult?.breakdown || null), message.id, clientId]
          );
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system')`,
            [clientId, message.id]
          );
          await logsService.createLog(clientId, {
            agent: 'enforcer_beaver', action: 'message_approved', target_type: 'message', target_id: message.id,
            metadata: { channel, score: rangerResult?.score, attempt, source: 'captain_outreach' },
          });
          approved++;
          messageApproved = true;
          break;

        } else if (attempt < MAX_ATTEMPTS) {
          // Rejected — Sales Beaver rewrites with Enforcer feedback
          console.log(`[captain] Attempt ${attempt} rejected for ${lead.name}, Sales rewriting...`);
          const rewriteContext = `${leadContext}\n\nPREVIOUS DRAFT (REJECTED):\n${currentBody}\n\nENFORCER FEEDBACK:\n${rangerResult?.reject_reason || rangerResult?.feedback || 'Did not meet quality standards'}\n\nRewrite the message addressing this feedback. Do NOT repeat the same approach.`;

          const rewrite = await agentsService.salesGenerate(clientId, { lead_id: lead.id, channel, context: rewriteContext });
          if (rewrite?.body) {
            currentBody = rewrite.body;
            currentSubject = rewrite.subject || currentSubject;
            await pool.query(
              `UPDATE messages SET body = $1, subject = $2, revision_count = COALESCE(revision_count, 0) + 1, updated_at = NOW()
               WHERE id = $3 AND client_id = $4`,
              [currentBody, currentSubject, message.id, clientId]
            );
          }
        }
      }

      // ── Last resort: Enforcer writes from scratch ──
      if (!messageApproved) {
        console.log(`[captain] Sales failed ${MAX_ATTEMPTS} attempts for ${lead.name} — Enforcer drafting from scratch`);
        const enforcerDraft = await agentsService.rangerDraft(clientId, {
          lead_name: lead.name, lead_company: lead.company || 'Unknown', lead_title: lead.title || '',
          lead_angle: lead.angle || '', lead_friction: lead.friction || '', rejected_body: currentBody,
        });

        if (enforcerDraft?.body) {
          const finalBody = enforcerDraft.body;

          // Code-level gates on Enforcer draft too
          const codeGate = agentsService.codeEnforcerGates(finalBody, 0);
          if (codeGate.passed) {
            await pool.query(
              `UPDATE messages SET body = $1, subject = $2, ranger_score = 80, ranger_notes = 'Enforcer self-drafted (Sales failed QA)',
               status = 'pending_approval', updated_at = NOW()
               WHERE id = $3 AND client_id = $4`,
              [finalBody, enforcerDraft.subject || currentSubject, message.id, clientId]
            );
            await pool.query(
              `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system')`,
              [clientId, message.id]
            );
            await logsService.createLog(clientId, {
              agent: 'enforcer_beaver', action: 'message_approved', target_type: 'message', target_id: message.id,
              metadata: { channel, method: 'enforcer_draft', source: 'captain_outreach' },
            });
            approved++;
          } else {
            // Even Enforcer's draft failed code gates — flag for manual
            const reason = `Code gate: ${codeGate.reason}`;
            rejectionReasons.push(`${lead.name}: ${reason}`);
            await pool.query(
              `UPDATE messages SET ranger_score = 0, ranger_notes = $1, status = 'ranger_rejected', updated_at = NOW()
               WHERE id = $2 AND client_id = $3`,
              [`Enforcer draft also failed code gate: ${codeGate.reason}`, message.id, clientId]
            );
          }
        } else {
          // Enforcer draft returned nothing — mark for manual
          rejectionReasons.push(`${lead.name}: All attempts failed — needs manual message`);
          await pool.query(
            `UPDATE messages SET ranger_score = 0, ranger_notes = 'All attempts failed — needs manual message',
             status = 'ranger_rejected', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
            [message.id, clientId]
          );
        }
      }
    } catch (err) {
      console.warn(`[captain] Outreach failed for ${lead.name}:`, err.message);
      failed++;
    }
  }

  const parts = [`Outreach complete: ${drafted} drafted, ${approved} approved by Enforcer.`];
  if (failed > 0) parts.push(`${failed} failed.`);
  if (approved > 0) parts.push(`\n${approved} message${approved !== 1 ? 's are' : ' is'} in your **Approval Queue** — review and send when ready.`);
  if (drafted > 0 && approved === 0) {
    parts.push('\nAll messages were rejected by Enforcer.');
    if (rejectionReasons.length > 0) {
      parts.push('\n\nTop rejection reasons:');
      rejectionReasons.slice(0, 5).forEach(r => parts.push(`\n- ${r}`));
    }
  } else if (rejectionReasons.length > 0 && approved < drafted) {
    parts.push(`\n\n${drafted - approved} rejected:`);
    rejectionReasons.slice(0, 3).forEach(r => parts.push(`\n- ${r}`));
  }

  return formatResponse(parts.join(' '));
}

// ── Claude fallback — handles anything Captain Beaver can't classify ─────────────
// Uses Claude to understand intent and generate a helpful response
async function handleWithClaude(clientId, command) {
  if (!callAgent) {
    return formatResponse("I'm Captain Beaver. I can find leads, check approvals, show pipeline stats, and start outreach. What do you need?");
  }

  try {
    // Get quick pipeline context to ground Claude's response
    const [leadsRow, approvalsRow] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM leads WHERE client_id = $1 AND deleted_at IS NULL`, [clientId]),
      pool.query(`SELECT COUNT(*) FROM approvals WHERE client_id = $1 AND status = 'pending'`, [clientId]),
    ]);

    const context = `Leads in pipeline: ${leadsRow.rows[0].count}. Pending approvals: ${approvalsRow.rows[0].count}.`;

    const prompt = `You are Captain Beaver, a pipeline assistant for a B2B sales automation tool.

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

    console.log(`[captain] Research target: ${targetCount} leads. Queries: ${serperQueries.length}`);

    for (const sq of serperQueries) {
      if (accumulated.length >= targetCount) break;

      const remaining = targetCount - accumulated.length;
      let results = [];
      try {
        results = await serperService.searchLinkedInProfiles(sq, Math.min(remaining + 3, 10));
      } catch (searchErr) {
        console.error(`[captain] Serper search failed for "${sq}":`, searchErr.message);
        continue;
      }

      const fresh = results.filter(l => {
        if (!l.linkedin_url) return false;
        const key = l.linkedin_url;
        if (seenUrls.has(key)) return false;
        seenUrls.add(key);
        return true;
      });

      accumulated.push(...fresh);
      console.log(`[captain] Query "${sq}": ${fresh.length} fresh, total=${accumulated.length}/${targetCount}`);
    }

    // Save leads to DB
    const final = accumulated.slice(0, targetCount);
    if (final.length === 0) {
      return formatResponse(
        `No leads found for "${query}". Try being more specific — e.g. "Find 10 marketing agency founders KL".`
      );
    }

    const { saved, skipped } = await saveLeadsToDB(clientId, final);

    const lines = final.filter(lead => {
      // Only show leads that pass validation (have name + company)
      return lead.name && lead.name.trim().length >= 2 && lead.company && lead.company.trim().length >= 2 && lead.company.toLowerCase() !== 'unknown';
    }).map((lead, i) => {
      const title = lead.title || 'N/A';
      return `${i + 1}. ${lead.name} — ${title} @ ${lead.company}`;
    });

    const parts = [];
    if (saved > 0) parts.push(`${saved} lead${saved !== 1 ? 's' : ''} saved to pipeline.`);
    if (skipped > 0) parts.push(`${skipped} rejected (missing name, company, or invalid email).`);
    parts.push('Ready for outreach.');
    const note = parts.join(' ');

    return formatResponse(
      `Found ${final.length} lead${final.length !== 1 ? 's' : ''} for "${query}":\n\n${lines.join('\n')}\n\n${note}`
    );
  } catch (err) {
    console.error('[captain] Research failed:', err.message);
    return formatResponse(`Research failed: ${err.message}`);
  }
}

// ── Lead quality validation — only reject truly unusable leads ────────────────
// Philosophy: a lead that fits ICP should never be rejected because of missing
// enrichment data. Missing company = save with flag, not reject.
function validateLead(lead) {
  const failures = [];
  const warnings = [];

  // Hard reject: must have a name (can't outreach someone with no name)
  if (!lead.name || lead.name.trim().length < 2) {
    failures.push('no name');
  }

  // Hard reject: must have a company (can't personalise outreach without it)
  if (!lead.company || lead.company.trim().length < 2 || lead.company.toLowerCase() === 'unknown') {
    failures.push('no company');
  }

  // Hard reject: invalid email format (if provided — wrong email is worse than no email)
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    failures.push(`invalid email: ${lead.email}`);
  }

  // Soft warning: LinkedIn URL doesn't match expected format
  if (lead.linkedin_url && !lead.linkedin_url.includes('linkedin.com/in/')) {
    warnings.push(`non-standard LinkedIn URL`);
  }

  if (failures.length > 0) {
    return { valid: false, reason: failures.join(', '), warnings };
  }

  return { valid: true, warnings };
}

// Save raw Serper leads to DB (no Haiku verification — MyClaw manual mode)
async function saveLeadsToDB(clientId, leads) {
  const { v4: uuidv4Lead } = require('uuid');
  let saved = 0;
  let skipped = 0;

  for (const lead of leads) {
    try {
      // Quality gate — only reject truly unusable leads
      const validation = validateLead(lead);
      if (!validation.valid) {
        console.warn(`[captain] Lead rejected (hard gate): ${lead.name || 'unnamed'} — ${validation.reason}`);
        skipped++;
        continue;
      }
      if (validation.warnings?.length) {
        console.log(`[captain] Lead saved with warnings: ${lead.name} — ${validation.warnings.join(', ')}`);
      }

      await pool.query(
        `INSERT INTO leads (id, client_id, name, title, company, linkedin_url, email, pipeline_stage, status, data_source, signal_tier, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'researched', 'new', $8, 'P3', $9, NOW(), NOW())
         ON CONFLICT (client_id, linkedin_url) DO NOTHING`,
        [uuidv4Lead(), clientId, lead.name, lead.title || '', lead.company || '', lead.linkedin_url || '', lead.email || '',
         lead.data_source || 'serper',
         JSON.stringify({ quality_warnings: validation.warnings || [], source_query: lead.source_query || '' })]
      );
      saved++;
    } catch (err) {
      console.warn('[captain] saveLeadsToDB skip:', err.message);
      skipped++;
    }
  }

  if (skipped > 0) {
    console.log(`[captain] Lead quality gate: ${saved} saved, ${skipped} rejected`);
  }

  return { saved, skipped };
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

  // Extract location anchor — use Malaysia-related terms if found, else default
  const LOCATION_MAP = { 'kl': 'Kuala Lumpur', 'kuala lumpur': 'Kuala Lumpur', 'malaysia': 'Malaysia', 'klang valley': 'Malaysia', 'penang': 'Penang', 'johor': 'Johor', 'singapore': 'Singapore' };
  let locationAnchor = 'Malaysia';
  for (const [kw, label] of Object.entries(LOCATION_MAP)) {
    if (lower.includes(kw)) { locationAnchor = label; break; }
  }

  // Build queries — role × industry, anchored by location (not "Sdn Bhd" — too restrictive for LinkedIn)
  const queries = [];
  for (const role of activeRoles.slice(0, 4)) {
    for (const industry of activeIndustries.slice(0, 6)) {
      queries.push(`${role} ${industry} ${locationAnchor}`);
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
    status: 'captain_response',
    source: 'captain',
    message: content,
  };
}

// ── Main handler ────────────────────────────────────────────────────────────
async function handleChat(clientId, command) {
  // Log the MyClaw interaction
  await logsService.createLog(clientId, {
    agent: 'captain_beaver',
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
      // If Captain Beaver can't classify, use Claude as the brain
      if (intent.reply) return formatResponse(intent.reply);
      return handleWithClaude(clientId, command);
  }
}

module.exports = {
  handleChat,
  // Backward compat — old MyClaw prefix still works, plus new @captain prefix
  isCaptainMessage: (cmd) => /^(?:@?(?:my)?claw|hey\s+claw|@?captain|hey\s+captain|@?lodge(?:\s*master)?)[,:\s]*/i.test(cmd.trim()),
  // Legacy alias
  isMyClawMessage: (cmd) => /^(?:@?(?:my)?claw|hey\s+claw|@?captain|hey\s+captain|@?lodge(?:\s*master)?)[,:\s]*/i.test(cmd.trim()),
};
