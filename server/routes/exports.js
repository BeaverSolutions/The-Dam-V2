'use strict';

const express = require('express');
const router = express.Router();
const { buildDatabaseWorkbook } = require('../services/databaseExport');

router.get('/database.xlsx', async (req, res, next) => {
  try {
    const exportFile = await buildDatabaseWorkbook(req.clientId);
    res.setHeader('Content-Type', exportFile.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exportFile.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', exportFile.buffer.length);
    res.send(exportFile.buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
