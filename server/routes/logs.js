'use strict';

const router = require('express').Router();
const logsService = require('../services/logs');

// GET /api/logs
router.get('/', async (req, res, next) => {
  try {
    const result = await logsService.getLogs(
      req.clientId,
      {
        agent: req.query.agent,
        action: req.query.action,
        target_type: req.query.target_type,
        date_from: req.query.date_from,
        date_to: req.query.date_to,
      },
      { page: parseInt(req.query.page, 10) || 1, perPage: parseInt(req.query.perPage, 10) || 50 }
    );
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
