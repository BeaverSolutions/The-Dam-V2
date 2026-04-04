'use strict';

// ─── Sprint 9: Agent Intelligence Upgrade ─────────────────────
// Memory injection added: cross-agent reads, mistake logging.
// Last updated: 2026-04-03

const { v4: uuidv4 } = require('uuid');
const logsService = require('./logs');
const pool = require('../db/pool');
const apolloService = require('./apollo');
const hunterService = require('./hunter');
const { getClientConfig, buildClientContext } = require('./clientConfig');

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
      // MEMORY: Load ICP + weekly learnings before sourcing (Sprint 9)
      const [icpMemory, weeklyLearnings] = await Promise.all([
        getMemory(clientId, 'director', 'icp'),
        getMemory(clientId, 'director', 'weekly_learnings'),
      ]);
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
      await logMistake(clientId, 'research_beaver', 'Claude call failed during research', err.message, 'Retry with a more specific query or check Apollo connection');
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
      const [persona, fileConfig, rangerPatterns] = await Promise.all([
        getClientPersona(clientId),
        getClientConfig(clientId),
        // MEMORY: Load Ranger rejection patterns — brief Sales Beaver on what to avoid (Sprint 9)
        getRangerRejectionPatterns(clientId),
      ]);
      const personaContext = buildPersonaContext(persona);
      const fileContext = buildClientContext(fileConfig);

      let rangerContext = '';
      if (rangerPatterns?.length) {
        rangerContext = `\n\nRANGER REJECTION HISTORY — these patterns were rejected recently, do NOT repeat them:\n${rangerPatterns.slice(0, 5).join('\n')}`;
      }

      const result = await callAgent(
        'sales_beaver',
        `Write a ${channel} outreach message for this lead: ${context}${personaContext}${fileContext}${rangerContext}`,
        { lead_id, channel }
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
      await logMistake(clientId, 'sales_beaver', 'Claude call failed during message generation', err.message, 'Check Claude API connectivity and lead context quality');
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
 * Strip em dashes as a hard safety net before saving any message body.
 * Replaces — with a comma or space depending on context.
 */
function stripEmDashes(text) {
  if (!text) return text;
  // Replace em dash with a comma-space for mid-sentence, or just a space
  return text.replace(/\s*—\s*/g, ', ').replace(/—/g, ' ');
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
      const persona = await getClientPersona(clientId);
      const personaContext = buildPersonaContext(persona);
      const result = await callAgent(
        'ranger',
        `Review this message:\n\n${message_body}${personaContext}`,
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
      await logMistake(clientId, 'ranger', 'Claude call failed during QA review', err.message, 'Ranger fell back to default approval — investigate Claude API');
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
- Under 80 words (body only)
- No em dashes (—) anywhere
- No bullet points
- Exactly 1 question
- No product or service name in opener
- No soft CTAs (no "worth a quick chat", "happy to jump on")
- Specific reference to a real signal about this company
- Reads like a human, not a vendor
- No banned phrases${personaContext}${fileContext}

Return JSON only: {"subject":"Subject line (max 6 words, no em dashes)","body":"Message body here"}`,
      { mode: 'ranger_draft', lead_name, lead_company }
    );

    if (result?.body) {
      return {
        subject: result.subject || null,
        body: stripEmDashes(result.body), // safety net even on Ranger's own draft
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
  const [icp, persona, fileConfig, memoryBrief] = await Promise.all([
    directorGetICP(clientId),
    getClientPersona(clientId),
    getClientConfig(clientId),
    // MEMORY: Build full shared context brief at kickoff (Sprint 9)
    buildDirectorMemoryBrief(clientId),
  ]);

  if (callAgent) {
    try {
      const icpContext = Object.keys(icp).length > 0
        ? `\n\nClient ICP Profile:\n${JSON.stringify(icp, null, 2)}`
        : '';
      const personaContext = buildPersonaContext(persona);
      const fileContext = buildClientContext(fileConfig);
      const result = await callAgent('director', command + icpContext + personaContext + fileContext + memoryBrief);

      // Director is asking for missing info before it can build a plan
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
          estimated_leads: result.estimated_leads || 20,
          estimated_time: result.estimated_time || '~5 min',
        };
      }
    } catch (err) {
      console.warn('[agents] Director failed:', err.message);
      await logMistake(clientId, 'director', 'Plan generation failed', err.message, 'Simplify command or check ICP configuration');
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
                            apollo_enriched, apollo_person_id, apollo_org_id, linkedin_url, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'research_beaver','prospecting','new',$8,$9,$10,$11,$12,$13,$14)
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
          lead.linkedin_url || null,
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
      const meta = lead.metadata || {};
      const contextParts = [
        `Name: ${lead.name}`,
        `Company: ${lead.company}`,
        `Title: ${lead.title || 'N/A'}`,
      ];
      const about = lead.short_description || meta.short_description;
      if (about) contextParts.push(`About: ${about}`);
      if (meta.signal) contextParts.push(`Signal (why reaching out now): ${meta.signal}`);
      if (meta.angle) contextParts.push(`Angle to lead with: ${meta.angle}`);
      if (meta.why_now) contextParts.push(`Why now: ${meta.why_now}`);
      if (meta.friction) contextParts.push(`Friction point: ${meta.friction}`);
      if (meta.notes) contextParts.push(`Personalisation hook: ${meta.notes}`);

      const salesResult = await salesGenerate(clientId, {
        lead_id: lead.id,
        channel: 'email',
        context: contextParts.join('\n'),
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

  // ── Step 4: Ranger review with Sales Beaver retry loop ───────
  // If Ranger rejects, Sales Beaver rewrites using the feedback.
  // Max 3 attempts per message before marking as ranger_rejected.
  const MAX_RANGER_RETRIES = 3;
  let approvedCount = 0;
  let rejectedCount = 0;

  for (const msg of savedMessages) {
    let currentBody = msg.body;
    let currentSubject = msg.subject;
    let finalApproved = false;
    let lastRangerResult = null;

    for (let attempt = 1; attempt <= MAX_RANGER_RETRIES; attempt++) {
      try {
        const rangerResult = await rangerReview(clientId, {
          message_id: msg.id,
          message_body: currentBody,
        });
        lastRangerResult = rangerResult;

        const rangerApproved = rangerResult.approved !== false;
        const rangerNotes = Array.isArray(rangerResult.issues) && rangerResult.issues.length > 0
          ? rangerResult.issues.join('; ')
          : (rangerResult.notes || null);

        await logsService.createLog(clientId, {
          agent: 'ranger',
          action: rangerApproved ? 'message_approved' : 'message_rejected',
          target_type: 'message',
          target_id: msg.id,
          metadata: { score: rangerResult.score, approved: rangerApproved, attempt, notes: rangerNotes },
        });

        if (rangerApproved) {
          // If Ranger returned approve_with_edits, use its suggested_edit (the cleaned version)
          // This is critical — the suggested_edit has em dashes and other issues already fixed by Ranger
          if (rangerResult.decision === 'approve_with_edits' && rangerResult.suggested_edit) {
            currentBody = rangerResult.suggested_edit;
          }
          // Safety net: strip em dashes from the final body no matter what
          currentBody = stripEmDashes(currentBody);

          // Save final approved body and push to approval queue
          await pool.query(
            `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
             status = 'pending_approval', updated_at = NOW()
             WHERE id = $5 AND client_id = $6`,
            [currentBody, currentSubject, Math.round(rangerResult.score || 75), rangerNotes, msg.id, clientId]
          );

          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'ranger')`,
            [clientId, msg.id]
          );

          await logsService.createLog(clientId, {
            agent: 'director',
            action: 'approval_requested',
            target_type: 'message',
            target_id: msg.id,
            metadata: { message_id: msg.id, attempts_taken: attempt },
          });

          finalApproved = true;
          approvedCount++;
          break; // exit retry loop — message approved
        }

        // Ranger rejected — should Sales Beaver rewrite?
        if (attempt < MAX_RANGER_RETRIES) {
          // Update message status so logs reflect the rejection
          await pool.query(
            `UPDATE messages SET ranger_score = $1, ranger_notes = $2, status = 'pending_ranger', updated_at = NOW()
             WHERE id = $3 AND client_id = $4`,
            [Math.round(rangerResult.score || 0), rangerNotes, msg.id, clientId]
          );

          await logsService.createLog(clientId, {
            agent: 'sales_beaver',
            action: 'message_rewrite_triggered',
            target_type: 'message',
            target_id: msg.id,
            metadata: { attempt, ranger_feedback: rangerNotes, lead_id: msg.lead_id },
          });

          // Sales Beaver rewrites using Ranger's rejection feedback
          const leadContext = `Name: ${msg.lead_name || 'Unknown'}, Company: ${msg.lead_company || 'Unknown'}`;
          const rewriteResult = await salesGenerate(clientId, {
            lead_id: msg.lead_id,
            channel: msg.channel || 'email',
            context: `${leadContext}\n\nREWRITE REQUIRED (attempt ${attempt + 1}/${MAX_RANGER_RETRIES}).\n\nRanger rejected the previous message for these reasons:\n${rangerNotes}\n\nPrevious rejected message:\n${currentBody}\n\nRewrite the message fixing ALL of the above issues. Be specific, concise, no product pitch, no qualification questions, under 80 words.`,
          });

          currentBody = rewriteResult.body || currentBody;
          currentSubject = rewriteResult.subject || currentSubject;

          await logsService.createLog(clientId, {
            agent: 'sales_beaver',
            action: 'message_rewritten',
            target_type: 'message',
            target_id: msg.id,
            metadata: { attempt: attempt + 1, rewrite_for_ranger: true },
          });
        }
      } catch (err) {
        console.error('[pipeline] Ranger/rewrite failed for message:', msg.id, `attempt ${attempt}`, err.message);
        break; // don't loop on unexpected errors
      }
    } // end retry loop

    if (!finalApproved) {
      // All Sales Beaver attempts exhausted — Ranger now writes it from scratch
      await logsService.createLog(clientId, {
        agent: 'ranger',
        action: 'ranger_draft_triggered',
        target_type: 'message',
        target_id: msg.id,
        metadata: { attempts_failed: MAX_RANGER_RETRIES, lead_name: msg.lead_name },
      });

      // Pull lead details for context
      let leadRow = null;
      try {
        const leadRes = await pool.query(
          `SELECT title, metadata FROM leads WHERE id = $1 AND client_id = $2 LIMIT 1`,
          [msg.lead_id, clientId]
        );
        leadRow = leadRes.rows[0] || null;
      } catch {}

      const rangerDraftResult = await rangerDraft(clientId, {
        lead_name: msg.lead_name,
        lead_company: msg.lead_company,
        lead_title: leadRow?.title || null,
        lead_angle: leadRow?.metadata?.angle || null,
        lead_friction: leadRow?.metadata?.friction || null,
        rejected_body: currentBody,
      });

      if (rangerDraftResult?.body) {
        // Ranger's own draft — save and send to approval queue
        await pool.query(
          `UPDATE messages SET body = $1, subject = $2, ranger_score = 80, ranger_notes = $3,
           status = 'pending_approval', updated_at = NOW()
           WHERE id = $4 AND client_id = $5`,
          [
            rangerDraftResult.body,
            rangerDraftResult.subject || currentSubject,
            'Drafted by Ranger after 3 Sales Beaver attempts failed QA',
            msg.id,
            clientId,
          ]
        );

        await pool.query(
          `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'ranger')`,
          [clientId, msg.id]
        );

        await logsService.createLog(clientId, {
          agent: 'ranger',
          action: 'ranger_draft_approved',
          target_type: 'message',
          target_id: msg.id,
          metadata: { note: 'Ranger wrote this message after Sales Beaver failed 3 QA checks' },
        });

        finalApproved = true;
        approvedCount++;
      } else {
        // Even Ranger's draft failed — mark lead for manual message
        const finalNotes = lastRangerResult
          ? (Array.isArray(lastRangerResult.issues) && lastRangerResult.issues.length > 0
              ? lastRangerResult.issues.join('; ')
              : lastRangerResult.notes || 'Failed QA after max retries + Ranger draft')
          : 'All QA attempts exhausted';

        await pool.query(
          `UPDATE messages SET ranger_score = $1, ranger_notes = $2, status = 'ranger_rejected', updated_at = NOW()
           WHERE id = $3 AND client_id = $4`,
          [Math.round(lastRangerResult?.score || 0), finalNotes, msg.id, clientId]
        );

        // Flag the lead so user knows it needs a manual message
        await pool.query(
          `UPDATE leads SET metadata = jsonb_set(COALESCE(metadata, '{}'), '{needs_manual_message}', 'true'), updated_at = NOW()
           WHERE id = $1 AND client_id = $2`,
          [msg.lead_id, clientId]
        );

        await logsService.createLog(clientId, {
          agent: 'ranger',
          action: 'message_rejected_final',
          target_type: 'message',
          target_id: msg.id,
          metadata: { attempts: MAX_RANGER_RETRIES, ranger_draft_failed: true, final_notes: finalNotes, lead_needs_manual: true },
        });

        rejectedCount++;
      }
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
      { step: 3, agent: 'ranger', status: 'completed', result: `${approvedCount} approved${rejectedCount > 0 ? `, ${rejectedCount} failed after ${MAX_RANGER_RETRIES} rewrites` : ''}` },
      { step: 4, agent: 'director', status: approvedCount > 0 ? 'completed' : 'pending', result: approvedCount > 0 ? `${approvedCount} message${approvedCount !== 1 ? 's' : ''} in approval queue` : 'All messages failed Ranger QA — check Memory for rejection patterns' },
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
 * CLIENT PERSONA
 * =========================
 */
async function getClientPersona(clientId) {
  const res = await pool.query(
    `SELECT content FROM agent_memory WHERE client_id = $1 AND key = 'client_persona' LIMIT 1`,
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

module.exports = {
  researchSearch,
  salesGenerate,
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
};
