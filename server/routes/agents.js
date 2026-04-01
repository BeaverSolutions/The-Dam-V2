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

module.exports = router;
