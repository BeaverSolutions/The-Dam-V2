'use strict';

const router = require('express').Router();
const { body, query, param } = require('express-validator');
const validate = require('../middleware/validate');
const leadsService = require('../services/leads');

// GET /api/leads
router.get('/', async (req, res, next) => {
  try {
    const result = await leadsService.getLeads(
      req.clientId,
      {
        status: req.query.status,
        signal_tier: req.query.signal_tier,
        source: req.query.source,
        pipeline_stage: req.query.pipeline_stage,
        search: req.query.search,
      },
      { page: parseInt(req.query.page, 10) || 1, perPage: parseInt(req.query.perPage, 10) || 20 }
    );
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/leads
router.post('/',
  [
    body('name').trim().isLength({ min: 1, max: 200 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('company').optional().trim().isLength({ max: 200 }),
    body('signal_tier').optional().isIn(['P1', 'P2', 'P3']),
    body('status').optional().isIn(['new', 'contacted', 'replied', 'meeting_booked', 'closed_won', 'closed_lost']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const lead = await leadsService.createLead(req.clientId, req.body);
      res.status(201).json({ data: lead });
    } catch (err) { next(err); }
  }
);

// GET /api/leads/:id
router.get('/:id', async (req, res, next) => {
  try {
    const lead = await leadsService.getLead(req.clientId, req.params.id);
    res.json({ data: lead });
  } catch (err) { next(err); }
});

// PUT /api/leads/:id
router.put('/:id',
  [
    body('name').optional().trim().isLength({ min: 1, max: 200 }),
    body('email').optional().isEmail().normalizeEmail(),
    body('signal_tier').optional().isIn(['P1', 'P2', 'P3']),
    body('status').optional().isIn(['new', 'contacted', 'replied', 'meeting_booked', 'closed_won', 'closed_lost']),
    validate,
  ],
  async (req, res, next) => {
    try {
      const lead = await leadsService.updateLead(req.clientId, req.params.id, req.body);
      res.json({ data: lead });
    } catch (err) { next(err); }
  }
);

// DELETE /api/leads/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await leadsService.deleteLead(req.clientId, req.params.id);
    res.json({ data: { deleted: true } });
  } catch (err) { next(err); }
});

module.exports = router;
