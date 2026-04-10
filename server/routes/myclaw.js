'use strict';

// ─── MyClaw Integration Routes ─────────────────────────────────────────────
// Endpoints for MyClaw (OpenClaw) to act as Director layer in The Dam.
// Auth: MYCLAW_HOOK_TOKEN via x-myclaw-token header or Authorization: Bearer
//
// Inbound (MyClaw → The Dam):
//   POST /api/myclaw/approve        — Approve a message in queue
//   POST /api/myclaw/reject         — Reject a message in queue
//   POST /api/myclaw/memory         — Write agent memory (learnings, ICP updates)
//   POST /api/myclaw/leads          — Create a validated lead
//   PUT  /api/myclaw/leads/:id      — Update lead metadata / validation score
//
// Outbound (The Dam exposes for MyClaw to read):
//   GET  /api/myclaw/approvals      — Pending approvals with ranger breakdown
//   GET  /api/myclaw/memory         — Read agent memory by agent/key
//   GET  /api/myclaw/leads          — Lead list with pipeline context
//   GET  /api/myclaw/status         — Connection health check

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const logsService = require('../services/logs');
const { safeCompare } = require('../utils/crypto');
const { enqueueMessage } = require('../services/sendQueueWorker');

// ── MyClaw auth middleware ─────────────────────────────────────────────────
function requireMyClawAuth(req, res, next) {
  const MYCLAW_TOKEN = process.env.MYCLAW_HOOK_TOKEN || process.env.MYCLAW_API_KEY;
  if (!MYCLAW_TOKEN) {
    return res.status(503).json({ error: 'MyClaw not configured', code: 'MYCLAW_NOT_CONFIGURED' });
  }

  const authHeader = req.headers.authorization;
  const tokenHeader = req.headers['x-myclaw-token'] || req.headers['x-openclaw-token'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearerToken || tokenHeader;

  if (!token || !safeCompare(token, MYCLAW_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized', code: 'INVALID_MYCLAW_TOKEN' });
  }
  next();
}

router.use(requireMyClawAuth);

// ── Helper: resolve client_id from body or query ──────────────────────────
function getClientId(req) {
  return req.body?.client_id || req.query?.client_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/myclaw/status — Health check + capability summary
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    data: {
      connected: true,
      role: 'director',
      capabilities: ['approve', 'reject', 'read_approvals', 'write_memory', 'read_memory', 'create_leads', 'update_leads'],
      timestamp: new Date().toISOString(),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/myclaw/approvals — Pending approvals with full context + ranger breakdown
// ─────────────────────────────────────────────────────────────────────────────
router.get('/approvals', async (req, res, next) => {
  try {
    const clientId = getClientId(req);
    const where = clientId ? 'AND a.client_id = $1::uuid' : '';
    const params = clientId ? [clientId] : [];

    const result = await pool.query(
      `SELECT
         a.id              AS approval_id,
         a.client_id,
         a.status,
         a.created_at,
         m.id              AS message_id,
         m.subject,
         m.body,
         m.channel,
         m.ranger_score,
         m.ranger_notes,
         m.ranger_breakdown,
         m.ranger_attempt_count,
         l.id              AS lead_id,
         l.name            AS lead_name,
         l.company         AS lead_company,
         l.title           AS lead_title,
         l.email           AS lead_email,
         l.linkedin_url    AS lead_linkedin,
         l.signal_tier,
         l.metadata->>'signal'   AS lead_signal,
         l.metadata->>'angle'    AS lead_angle,
         l.metadata->>'friction' AS lead_friction
       FROM approvals a
       JOIN messages m ON m.id = a.message_id
       JOIN leads l ON l.id = m.lead_id
       WHERE a.status = 'pending' ${where}
       ORDER BY a.created_at ASC
       LIMIT 50`,
      params
    );

    res.json({ data: result.rows, meta: { total: result.rowCount } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/myclaw/approve — MyClaw approves a message → auto-enqueues for send
// ─────────────────────────────────────────────────────────────────────────────
router.post('/approve', async (req, res, next) => {
  try {
    const { approval_id, client_id, feedback } = req.body;
    if (!approval_id || !client_id) {
      return res.status(400).json({ error: 'approval_id and client_id required', code: 'MISSING_FIELDS' });
    }

    const existing = await pool.query(
      `SELECT a.*, m.id as message_id FROM approvals a
       JOIN messages m ON m.id = a.message_id
       WHERE a.id = $1 AND a.client_id = $2`,
      [approval_id, client_id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Approval not found', code: 'NOT_FOUND' });
    }
    if (existing.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Approval already resolved', code: 'ALREADY_RESOLVED' });
    }

    const { message_id } = existing.rows[0];

    await pool.query(
      `UPDATE approvals SET status = 'approved', notes = $1, approved_by = NULL, resolved_at = NOW()
       WHERE id = $2 AND client_id = $3`,
      [`[MyClaw] ${feedback || 'Approved by MyClaw'}`, approval_id, client_id]
    );
    await pool.query(
      `UPDATE messages SET status = 'approved', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
      [message_id, client_id]
    );

    // Auto-enqueue for send
    await enqueueMessage(client_id, message_id);

    await logsService.createLog(client_id, {
      agent: 'captain_beaver',
      action: 'message_approved',
      target_type: 'approval',
      target_id: approval_id,
      metadata: { message_id, feedback, source: 'captain_api' },
    });

    res.json({ data: { approval_id, message_id, status: 'approved' } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/myclaw/reject — MyClaw rejects with structured feedback
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reject', async (req, res, next) => {
  try {
    const { approval_id, client_id, reason, agent_learnings } = req.body;
    if (!approval_id || !client_id) {
      return res.status(400).json({ error: 'approval_id and client_id required', code: 'MISSING_FIELDS' });
    }

    const existing = await pool.query(
      `SELECT a.*, m.id as message_id FROM approvals a
       JOIN messages m ON m.id = a.message_id
       WHERE a.id = $1 AND a.client_id = $2`,
      [approval_id, client_id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Approval not found', code: 'NOT_FOUND' });
    }
    if (existing.rows[0].status !== 'pending') {
      return res.status(400).json({ error: 'Approval already resolved', code: 'ALREADY_RESOLVED' });
    }

    const { message_id } = existing.rows[0];

    await pool.query(
      `UPDATE approvals SET status = 'rejected', notes = $1, approved_by = NULL, resolved_at = NOW()
       WHERE id = $2 AND client_id = $3`,
      [`[MyClaw] ${reason || 'Rejected by MyClaw'}`, approval_id, client_id]
    );
    await pool.query(
      `UPDATE messages SET status = 'rejected', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
      [message_id, client_id]
    );

    // Persist agent learnings from MyClaw's rejection decision
    if (agent_learnings && typeof agent_learnings === 'object') {
      for (const [agent, learnings] of Object.entries(agent_learnings)) {
        if (!learnings || typeof learnings !== 'object') continue;
        await pool.query(
          `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
           VALUES ($1, $2, 'pattern', 'myclaw_rejections', $3::jsonb)
           ON CONFLICT (client_id, agent, key)
           DO UPDATE SET content = agent_memory.content || $3::jsonb, updated_at = NOW()`,
          [client_id, agent, JSON.stringify(learnings)]
        );
      }
    }

    await logsService.createLog(client_id, {
      agent: 'captain_beaver',
      action: 'message_rejected',
      target_type: 'approval',
      target_id: approval_id,
      metadata: { message_id, reason, agent_learnings, source: 'captain_api' },
    });

    res.json({ data: { approval_id, message_id, status: 'rejected' } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/myclaw/memory — Read agent memory by agent + optional key
// ─────────────────────────────────────────────────────────────────────────────
router.get('/memory', async (req, res, next) => {
  try {
    const { client_id, agent, key, memory_type } = req.query;
    if (!client_id) {
      return res.status(400).json({ error: 'client_id required', code: 'MISSING_FIELDS' });
    }

    const conditions = ['client_id = $1', "memory_type != 'secret'"];
    const params = [client_id];

    if (agent) { conditions.push(`agent = $${params.push(agent)}`); }
    if (key) { conditions.push(`key = $${params.push(key)}`); }
    if (memory_type) { conditions.push(`memory_type = $${params.push(memory_type)}`); }

    const result = await pool.query(
      `SELECT agent, memory_type, key, content, updated_at
       FROM agent_memory
       WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT 50`,
      params
    );

    res.json({ data: result.rows, meta: { total: result.rowCount } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/myclaw/memory — MyClaw writes learnings back to agent memory
// ─────────────────────────────────────────────────────────────────────────────
router.post('/memory', async (req, res, next) => {
  try {
    const { client_id, agent, memory_type, key, content } = req.body;
    if (!client_id || !agent || !memory_type || !key || content === undefined) {
      return res.status(400).json({ error: 'client_id, agent, memory_type, key, content required', code: 'MISSING_FIELDS' });
    }

    const allowed = ['icp', 'brand_voice', 'objection', 'pattern', 'preference', 'conversion_data', 'persona', 'journal', 'config', 'mistakes', 'key'];
    if (!allowed.includes(memory_type)) {
      return res.status(400).json({ error: `Invalid memory_type. Must be one of: ${allowed.join(', ')}`, code: 'INVALID_MEMORY_TYPE' });
    }

    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (client_id, agent, key)
       DO UPDATE SET content = $5::jsonb, memory_type = $3, updated_at = NOW()`,
      [client_id, agent, memory_type, key, JSON.stringify(content)]
    );

    await logsService.createLog(client_id, {
      agent: 'captain_beaver',
      action: 'memory_updated',
      target_type: 'agent_memory',
      metadata: { agent, memory_type, key, source: 'captain_api' },
    });

    res.json({ data: { agent, memory_type, key, updated: true } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/myclaw/leads — Lead list with pipeline context
// ─────────────────────────────────────────────────────────────────────────────
router.get('/leads', async (req, res, next) => {
  try {
    const { client_id, status, signal_tier, limit = 20 } = req.query;
    if (!client_id) {
      return res.status(400).json({ error: 'client_id required', code: 'MISSING_FIELDS' });
    }

    const conditions = ['client_id = $1', 'deleted_at IS NULL'];
    const params = [client_id];

    if (status) { conditions.push(`status = $${params.push(status)}`); }
    if (signal_tier) { conditions.push(`signal_tier = $${params.push(signal_tier)}`); }

    const result = await pool.query(
      `SELECT id, name, email, company, title, linkedin_url, signal_tier, status,
              pipeline_stage, score, metadata, created_at, updated_at
       FROM leads
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.push(Math.min(Number(limit), 100))}`,
      params
    );

    res.json({ data: result.rows, meta: { total: result.rowCount } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/myclaw/leads — MyClaw creates a validated lead directly
// ─────────────────────────────────────────────────────────────────────────────
router.post('/leads', async (req, res, next) => {
  try {
    const {
      client_id, name, email, company, title, linkedin_url,
      signal_tier, signal, angle, friction, why_now, notes,
      myclaw_confidence, myclaw_notes,
    } = req.body;

    if (!client_id || !name || !company) {
      return res.status(400).json({ error: 'client_id, name, company required', code: 'MISSING_FIELDS' });
    }

    // Dedup check
    if (email) {
      const dup = await pool.query(
        `SELECT id FROM leads WHERE client_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
        [client_id, email]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({ error: 'Lead with this email already exists', code: 'DUPLICATE_LEAD', data: { id: dup.rows[0].id } });
      }
    }

    const metadata = {
      signal, angle, friction, why_now, notes,
      data_source: 'myclaw',
      myclaw_confidence: myclaw_confidence || null,
      myclaw_notes: myclaw_notes || null,
      verified: true,
    };

    const result = await pool.query(
      `INSERT INTO leads (client_id, name, email, company, title, linkedin_url,
                          signal_tier, source, pipeline_stage, status, score, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'myclaw', 'prospecting', 'new', 0, $8::jsonb)
       RETURNING *`,
      [client_id, name, email || null, company, title || null, linkedin_url || null,
       signal_tier || 'P1', JSON.stringify(metadata)]
    );

    await logsService.createLog(client_id, {
      agent: 'captain_beaver',
      action: 'lead_created',
      target_type: 'lead',
      target_id: result.rows[0].id,
      metadata: { name, company, signal_tier, source: 'captain_api' },
    });

    res.status(201).json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/myclaw/leads/:id — MyClaw updates lead metadata / validation score
// ─────────────────────────────────────────────────────────────────────────────
router.put('/leads/:id', async (req, res, next) => {
  try {
    const { client_id, status, pipeline_stage, signal_tier, metadata_patch } = req.body;
    if (!client_id) {
      return res.status(400).json({ error: 'client_id required', code: 'MISSING_FIELDS' });
    }

    const updates = ['updated_at = NOW()'];
    const params = [req.params.id, client_id];

    if (status) { updates.push(`status = $${params.push(status)}`); }
    if (pipeline_stage) { updates.push(`pipeline_stage = $${params.push(pipeline_stage)}`); }
    if (signal_tier) { updates.push(`signal_tier = $${params.push(signal_tier)}`); }
    if (metadata_patch && typeof metadata_patch === 'object') {
      updates.push(`metadata = metadata || $${params.push(JSON.stringify(metadata_patch))}::jsonb`);
    }

    const result = await pool.query(
      `UPDATE leads SET ${updates.join(', ')}
       WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found', code: 'NOT_FOUND' });
    }

    await logsService.createLog(client_id, {
      agent: 'captain_beaver',
      action: 'lead_updated',
      target_type: 'lead',
      target_id: req.params.id,
      metadata: { status, pipeline_stage, signal_tier, source: 'captain_api' },
    });

    res.json({ data: result.rows[0] });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/myclaw/validate-leads — Batch-validate Research Beaver output
// Gates leads before Sales Beaver can process them.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/validate-leads', async (req, res, next) => {
  try {
    const { client_id, lead_ids } = req.body;
    if (!client_id || !Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'client_id and lead_ids (non-empty array) required', code: 'MISSING_FIELDS' });
    }

    const qualified = [];
    const rejected = [];

    for (const leadId of lead_ids) {
      const leadResult = await pool.query(
        `SELECT id, name, company, email, linkedin_url, pipeline_stage, metadata
         FROM leads
         WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
        [leadId, client_id]
      );

      if (leadResult.rows.length === 0) {
        rejected.push({ id: leadId, reason: 'Lead not found' });
        continue;
      }

      const lead = leadResult.rows[0];
      const reasons = [];

      // Validation checks
      if (!lead.name) reasons.push('missing name');
      if (!lead.company) reasons.push('missing company');
      if (!lead.email && !lead.linkedin_url) reasons.push('no contact channel (email or linkedin_url)');
      if (lead.pipeline_stage !== 'researched') reasons.push(`pipeline_stage is '${lead.pipeline_stage}', expected 'researched'`);

      const now = new Date().toISOString();

      if (reasons.length === 0) {
        // Valid — qualify the lead
        const existingMeta = lead.metadata || {};
        const patchedMeta = { ...existingMeta, myclaw_validated: true, qualified_at: now };

        await pool.query(
          `UPDATE leads SET pipeline_stage = 'qualified', metadata = $1::jsonb, updated_at = NOW()
           WHERE id = $2 AND client_id = $3`,
          [JSON.stringify(patchedMeta), leadId, client_id]
        );

        qualified.push(leadId);

        await logsService.createLog(client_id, {
          agent: 'captain_beaver',
          action: 'lead_qualified',
          target_type: 'lead',
          target_id: leadId,
          metadata: { source: 'myclaw_validate_leads' },
        });
      } else {
        // Invalid — reject the lead
        const existingMeta = lead.metadata || {};
        const patchedMeta = { ...existingMeta, rejection_reason: reasons.join('; '), rejected_at: now };

        await pool.query(
          `UPDATE leads SET pipeline_stage = 'rejected', metadata = $1::jsonb, updated_at = NOW()
           WHERE id = $2 AND client_id = $3`,
          [JSON.stringify(patchedMeta), leadId, client_id]
        );

        rejected.push({ id: leadId, reason: reasons.join('; ') });

        await logsService.createLog(client_id, {
          agent: 'captain_beaver',
          action: 'lead_rejected',
          target_type: 'lead',
          target_id: leadId,
          metadata: { reasons, source: 'myclaw_validate_leads' },
        });
      }
    }

    res.json({ data: { qualified, rejected } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/myclaw/qualified-leads — Qualified leads ready for Sales Beaver
// Returns leads that passed validation but haven't been contacted yet.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/qualified-leads', async (req, res, next) => {
  try {
    const { client_id, limit = 20 } = req.query;
    if (!client_id) {
      return res.status(400).json({ error: 'client_id required', code: 'MISSING_FIELDS' });
    }

    const result = await pool.query(
      `SELECT id, name, email, company, title, linkedin_url, signal_tier, status,
              pipeline_stage, score, metadata, created_at, updated_at
       FROM leads
       WHERE client_id = $1
         AND pipeline_stage = 'qualified'
         AND deleted_at IS NULL
         AND (first_contacted_at IS NULL OR (sequence_status = 'active' AND sequence_touch = 0))
       ORDER BY signal_tier ASC, created_at DESC
       LIMIT $2`,
      [client_id, Math.min(Number(limit), 100)]
    );

    res.json({ data: result.rows, meta: { total: result.rowCount } });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/myclaw/signal-search — Signal-first search for buying signals
// Searches open web for funding, hiring, expansion, leadership changes.
// Returns raw signals with company extraction — MyClaw decides what to do next.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/signal-search', async (req, res, next) => {
  try {
    const { client_id, queries, max_results_per_query = 5 } = req.body;
    if (!client_id || !queries || !Array.isArray(queries) || queries.length === 0) {
      return res.status(400).json({ error: 'client_id and queries[] required', code: 'MISSING_FIELDS' });
    }

    // Limit queries per request to control costs
    const capped = queries.slice(0, 10);

    const { searchOpenWeb, searchLinkedInProfiles } = require('../services/searchService');

    let claudeClient;
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } catch (err) {
      console.warn('[signal-search] Anthropic SDK not available, skipping AI parsing');
    }

    const allSignals = [];
    const queriesUsed = [];

    for (const q of capped) {
      const { query, signal_type = 'general' } = q;
      if (!query) continue;

      queriesUsed.push(query);

      // Person-search queries go through LinkedIn search
      if (signal_type === 'person_search') {
        const profiles = await searchLinkedInProfiles(query, max_results_per_query);
        for (const p of profiles) {
          allSignals.push({
            company: p.company || '',
            signal_type: 'person_found',
            signal_summary: `${p.name} — ${p.title} at ${p.company}`,
            signal_date: '',
            source_url: p.linkedin_url || '',
            raw_snippet: p.snippet || '',
            confidence: p.name && p.company && p.company !== 'Unknown' ? 0.8 : 0.5,
            person: { name: p.name, title: p.title, linkedin_url: p.linkedin_url },
          });
        }
        continue;
      }

      // Signal queries go through open web search
      const results = await searchOpenWeb(query, max_results_per_query);

      if (results.length === 0) continue;

      // Use Haiku to parse signals from search results if available
      if (claudeClient) {
        try {
          const snippets = results.map((r, i) =>
            `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}${r.date ? `\nDate: ${r.date}` : ''}`
          ).join('\n\n');

          const aiResp = await claudeClient.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: `You are a buying signal detector. Analyse these search results and extract real buying signals.

Signal type being searched: ${signal_type}

Search results:
${snippets}

For each result that contains a REAL buying signal (company doing something that indicates they might need services — funding, hiring, expanding, launching, leadership change), return a JSON array:

[{
  "company": "Company Name",
  "signal_type": "${signal_type}",
  "signal_summary": "One sentence: what happened",
  "signal_date": "YYYY-MM-DD or empty string if unknown",
  "source_url": "the URL",
  "raw_snippet": "original snippet",
  "confidence": 0.0-1.0
}]

Rules:
- Only include REAL signals — companies actually doing something
- Ignore generic articles, listicles, or ads
- Confidence 0.9 = very clear signal, 0.5 = weak/ambiguous
- If no real signals found, return empty array []
- Return ONLY the JSON array, nothing else`
            }],
          });

          const content = aiResp.content[0]?.text || '[]';
          // Extract JSON from response (handle markdown code blocks)
          const jsonMatch = content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            allSignals.push(...parsed);
          }
        } catch (err) {
          console.warn(`[signal-search] Haiku parsing failed for "${query}": ${err.message}`);
          // Fallback: return raw results without AI parsing
          for (const r of results) {
            allSignals.push({
              company: '',
              signal_type,
              signal_summary: r.title,
              signal_date: r.date || '',
              source_url: r.link,
              raw_snippet: r.snippet,
              confidence: 0.4,
            });
          }
        }
      } else {
        // No AI — return raw results
        for (const r of results) {
          allSignals.push({
            company: '',
            signal_type,
            signal_summary: r.title,
            signal_date: r.date || '',
            source_url: r.link,
            raw_snippet: r.snippet,
            confidence: 0.4,
          });
        }
      }
    }

    // Log the signal hunt
    await logsService.createLog(client_id, {
      agent: 'research_beaver',
      action: 'signal_search',
      target_type: 'signal',
      metadata: {
        queries_used: queriesUsed.length,
        signals_found: allSignals.length,
        signal_types: [...new Set(allSignals.map(s => s.signal_type))],
        source: 'myclaw_signal_hunt',
      },
    });

    res.json({
      data: {
        signals: allSignals,
        queries_used: queriesUsed.length,
        signals_found: allSignals.length,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
