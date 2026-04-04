'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const agentsService = require('../services/agents');

router.post('/research/search',
  [body('query').notEmpty().trim(), validate],
  async (req, res, next) => {
    try {
      const result = await agentsService.researchSearch(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/sales/proposal/:leadId',
  async (req, res, next) => {
    try {
      const result = await agentsService.salesProposal(req.clientId, req.params.leadId);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/sales/generate',
  [
    body('lead_id').isUUID(),
    body('channel').isIn(['email', 'linkedin', 'instagram']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await agentsService.salesGenerate(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/ranger/review',
  [body('message_id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await agentsService.rangerReview(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/director/plan',
  [body('command').notEmpty().trim(), validate],
  async (req, res, next) => {
    try {
      const result = await agentsService.directorPlan(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.get('/director/brief',
  async (req, res, next) => {
    try {
      const result = await agentsService.directorBrief(req.clientId);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.get('/director/icp',
  async (req, res, next) => {
    try {
      const result = await agentsService.directorGetICP(req.clientId);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.put('/director/icp',
  [
    body('industries').optional().trim(),
    body('company_size').optional().trim(),
    body('geographies').optional().trim(),
    body('job_titles').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await agentsService.directorUpsertICP(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

router.post('/director/execute',
  [body('plan_id').isUUID(), body('command').optional().trim(), validate],
  async (req, res, next) => {
    try {
      const result = await agentsService.directorExecute(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

/* ─── Client Persona ─────────────────────────────────────── */

router.get('/persona', async (req, res, next) => {
  try {
    const result = await agentsService.getClientPersona(req.clientId);
    res.json({ data: result });
  } catch (err) { next(err); }
});

router.put('/persona',
  [
    body('company_name').optional().trim(),
    body('company_description').optional().trim(),
    body('value_proposition').optional().trim(),
    body('tone').optional().trim(),
    body('differentiator').optional().trim(),
    body('social_proof').optional().trim(),
    body('cta_preference').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const result = await agentsService.upsertClientPersona(req.clientId, req.body);
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

/* ─── Smart Actions ──────────────────────────────────────── */

const smartActions = require('../services/smartActions');

// GET /api/agents/smart-actions/:leadId — available actions for this lead's stage
router.get('/smart-actions/:leadId', async (req, res, next) => {
  try {
    const result = await smartActions.getAvailableActions(req.clientId, req.params.leadId);
    res.json({ data: result });
  } catch (err) { next(err); }
});

// GET /api/agents/smart-actions/:leadId/:briefType — fetch a generated brief
router.get('/smart-actions/:leadId/:briefType', async (req, res, next) => {
  try {
    const brief = await smartActions.getBrief(req.clientId, req.params.leadId, req.params.briefType);
    if (!brief) return res.status(404).json({ error: 'Brief not generated yet', code: 'NOT_FOUND' });
    res.json({ data: brief });
  } catch (err) { next(err); }
});

// POST /api/agents/smart-actions/:leadId/:briefType — generate a brief
router.post('/smart-actions/:leadId/:briefType',
  [body('notes').optional().trim(), validate],
  async (req, res, next) => {
    try {
      const { leadId, briefType } = req.params;
      const options = req.body.notes ? { notes: req.body.notes } : {};
      const content = await smartActions.generateBrief(req.clientId, leadId, briefType, options);
      res.json({ data: content });
    } catch (err) { next(err); }
  }
);

// PUT /api/agents/leads/:leadId/meeting-date — set meeting date
router.put('/leads/:leadId/meeting-date',
  [body('meeting_date').notEmpty(), validate],
  async (req, res, next) => {
    try {
      const pool2 = require('../db/pool');
      await pool2.query(
        `UPDATE leads SET meeting_date = $1, pipeline_stage = 'meeting_booked', updated_at = NOW()
         WHERE id = $2 AND client_id = $3`,
        [req.body.meeting_date, req.params.leadId, req.clientId]
      );
      res.json({ data: { updated: true } });
    } catch (err) { next(err); }
  }
);

/* ─── Memory ─────────────────────────────────────────────── */

const pool = require('../db/pool');

router.get('/memory', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, agent, memory_type, key, content, updated_at
       FROM agent_memory WHERE client_id = $1
       ORDER BY updated_at DESC`,
      [req.clientId]
    );
    res.json({ data: result.rows });
  } catch (err) { next(err); }
});

router.post('/memory/journal',
  [body('text').notEmpty().trim(), validate],
  async (req, res, next) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const content = JSON.stringify({ text: req.body.text, created_at: new Date().toISOString() });
      const result = await pool.query(
        `INSERT INTO agent_memory (client_id, agent, memory_type, key, content)
         VALUES ($1, 'system', 'journal', $2, $3)
         ON CONFLICT (client_id, agent, key)
         DO UPDATE SET content = agent_memory.content || $3::jsonb, updated_at = NOW()
         RETURNING *`,
        [req.clientId, today, content]
      );
      res.status(201).json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

router.delete('/memory/:id', async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM agent_memory WHERE id = $1 AND client_id = $2`,
      [req.params.id, req.clientId]
    );
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

module.exports = router;
