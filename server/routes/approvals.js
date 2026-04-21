'use strict';

const router = require('express').Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const approvalsService = require('../services/approvals');

router.get('/', async (req, res, next) => {
  try {
    const result = await approvalsService.getApprovals(
      req.clientId,
      { status: req.query.status || 'pending', excludeLinkedin: req.query.excludeLinkedin === '1' },
      { page: parseInt(req.query.page, 10) || 1, perPage: parseInt(req.query.perPage, 10) || 20 }
    );
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/',
  [
    body('message_id').isUUID(),
    body('requested_by').notEmpty().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const approval = await approvalsService.createApproval(req.clientId, req.body);
      res.status(201).json({ data: approval });
    } catch (err) { next(err); }
  }
);

router.put('/:id',
  [
    param('id').isUUID(),
    body('status').isIn(['approved', 'rejected']),
    body('notes').optional().trim(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const approval = await approvalsService.resolveApproval(req.clientId, req.params.id, {
        ...req.body,
        userId: req.user.userId,
      });
      res.json({ data: approval });
    } catch (err) { next(err); }
  }
);

// ─── LinkedIn connection tracking ─────────────────────────────────────────

// Mark connection request as sent (pending_approval → linkedin_requested)
router.post('/:id/connection-sent',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await approvalsService.markConnectionSent(req.clientId, req.params.id, {
        userId: req.user.userId,
      });
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

// Mark connection as accepted + message sent (linkedin_requested → sent)
router.post('/:id/connection-accepted',
  [param('id').isUUID(), validate],
  async (req, res, next) => {
    try {
      const result = await approvalsService.markConnectionAccepted(req.clientId, req.params.id, {
        userId: req.user.userId,
      });
      res.json({ data: result });
    } catch (err) { next(err); }
  }
);

module.exports = router;
