'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const pool = require('../db/pool');
const logsService = require('../services/logs');

router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ce.*, l.name as lead_name, l.company as lead_company
       FROM calendar_events ce
       LEFT JOIN leads l ON l.id = ce.lead_id
       WHERE ce.client_id = $1
       ORDER BY ce.start_time ASC`,
      [req.clientId]
    );
    res.json({ data: result.rows, meta: { total: result.rows.length } });
  } catch (err) { next(err); }
});

router.post('/',
  [
    body('title').notEmpty().trim().isLength({ max: 300 }),
    body('start_time').isISO8601(),
    body('end_time').isISO8601(),
    body('lead_id').optional().isUUID(),
    body('description').optional().trim().isLength({ max: 2000 }),
    body('meeting_link').optional().trim().isLength({ max: 500 }),
    validate,
  ],
  async (req, res, next) => {
    try {
      const { title, description, start_time, end_time, lead_id, meeting_link } = req.body;
      const result = await pool.query(
        `INSERT INTO calendar_events (client_id, lead_id, title, description, start_time, end_time, meeting_link)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [req.clientId, lead_id || null, title, description, start_time, end_time, meeting_link]
      );

      await logsService.createLog(req.clientId, {
        agent: 'system',
        action: 'meeting_booked',
        target_type: 'calendar_event',
        target_id: result.rows[0].id,
        metadata: { title, start_time },
      });

      res.status(201).json({ data: result.rows[0] });
    } catch (err) { next(err); }
  }
);

module.exports = router;
