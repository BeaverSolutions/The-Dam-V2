'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const billing = require('../services/billing');

// GET /api/billing/summary — current tenant's trial, billing options, and ledger
router.get('/summary', async (req, res, next) => {
  try {
    const data = await billing.getBillingSummary(req.clientId);
    res.json({ data });
  } catch (err) { next(err); }
});

// POST /api/billing/upgrade-intent — tenant confirms manual-invoice intent
router.post('/upgrade-intent',
  [
    body('plan').isIn(['starter', 'growth', 'enterprise']),
    body('term').isIn(['monthly', 'six_months', 'annual']),
    body('notes').optional({ nullable: true }).trim().isLength({ max: 1000 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const intent = await billing.createBillingIntent(req.clientId, req.user.userId, req.body);
      const summary = await billing.getBillingSummary(req.clientId);
      res.status(201).json({ data: { intent, summary } });
    } catch (err) { next(err); }
  }
);

module.exports = router;
