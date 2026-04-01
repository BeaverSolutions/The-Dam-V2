'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const messagesService = require('../services/messages');

router.get('/', async (req, res, next) => {
  try {
    const result = await messagesService.getMessages(
      req.clientId,
      { status: req.query.status, lead_id: req.query.lead_id },
      { page: parseInt(req.query.page, 10) || 1, perPage: parseInt(req.query.perPage, 10) || 20 }
    );
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/',
  [
    body('lead_id').isUUID(),
    body('channel').isIn(['email', 'linkedin', 'instagram']),
    body('body').notEmpty(),
    body('subject').optional().isLength({ max: 500 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const message = await messagesService.createMessage(req.clientId, req.body);
      res.status(201).json({ data: message });
    } catch (err) { next(err); }
  }
);

router.get('/:id', async (req, res, next) => {
  try {
    const message = await messagesService.getMessage(req.clientId, req.params.id);
    res.json({ data: message });
  } catch (err) { next(err); }
});

router.put('/:id',
  [
    body('status').optional().isIn(['draft', 'pending_ranger', 'ranger_rejected', 'pending_approval', 'approved', 'sent', 'failed']),
    body('body').optional().notEmpty(),
    validate,
  ],
  async (req, res, next) => {
    try {
      const message = await messagesService.updateMessage(req.clientId, req.params.id, req.body);
      res.json({ data: message });
    } catch (err) { next(err); }
  }
);

module.exports = router;
