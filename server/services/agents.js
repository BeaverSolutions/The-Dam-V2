'use strict';

// ─── Sprint 9: Agent Intelligence Upgrade ─────────────────────
// Memory injection added: cross-agent reads, mistake logging.
// Last updated: 2026-04-03

const { v4: uuidv4 } = require('uuid');
const logsService = require('./logs');
const pool = require('../db/pool');
const apolloService = require('./apollo');
const hunterService = require('./hunter');
const researchModule = require('./research');
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

      // Extract sender name for the sign-off — from persona or fall back to client name
      const senderName = persona?.sender_name || persona?.contact_name || persona?.name || 'The Team';

      // Channel-specific sign-off instructions
      const signOffInstruction = channel === 'email'
        ? `\nSENDER NAME (use "Regards," then this name on the next line): ${senderName}`
        : `\nDO NOT include any sign-off like "Regards," or "Best," — this is a ${channel} DM, not an email. No sign-off at all. Just end with the question.`;

      const result = await callAgent(
        'sales_beaver',
        `Write a ${channel} outreach message for this lead: ${context}
${signOffInstruction}
${personaContext}${fileContext}${rangerContext}`,
        { lead_id, channel, clientId }
      );

      // Primary: structured JSON response with body field
      if (result?.body) {
        return {
          lead_id,
          channel,
          subject: stripEmDashes(result.subject) || null,
          body:    stripEmDashes(result.body),
          status:  'pending_ranger',
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
            body:    stripEmDashes(extractedBody),
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
            body:    stripEmDashes(raw.trim()),
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
  const fixed = autoFixMessage(message_body, { touchNumber, maxWords: 80 });
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

  // ── Phase A Step 3: Claude scores the FIXED version ──
  if (callAgent) {
    try {
      const persona = await getClientPersona(clientId);
      const personaContext = buildPersonaContext(persona);

      // Inject lead context so Enforcer can validate personalization is real
      const leadContextStr = lead_context?.name
        ? `LEAD CONTEXT (validate message is accurate for this person):\n- Name: ${lead_context.name}\n- Company: ${lead_context.company || 'Unknown'}\n- Title: ${lead_context.title || 'Unknown'}\n- Signal (why now): ${lead_context.signal || lead_context.why_now || 'Not specified'}\n- Angle: ${lead_context.angle || 'Not specified'}\n- Friction: ${lead_context.friction || 'Not specified'}\n\n`
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
        let approved = result.decision === 'approve' || result.decision === 'approve_with_edits';
        const score = result.score || 0;
        if (!approved && score >= 40 && fixesApplied.length > 0) {
          // Post-autofix rescue: fixes applied + score passes floor → approve
          approved = true;
          result.decision = 'approve_with_edits';
          result.feedback = `${result.feedback || ''} [Auto-rescued: fixes=${fixesApplied.join(',')}, score=${score}]`.trim();
        }

        return {
          ...result,
          approved,
          body: fixedBody, // ← return the fixed body so caller saves the cleaned version
          fixes_applied: fixesApplied,
          notes: result.feedback || result.reject_reason || null,
          issues: result.reject_reason ? [result.reject_reason] : [],
          suggestions: result.suggested_edit ? [result.suggested_edit] : [],
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

  let approvedCount = 0;
  let rejectedCount = 0;
  let messagesDrafted = 0;

  for (const lead of leads) {
    try {
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

      const channel = lead.email ? 'email' : 'linkedin';
      const salesResult = await salesGenerate(clientId, {
        lead_id: lead.id,
        channel,
        context: contextParts.join('\n'),
      });

      if (!salesResult?.body) {
        console.warn(`[signal-pipeline] Sales draft failed for ${lead.name}`);
        continue;
      }

      // Insert message
      const { rows: [msg] } = await pool.query(
        `INSERT INTO messages (client_id, lead_id, channel, subject, body, status, metadata)
         VALUES ($1, $2, $3, $4, $5, 'pending_ranger', $6)
         RETURNING *`,
        [clientId, lead.id, channel, salesResult.subject || null, salesResult.body,
         JSON.stringify({ source: 'signal_hunt', signal: meta.signal })]
      );
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
        rejectedCount++;
        continue;
      }

      let rangerResult;
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
      }

      const finalBody = rangerResult?.body || fixed.body;

      if (rangerResult?.approved) {
        // ── Wave 1 auto-approval threshold (mirror of runRangerPipeline logic) ──
        // Read the client's auto_approve_threshold. If Enforcer score >= threshold,
        // skip the human queue and mark the approval as already-approved so the
        // send queue worker picks it up. Keeps the machine running when MJ is AFK.
        // Non-email channels still move through the flow — the Approvals UI
        // shows auto-approved messages in the Approved tab for manual send.
        const rangerScore = rangerResult.score || 70;
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
            // For email channel, go straight to pending_send so the queue worker sends it.
            // For LinkedIn/other channels, stop at 'approved' — it's a manual-send channel.
            nextMessageStatus = (msg.channel === 'email') ? 'pending_send' : 'approved';
            approvalStatus = 'approved';
            resolvedAt = new Date();
            console.log(`[pipeline] AUTO-APPROVED ${msg.id}: score ${rangerScore} >= threshold ${threshold} (channel=${msg.channel}, next=${nextMessageStatus})`);
          }
        } catch (err) {
          console.warn('[pipeline] Failed to read auto_approve_threshold, defaulting to manual:', err.message);
        }

        await pool.query(
          `UPDATE messages SET body = $1, status = $2, ranger_score = $3, ranger_notes = $4, updated_at = NOW() WHERE id = $5`,
          [finalBody, nextMessageStatus, rangerScore,
           autoApproved ? `Auto-approved (score ${rangerScore})` : (rangerResult.notes || 'Signal-sourced, approved'),
           msg.id]
        );

        await pool.query(
          `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [clientId, msg.id,
           autoApproved ? 'auto_approval' : 'signal_hunt',
           approvalStatus,
           resolvedAt]
        );

        // If auto-approved AND email channel, push it into the send queue.
        // Channel guard inside enqueueMessage ensures non-email messages are skipped
        // (LinkedIn / Instagram are manual-send by design).
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
          action: autoApproved ? 'message_auto_approved' : 'message_approved',
          target_type: 'message',
          target_id: msg.id,
          metadata: { channel: msg.channel, score: rangerScore, method: autoApproved ? 'auto_threshold' : 'pipeline_approved' },
        }).catch(() => {});

        approvedCount++;
      } else {
        await pool.query(
          `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1 WHERE id = $2`,
          [rangerResult?.notes || 'Rejected by Enforcer', msg.id]
        );
        rejectedCount++;
      }
    } catch (err) {
      console.error(`[signal-pipeline] Error processing ${lead.name}:`, err.message);
    }
  }

  await logsService.createLog(clientId, {
    agent: 'director',
    action: 'signal_pipeline_completed',
    metadata: { plan_id, leads: leads.length, drafted: messagesDrafted, approved: approvedCount, rejected: rejectedCount },
  });

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
  // Captain Beaver rule: before ANY kickoff, confirm ICP is defined.
  // If critical fields are missing AND command doesn't cover them → ask user first.
  // ICP field detection: check if the command itself provides enough context
  // Be generous — if the command mentions ANY industry-like term, geography, or role, skip the poll
  const cmd = command || '';
  const hasIndustry = icpMemory.industries || /industry|sector|niche|agency|agencies|saas|fintech|proptech|tech|gaming|esports|web3|crypto|marketing|digital|consulting|legal|insurance|real estate|property|food|logistics|healthcare|education|retail|ecommerce|e-commerce|startup|software|ai\b|crypto/i.test(cmd);
  const hasGeo = icpMemory.geographies || icpMemory.location || /location|city|country|region|kuala lumpur|\bkl\b|malaysia|singapore|\bsg\b|indonesia|bangkok|jakarta|penang|johor|selangor|cyberjaya|global|asia|sea\b|southeast asia/i.test(cmd);
  const hasTitle = icpMemory.job_titles || icpMemory.who || /ceo|founder|co-founder|director|title|role|head of|manager|lead|owner|partner|vp|president|chief|cto|cmo|coo|cfo/i.test(cmd);

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

      // If DB leads fully satisfy target, await result and skip research
      if (dbLeadsCount >= targetLimit) {
        const dbResult = await dbLeadsPromise;
        console.log(`[director] DB-first: ${dbLeadsCount} leads processed — target met, skipping external research`);
        return dbResult;
      }

      // Otherwise: DB pipeline runs in background while we continue to external research below
      console.log(`[director] DB-first: ${dbLeadsCount} leads processing in parallel, ${targetLimit - dbLeadsCount} more needed from research`);
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

  // ── Gate 4: Geography + Industry + Company Size ──
  const icpLocation = (icpMemory?.geographies || icpMemory?.geography || icpMemory?.location || '').toLowerCase();
  const isKLFocused = !icpLocation || /klang|kuala lumpur|kl|selangor|malaysia/i.test(icpLocation);

  // Non-target geographies — expanded list
  const NON_TARGET_GEO = /\bsingapore\b|\bsg\b|jakarta|indonesia|bangkok|thailand|\blondon\b|sydney|australia|manila|philippines|vietnam|myanmar|cambodia|india\b|hong kong|\bhk\b|\bdubai\b|\buae\b|abu dhabi|saudi|qatar|bahrain|pakistan|bangladesh|\busa\b|united states|new york|california|san francisco|chicago|toronto|canada|united kingdom|\buk\b/i;

  // Malaysia confirmation — if we can confirm they're in MY, they pass geo check
  const MALAYSIA_CONFIRM = /malaysia|kuala lumpur|\bkl\b|selangor|klang|penang|johor|melaka|sabah|sarawak|perak|kedah|kelantan|pahang|putrajaya|cyberjaya|petaling jaya|\bpj\b|subang|shah alam|bangsar|mont kiara|damansara|\bsdn bhd\b|\bbhd\b/i;

  // Excluded industries
  const EXCLUDED_INDUSTRIES = /hospital|clinic|medical centre|healthcare|pharmacy|polyclinic|hotel|resort|restaurant|hospitality|retail|e-commerce|ecommerce|supermarket|hypermarket|ministry|government|jabatan|polis|army|military/i;

  // Large multinationals — check ALL text fields including name
  const LARGE_CORPS = /\bwpp\b|publicis|omnicom|interpublic|\bbbdo\b|ogilvy|mccann|\bvml\b|dentsu|havas|grey group|leo burnett|saatchi|ddb\b|tbwa|jwt\b|\bdeloitte\b|\bmckinsey\b|\bpwc\b|\bkpmg\b|\bey\b|\baccenture\b|boston consulting|\bbain\b|\bshell\b|\bpetronas\b|tenaga|maybank|\bcimb\b|\brhb\b|public bank|hong leong|sime darby|axiata|celcom|\bmaxis\b|\bdigi\b|unilever|nestle|procter|p&g\b|samsung|\blg\b|sony\b|panasonic|\bgoogle\b|\bmeta\b|\bamazon\b|\bmicrosoft\b|\bapple\b|\bibm\b/i;

  // ── Command intent industry filter — DISABLED ──
  // Previously rejected leads whose profile text didn't contain the exact industry name
  // (e.g. "marketing agency"). This killed valid leads because LinkedIn/Brave snippets
  // rarely include the industry name verbatim. The search query itself already targets
  // the right industry — requiring double-confirmation was too aggressive.
  // Kept as comment for reference; re-enable only with broader matching (e.g. NLP).
  const commandIndustryFilter = null;

  const icpGatedLeads = namedLeads.filter(lead => {
    // Combine ALL text for comprehensive checks
    const allText = [lead.name || '', lead.company || '', lead.title || '', lead.snippet || '', lead.location || ''].join(' ');

    // Command intent gate: if user asked for specific industry, reject leads that don't match
    if (commandIndustryFilter && !commandIndustryFilter.test(allText)) {
      console.warn(`[captain] REJECT command intent: ${lead.name} at ${lead.company} — doesn't match command industry filter`);
      logsService.createLog(clientId, { agent: 'director', action: 'lead_skipped_command_intent', metadata: { name: lead.name, company: lead.company, reason: 'command_industry_mismatch' } }).catch(() => {});
      return false;
    }
    const locationText = [lead.location || '', lead.snippet || ''].join(' ');

    // Geography check (Phase B2: loosened — hard-reject foreign, trust search for rest)
    // Brave country:'MY' already biases toward Malaysian results. Second-guessing that
    // via regex on snippets is circular validation and kills valid leads.
    if (isKLFocused) {
      // Only hard-reject if the lead explicitly shows they're based in a foreign country.
      // Passive Malaysia-confirmation is NOT required — trust the search bias.
      if (NON_TARGET_GEO.test(allText)) {
        // Exception: if Malaysia is ALSO present (e.g. dual-city exec), allow
        if (!MALAYSIA_CONFIRM.test(allText)) {
          console.warn(`[captain] REJECT geo: ${lead.name} at ${lead.company} — foreign location`);
          logsService.createLog(clientId, { agent: 'director', action: 'lead_skipped_geo', metadata: { name: lead.name, company: lead.company, reason: 'foreign_location' } }).catch(() => {});
          return false;
        }
      }
      // No foreign signal + no Malaysia signal = ACCEPT. Trust the search.
    }

    // Industry exclusion
    if (EXCLUDED_INDUSTRIES.test(allText)) {
      console.warn(`[captain] REJECT industry: ${lead.name} at ${lead.company}`);
      logsService.createLog(clientId, { agent: 'director', action: 'lead_skipped_industry', metadata: { name: lead.name, company: lead.company } }).catch(() => {});
      return false;
    }

    // Large multinational check — now checks ALL fields including name
    if (LARGE_CORPS.test(allText)) {
      console.warn(`[captain] REJECT corp: ${lead.name} at ${lead.company} — large multinational`);
      logsService.createLog(clientId, { agent: 'director', action: 'lead_skipped_corp', metadata: { name: lead.name, company: lead.company } }).catch(() => {});
      return false;
    }

    return true;
  });

  diagnostics.after_icp_gate = icpGatedLeads.length;
  if (namedLeads.length !== icpGatedLeads.length) {
    console.log(`[captain] ICP gate removed ${namedLeads.length - icpGatedLeads.length} leads (geo/industry/corp)`);
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

    // Contact channel gate: lead MUST have at least 1 channel (email or LinkedIn)
    const hasAnyChannel = !!(lead.email || lead.linkedin_url);
    if (!hasAnyChannel) {
      console.warn(`[save] Rejecting ${lead.name} at ${lead.company} — no email or LinkedIn URL`);
      diagnostics.reason = (diagnostics.reason || '') + ` Rejected ${lead.name}: no contact channel.`;
      continue;
    }

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

      const res = await pool.query(
        `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                            pipeline_stage, status, email_verified, email_source,
                            apollo_enriched, apollo_person_id, apollo_org_id, linkedin_url, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'research_beaver','prospecting','new',$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (client_id, linkedin_url) WHERE linkedin_url IS NOT NULL AND deleted_at IS NULL
         DO NOTHING
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
      if (res.rows.length > 0) {
        savedLeads.push({ ...res.rows[0], short_description: lead.short_description });
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

    // Smart channel selection based on data quality + availability
    // Priority: verified email > LinkedIn (if no email) > unverified email (risky) > Instagram
    let selectedChannel;
    let channelReason;
    const hasVerifiedEmail = lead.email && (lead.email_verified === true || lead.email_source === 'hunter' || lead.email_source === 'apollo');
    const hasUnverifiedEmail = lead.email && !hasVerifiedEmail;

    if (hasVerifiedEmail) {
      selectedChannel = 'email';
      channelReason = `Verified email (${lead.email_source || 'known'})`;
    } else if (lead.linkedin_url) {
      selectedChannel = 'linkedin';
      channelReason = hasUnverifiedEmail ? 'LinkedIn preferred over unverified email (bounce risk)' : 'No email, LinkedIn available';
    } else if (hasUnverifiedEmail) {
      selectedChannel = 'email';
      channelReason = 'Unverified email (only option)';
    } else {
      selectedChannel = 'instagram';
      channelReason = 'No email or LinkedIn available';
    }

    console.log(`[pipeline] Channel for ${lead.name}: ${selectedChannel} — ${channelReason}`);

    const hint = CHANNEL_HINTS[selectedChannel];

    try {
      const salesResult = await salesGenerate(clientId, {
        lead_id: lead.id,
        channel: selectedChannel,
        context: contextParts.join('\n') + `\n\nCHANNEL INSTRUCTIONS: ${hint}`,
      });

      if (!salesResult?.body) {
        console.warn(`[pipeline] Sales draft failed for ${lead.name} (${selectedChannel}): no body`);
        diagnostics.messages_failed++;
      } else {
        diagnostics.messages_drafted++;
        execStatus.beavers.sales.drafted++;

        const msgRes = await pool.query(
          `INSERT INTO messages (client_id, lead_id, channel, subject, body, status)
           VALUES ($1, $2, $3, $4, $5, 'pending_ranger')
           RETURNING *`,
          [clientId, lead.id, selectedChannel, salesResult.subject || null, salesResult.body]
        );

        const message = msgRes.rows[0];
        const msgWithMeta = { ...message, lead_name: lead.name, lead_company: lead.company };
        savedMessages.push(msgWithMeta);

        await logsService.createLog(clientId, {
          agent: 'sales_beaver',
          action: 'message_created',
          target_type: 'message',
          target_id: message.id,
          metadata: { lead_id: lead.id, lead_name: lead.name, channel: selectedChannel, reason: `Best channel: ${selectedChannel}` },
        });

        // ── Captain validation gate — check for placeholders, missing data ──
        const validation = await captainValidate(clientId, lead, message);
        if (!validation.valid) {
          if (validation.fixed_body) {
            // Captain fixed the message — update body before Enforcer review
            await pool.query(
              `UPDATE messages SET body = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
              [validation.fixed_body, message.id, clientId]
            );
            msgWithMeta.body = validation.fixed_body;
            await logsService.createLog(clientId, {
              agent: 'captain_beaver', action: 'message_fixed', target_type: 'message', target_id: message.id,
              metadata: { notes: validation.notes },
            });
          } else {
            // Captain can't fix — reject the message, skip Enforcer
            await pool.query(
              `UPDATE messages SET status = 'ranger_rejected', ranger_notes = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
              [validation.notes, message.id, clientId]
            );
            await logsService.createLog(clientId, {
              agent: 'captain_beaver', action: 'message_rejected', target_type: 'message', target_id: message.id,
              metadata: { notes: validation.notes },
            });
            diagnostics.messages_failed++;
            // Skip Enforcer — message is already rejected
            return;
          }
        }

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

            // If still rejected after redraft → Enforcer drafts it himself
            if (!rangerResult?.approved) {
              const enforcerBody = await rangerDraft(clientId, {
                lead_name: lead.name, lead_company: lead.company, lead_title: lead.title,
                lead_angle: lead.metadata?.angle, lead_friction: lead.metadata?.friction,
                rejected_body: currentBody,
              });
              if (enforcerBody) {
                currentBody = enforcerBody;
                currentSubject = currentSubject || `${lead.company}`;
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
        const enforcerBody = await rangerDraft(clientId, {
          lead_name: lead.name, lead_company: lead.company, lead_title: lead.title,
          lead_angle: lead.metadata?.angle, lead_friction: lead.metadata?.friction,
          rejected_body: currentBody,
        });
        if (enforcerBody) {
          currentBody = enforcerBody;
          currentSubject = currentSubject || `${lead.company}`;
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

    // ── AI Enforcer approved — decide: auto-approve or human queue? ──
    // Phase Wave 1: Auto-approval threshold
    // Read the client's auto_approve_threshold. If the Enforcer score is >= threshold
    // AND no brand-safety failures, skip the human queue and go straight to pending_send.
    // This keeps the machine running when MJ is AFK.
    const rangerScore = rangerResult?.score || 80;
    let autoApproved = false;
    let approvalStatus = 'pending_approval';
    let nextMessageStatus = 'pending_approval';

    try {
      const { rows: [clientRow] } = await pool.query(
        `SELECT auto_approve_threshold FROM clients WHERE id = $1 LIMIT 1`,
        [clientId]
      );
      const threshold = clientRow?.auto_approve_threshold;

      if (threshold !== null && threshold !== undefined && rangerScore >= threshold) {
        autoApproved = true;
        approvalStatus = 'approved';
        // Channel-aware: email goes straight to send queue. LinkedIn / other
        // channels are manual-send by design (no Playwright in Phase 1) — they
        // stop at 'approved' and live in the Approvals UI Approved tab with
        // a Copy button.
        nextMessageStatus = (msg.channel === 'email') ? 'pending_send' : 'approved';
        console.log(`[enforcer] AUTO-APPROVED ${msg.id}: score ${rangerScore} >= threshold ${threshold} (channel=${msg.channel}, next=${nextMessageStatus})`);
      }
    } catch (err) {
      console.warn('[enforcer] Failed to read auto_approve_threshold, defaulting to manual:', err.message);
    }

    await pool.query(
      `UPDATE messages SET body = $1, subject = $2, ranger_score = $3, ranger_notes = $4,
       ranger_breakdown = $5, status = $6, updated_at = NOW()
       WHERE id = $7 AND client_id = $8`,
      [currentBody, currentSubject, rangerScore,
       autoApproved ? `Auto-approved (score ${rangerScore})` : (rangerResult?.notes || 'Enforcer approved'),
       JSON.stringify(rangerResult?.breakdown || null), nextMessageStatus, msg.id, clientId]
    );

    await pool.query(
      `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [clientId, msg.id, autoApproved ? 'auto_approval' : 'system',
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

    await logsService.createLog(clientId, {
      agent: 'enforcer_beaver',
      action: autoApproved ? 'message_auto_approved' : 'message_approved',
      target_type: 'message',
      target_id: msg.id,
      metadata: { channel: msg.channel, score: rangerScore, method: autoApproved ? 'auto_threshold' : 'ai_enforcer' },
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

  const summary = {
    leads_found: totalLeadsFound,
    messages_drafted: savedMessages.length,
    approved: approvedCount,
    pending_your_approval: approvedCount,
    db_leads_processed: dbLeadsCount,
  };

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

  // MyClaw brief (strategic context) → Claude fallback
  const myClawSvc = require('./myclaw');
  if (myClawSvc.isConfigured()) {
    try {
      const result = await myClawSvc.myClawBrief({ clientId, stats, recent_activity: logsRes.rows });
      if (result?.summary) { summary = result.summary; }
    } catch { /* fall through to Claude */ }
  }

  if (summary === `You have ${stats.total_leads} leads in the pipeline, ${stats.messages_sent} messages generated, and ${stats.pending_approvals} approval${stats.pending_approvals !== 1 ? 's' : ''} waiting for your review.` && callAgent) {
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
  // Win/Loss capture
  captureWinLoss,
  // Code-level Enforcer gates
  codeEnforcerGates,
};
