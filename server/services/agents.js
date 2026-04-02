'use strict';

const { v4: uuidv4 } = require('uuid');
const logsService = require('./logs');
const pool = require('../db/pool');
const apolloService = require('./apollo');
const hunterService = require('./hunter');

let callAgent;

try {
  callAgent = require('./claude').callAgent;
  console.log('[agents] Claude loaded successfully');
} catch (err) {
  console.warn('[agents] Failed to load claude service:', err.message);
}

/**
 * =========================
 * RESEARCH BEAVER
 * =========================
 */
async function researchSearch(clientId, { query, filters = {} }) {
  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'research_search',
    target_type: 'search',
    metadata: { query, filters },
  });

  let leads = [];

  // Try Apollo first — real data beats Claude-generated data
  try {
    const apolloLeads = await apolloService.searchPeople(clientId, { query, limit: filters.limit || 5 });
    if (apolloLeads && apolloLeads.length > 0) {
      console.log(`[research_beaver] Apollo returned ${apolloLeads.length} leads for: "${query}"`);
      return {
        success: true,
        data: { leads: apolloLeads, query, filters, source: 'apollo' },
      };
    }
  } catch (err) {
    console.warn('[research_beaver] Apollo search failed, falling back to Claude:', err.message);
  }

  if (callAgent) {
    try {
      const result = await callAgent(
        'research_beaver',
        `Find companies and people matching this query: "${query}". Return exactly the number of leads requested in the query (default 3 if not specified).`,
        { query, filters }
      );

      // Handle all possible response shapes
      if (Array.isArray(result)) {
        leads = result;
      } else if (Array.isArray(result?.leads)) {
        leads = result.leads;
      } else if (result?.raw) {
        // Strip markdown code fences if present
        let raw = result.raw.trim();
        raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) leads = parsed;
          else if (Array.isArray(parsed?.leads)) leads = parsed.leads;
        } catch {
          // Try to extract JSON object or array from raw text
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
    }
  }

  return {
    success: true,
    data: { leads, query, filters },
  };
}

/**
 * =========================
 * SALES BEAVER
 * =========================
 */
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
      const result = await callAgent(
        'sales_beaver',
        `Write a ${channel} outreach message for this lead: ${context}`,
        { lead_id, channel, context }
      );

      if (result?.body) {
        return {
          lead_id,
          channel,
          subject: result.subject || null,
          body: result.body,
          status: 'pending_ranger',
        };
      }
    } catch (err) {
      console.warn('[agents] Sales Claude failed:', err.message);
    }
  }

  return {
    lead_id,
    channel,
    subject: `Reaching out — quick question`,
    body: `Hi there,\n\nI came across your company and thought there might be a great fit. Would love to connect and share how we've been helping similar companies.\n\nOpen to a quick chat?\n\nBest,\nThe Team`,
    status: 'pending_ranger',
  };
}

/**
 * =========================
 * RANGER
 * =========================
 */
async function rangerReview(clientId, { message_id, message_body }) {
  await logsService.createLog(clientId, {
    agent: 'ranger',
    action: 'ranger_review',
    target_type: 'message',
    target_id: message_id,
    metadata: { message_id },
  });

  if (callAgent) {
    try {
      const result = await callAgent(
        'ranger',
        `Review this message:\n\n${message_body}`,
        { message_id }
      );

      // Normalise new format { decision, score, breakdown, feedback, suggested_edit, reject_reason }
      // to include approved: boolean for backward compat with pipeline code
      if (result?.decision !== undefined) {
        const approved = result.decision === 'approve' || result.decision === 'approve_with_edits';
        return {
          ...result,
          approved,
          notes: result.feedback || result.reject_reason || null,
          issues: result.reject_reason ? [result.reject_reason] : [],
          suggestions: result.suggested_edit ? [result.suggested_edit] : [],
        };
      }
      // Legacy format
      if (result?.approved !== undefined) {
        return result;
      }
    } catch (err) {
      console.warn('[agents] Ranger failed:', err.message);
    }
  }

  return {
    message_id,
    approved: true,
    decision: 'approve',
    score: 80,
    notes: 'Fallback approval',
    issues: [],
    suggestions: [],
  };
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
    return "The Ranger review is a mandatory quality gate and cannot be skipped or bypassed. Every message must pass Ranger's QA check before it reaches your approval queue. This protects you from sending non-compliant, low-quality, or off-brand messages — it's a core safety feature of The Dam.\n\nIf Ranger keeps rejecting messages, try asking me to adjust the messaging style instead.";
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

async function directorPlan(clientId, { command }) {
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

  const planId = uuidv4();
  const icp = await directorGetICP(clientId);

  if (callAgent) {
    try {
      const icpContext = Object.keys(icp).length > 0
        ? `\n\nClient ICP Profile:\n${JSON.stringify(icp, null, 2)}`
        : '';
      const result = await callAgent('director', command + icpContext);

      if (result?.steps) {
        return {
          plan_id: planId,
          command,
          interpretation: result.interpretation || command,
          steps: result.steps,
          status: 'pending_approval',
          estimated_leads: result.estimated_leads || 20,
          estimated_time: result.estimated_time || '~5 min',
        };
      }
    } catch (err) {
      console.warn('[agents] Director failed:', err.message);
    }
  }

  return {
    plan_id: planId,
    command,
    interpretation: command,
    steps: [
      { step: 1, agent: 'research_beaver', action: 'Search for companies matching query', status: 'pending' },
      { step: 2, agent: 'sales_beaver', action: 'Generate personalised outreach for each lead', status: 'pending' },
      { step: 3, agent: 'ranger', action: 'QA review all generated messages', status: 'pending' },
      { step: 4, agent: 'director', action: 'Queue approved messages for user review', status: 'pending' },
    ],
    status: 'pending_approval',
    estimated_leads: 20,
    estimated_time: '~5 min',
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

      // Fallback: domain search — grab whoever Hunter knows at this company
      const domainResults = await hunterService.domainSearch(clientId, { company: lead.company, limit: 1 });
      if (domainResults.length > 0) {
        console.log(`[hunter] Domain fallback: ${domainResults[0].email} at ${lead.company}`);
        enriched.push({
          ...lead,
          email: domainResults[0].email,
          email_verified: false,
          email_source: 'hunter_domain',
        });
      } else {
        enriched.push(lead); // no email found — save lead anyway
      }
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
 * DIRECTOR — EXECUTE (full pipeline)
 * =========================
 */
async function directorExecute(clientId, { plan_id, command }) {
  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'plan_executing',
    metadata: { plan_id },
  });

  // ── Step 1: Research Beaver ──────────────────────────────
  const researchResult = command
    ? await researchSearch(clientId, { query: command })
    : { data: { leads: [] } };

  const rawLeads = researchResult?.data?.leads || [];

  // ── Step 1b: Hunter.io email enrichment ──────────────────
  const enrichedLeads = await enrichLeadsWithHunter(clientId, rawLeads);

  // ── Step 2: Save leads to DB ─────────────────────────────
  const savedLeads = [];
  for (const lead of enrichedLeads) {
    try {
      const meta = lead.metadata || {};
      if (lead.apollo_person_id) {
        meta.apollo_person_id = lead.apollo_person_id;
        meta.apollo_org_id = lead.apollo_org_id;
      }
      meta.source = lead.metadata?.source || 'research_beaver';

      const res = await pool.query(
        `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                            pipeline_stage, status, email_verified, email_source,
                            apollo_enriched, apollo_person_id, apollo_org_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'research_beaver','prospecting','new',$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          clientId,
          lead.name || 'Unknown Contact',
          lead.email || null,
          lead.company || 'Unknown Company',
          lead.title || null,
          lead.signal_tier || null,
          lead.score || 0,
          lead.email_verified || false,
          lead.email_source || null,
          !!(lead.metadata?.apollo_person_id),
          lead.metadata?.apollo_person_id || null,
          lead.metadata?.apollo_org_id || null,
          JSON.stringify({ short_description: lead.short_description || '', ...meta }),
        ]
      );
      savedLeads.push({ ...res.rows[0], short_description: lead.short_description });
    } catch (err) {
      console.error('[pipeline] Failed to save lead:', err.message, err.detail || '');
    }
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'leads_saved',
    metadata: { count: savedLeads.length, plan_id },
  });

  // ── Step 3: Sales Beaver (cap at 5) ──────────────────────
  const leadsToProcess = savedLeads.slice(0, 5);
  const savedMessages = [];

  for (const lead of leadsToProcess) {
    try {
      const salesResult = await salesGenerate(clientId, {
        lead_id: lead.id,
        channel: 'email',
        context: `Name: ${lead.name}, Company: ${lead.company}, Title: ${lead.title || 'N/A'}, About: ${lead.short_description || ''}`,
      });

      const msgRes = await pool.query(
        `INSERT INTO messages (client_id, lead_id, channel, subject, body, status)
         VALUES ($1, $2, 'email', $3, $4, 'pending_ranger')
         RETURNING *`,
        [clientId, lead.id, salesResult.subject, salesResult.body]
      );

      const message = msgRes.rows[0];
      savedMessages.push({ ...message, lead_name: lead.name, lead_company: lead.company });

      await logsService.createLog(clientId, {
        agent: 'sales_beaver',
        action: 'message_created',
        target_type: 'message',
        target_id: message.id,
        metadata: { lead_id: lead.id, lead_name: lead.name },
      });
    } catch (err) {
      console.error('[pipeline] Sales failed for lead:', lead.name, err.message, err.detail || '');
    }
  }

  // ── Step 4: Ranger review ─────────────────────────────────
  let approvedCount = 0;
  let rejectedCount = 0;

  for (const msg of savedMessages) {
    try {
      const rangerResult = await rangerReview(clientId, {
        message_id: msg.id,
        message_body: msg.body,
      });

      const rangerApproved = rangerResult.approved !== false;
      const newStatus = rangerApproved ? 'pending_approval' : 'ranger_rejected';
      const rangerNotes = Array.isArray(rangerResult.issues) && rangerResult.issues.length > 0
        ? rangerResult.issues.join('; ')
        : (rangerResult.notes || null);

      await pool.query(
        `UPDATE messages SET ranger_score = $1, ranger_notes = $2, status = $3, updated_at = NOW()
         WHERE id = $4 AND client_id = $5`,
        [rangerResult.score || 75, rangerNotes, newStatus, msg.id, clientId]
      );

      await logsService.createLog(clientId, {
        agent: 'ranger',
        action: rangerApproved ? 'message_approved' : 'message_rejected',
        target_type: 'message',
        target_id: msg.id,
        metadata: { score: rangerResult.score, approved: rangerApproved },
      });

      if (rangerApproved) {
        await pool.query(
          `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'ranger')`,
          [clientId, msg.id]
        );
        approvedCount++;

        await logsService.createLog(clientId, {
          agent: 'director',
          action: 'approval_requested',
          target_type: 'message',
          target_id: msg.id,
          metadata: { message_id: msg.id },
        });
      } else {
        rejectedCount++;
      }
    } catch (err) {
      console.error('[pipeline] Ranger failed for message:', msg.id, err.message, err.detail || '');
    }
  }

  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'plan_completed',
    metadata: { plan_id, leads_found: savedLeads.length, messages_drafted: savedMessages.length, approved: approvedCount },
  });

  const summary = {
    leads_found: savedLeads.length,
    messages_drafted: savedMessages.length,
    approved: approvedCount,
    pending_your_approval: approvedCount,
  };

  return {
    plan_id,
    status: 'completed',
    leads: savedLeads,
    summary,
    results: [
      { step: 1, agent: 'research_beaver', status: 'completed', result: `${savedLeads.length} lead${savedLeads.length !== 1 ? 's' : ''} found & saved` },
      { step: 2, agent: 'sales_beaver', status: 'completed', result: `${savedMessages.length} message${savedMessages.length !== 1 ? 's' : ''} drafted` },
      { step: 3, agent: 'ranger', status: 'completed', result: `${approvedCount} approved${rejectedCount > 0 ? `, ${rejectedCount} rejected` : ''}` },
      { step: 4, agent: 'director', status: approvedCount > 0 ? 'completed' : 'pending', result: approvedCount > 0 ? `${approvedCount} message${approvedCount !== 1 ? 's' : ''} in approval queue` : 'No messages to queue' },
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
        'director',
        `Generate a concise morning brief. Stats: ${JSON.stringify(stats)}. Recent activity: ${JSON.stringify(logsRes.rows.map(l => `${l.agent}: ${l.action}`))}.
Return JSON: { "summary": string (2-3 sentences, conversational), "stats": { "total_leads": number, "messages_sent": number, "pending_approvals": number } }`,
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

module.exports = {
  researchSearch,
  salesGenerate,
  rangerReview,
  directorPlan,
  directorExecute,
  directorBrief,
  directorGetICP,
  directorUpsertICP,
};
