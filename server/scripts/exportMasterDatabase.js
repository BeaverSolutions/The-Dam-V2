#!/usr/bin/env node
'use strict';

/**
 * Export master database — combines all client leads into one .xlsx file.
 * This is our in-house database bank built over time.
 *
 * Usage:
 *   node server/scripts/exportMasterDatabase.js
 *
 * Output:
 *   output/master-database.xlsx
 *
 * Requires:
 *   npm install exceljs
 *
 * Schedule: Run weekly (Sunday night or Monday morning)
 */

require('dotenv').config();
const path = require('path');
const pool = require('../db/pool');

let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch {
  console.error('ExcelJS not installed. Run: npm install exceljs');
  process.exit(1);
}

// Output dir is overridable via MASTER_EXPORT_DIR so the weekly scheduled
// export can land straight in the Beaver Solutions folder. Filename is
// date-stamped so weekly runs accumulate instead of overwriting.
const OUTPUT_DIR = process.env.MASTER_EXPORT_DIR || path.join(__dirname, '../../output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, `master-database-${new Date().toISOString().slice(0, 10)}.xlsx`);

// Theme colours
const BG     = 'FF060A0F';
const PANEL  = 'FF0D1420';
const LIME   = 'FFC8FF00';
const BLUE   = 'FF00B4FF';
const ORANGE = 'FFFF8C00';
const PURPLE = 'FFA855F7';
const TEXT   = 'FFE2E8F0';
const MUTED  = 'FF94A3B8';
const HEADER_BG = 'FF1E293B';

function bgFill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function rowBg(rowNumber) {
  return rowNumber % 2 === 0 ? PANEL : BG;
}

function fmt(val) {
  if (val == null) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 16).replace('T', ' ');
  return String(val);
}

function styleHeader(sheet) {
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = bgFill(HEADER_BG);
    cell.font = { name: 'Arial', color: { argb: LIME }, size: 10, bold: true };
    cell.border = { bottom: { style: 'medium', color: { argb: LIME } } };
    cell.alignment = { vertical: 'middle' };
  });
  headerRow.height = 24;
  headerRow.commit();
}

function styleDataRow(row, r) {
  row.eachCell(cell => {
    cell.fill = bgFill(rowBg(r));
    cell.font = { name: 'Arial', color: { argb: TEXT }, size: 9 };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF1E293B' } } };
  });
}

async function exportMaster() {
  console.log('[master-export] Starting master database export...\n');

  // ── 1. Pull all clients ──────────────────────────────────────
  const clientsRes = await pool.query(
    `SELECT id, name, slug FROM clients WHERE slug IS NOT NULL ORDER BY name`
  );
  const clients = clientsRes.rows;
  const clientMap = {};
  clients.forEach(c => { clientMap[c.id] = c; });
  console.log(`[master-export] Clients: ${clients.map(c => c.name).join(', ')}`);

  // ── 2. Pull ALL leads across all clients ─────────────────────
  const leadsRes = await pool.query(`
    SELECT
      l.client_id,
      l.created_at, l.name, l.company, l.title, l.email,
      l.signal_tier, l.status, l.score, l.pipeline_stage, l.source,
      l.email_verified, l.linkedin_url,
      l.metadata->>'signal' AS signal,
      l.metadata->>'angle' AS angle,
      l.metadata->>'friction' AS friction,
      l.metadata->>'why_now' AS why_now,
      l.metadata->>'data_source' AS data_source,
      l.metadata->>'short_description' AS notes,
      l.first_contacted_at,
      l.sequence_touch,
      l.updated_at
    FROM leads l
    WHERE l.deleted_at IS NULL
    ORDER BY l.created_at DESC
  `);

  // ── 3. Pull ALL messages across all clients ──────────────────
  const msgsRes = await pool.query(`
    SELECT
      m.client_id,
      m.created_at, l.name AS lead_name, l.company,
      m.channel, m.subject, LEFT(m.body, 120) AS body_preview,
      m.ranger_score, m.status, m.ranger_notes,
      m.sent_at, m.gmail_thread_id,
      CASE WHEN m.reply_detected_at IS NOT NULL THEN 'Yes' ELSE 'No' END AS reply_detected
    FROM messages m
    JOIN leads l ON l.id = m.lead_id
    ORDER BY m.created_at DESC
  `);

  // ── 4. Pull signal hunt logs ─────────────────────────────────
  const signalLogsRes = await pool.query(`
    SELECT
      client_id, created_at, agent, action,
      metadata->>'queries_used' AS queries_used,
      metadata->>'signals_found' AS signals_found,
      metadata->>'signal_types' AS signal_types,
      metadata
    FROM logs
    WHERE action = 'signal_search'
    ORDER BY created_at DESC
    LIMIT 200
  `);

  // ── 5. Pull pipeline summary per client ──────────────────────
  const pipelineRes = await pool.query(`
    SELECT
      client_id,
      COUNT(*) AS total_leads,
      COUNT(*) FILTER (WHERE pipeline_stage = 'qualified') AS qualified,
      COUNT(*) FILTER (WHERE pipeline_stage = 'contacted') AS contacted,
      COUNT(*) FILTER (WHERE pipeline_stage = 'replied') AS replied,
      COUNT(*) FILTER (WHERE pipeline_stage = 'meeting_booked') AS meetings,
      COUNT(*) FILTER (WHERE signal_tier = 'P1') AS p1_leads,
      COUNT(*) FILTER (WHERE signal_tier = 'P2') AS p2_leads,
      COUNT(*) FILTER (WHERE signal_tier = 'P3') AS p3_leads
    FROM leads
    WHERE deleted_at IS NULL
    GROUP BY client_id
  `);

  console.log(`[master-export] Total leads: ${leadsRes.rows.length}, Messages: ${msgsRes.rows.length}`);

  // ── 6. Build workbook ────────────────────────────────────────
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BeavrDam';
  workbook.created = new Date();

  // ── Sheet 1: All Leads (master database bank) ────────────────
  const leadsSheet = workbook.addWorksheet('All Leads', {
    properties: { tabColor: { argb: BLUE.slice(2) } },
  });
  leadsSheet.columns = [
    { header: 'Client', key: 'client', width: 18 },
    { header: 'Created', key: 'created_at', width: 16 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Company', key: 'company', width: 24 },
    { header: 'Title', key: 'title', width: 22 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'LinkedIn', key: 'linkedin_url', width: 32 },
    { header: 'Signal Tier', key: 'signal_tier', width: 10 },
    { header: 'Signal', key: 'signal', width: 30 },
    { header: 'Angle', key: 'angle', width: 30 },
    { header: 'Why Now', key: 'why_now', width: 30 },
    { header: 'Friction', key: 'friction', width: 25 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Pipeline', key: 'pipeline_stage', width: 14 },
    { header: 'Score', key: 'score', width: 8 },
    { header: 'Source', key: 'source', width: 12 },
    { header: 'Data Source', key: 'data_source', width: 12 },
    { header: 'Email Verified', key: 'email_verified', width: 12 },
    { header: 'First Contact', key: 'first_contacted_at', width: 16 },
    { header: 'Touches', key: 'sequence_touch', width: 8 },
    { header: 'Notes', key: 'notes', width: 30 },
    { header: 'Updated', key: 'updated_at', width: 16 },
  ];
  styleHeader(leadsSheet);

  leadsRes.rows.forEach((lead, idx) => {
    const r = idx + 2;
    const client = clientMap[lead.client_id];
    const row = leadsSheet.getRow(r);
    row.values = [
      client?.name || 'Unknown',
      fmt(lead.created_at), lead.name, lead.company, lead.title,
      lead.email, lead.linkedin_url,
      lead.signal_tier, lead.signal || '', lead.angle || '',
      lead.why_now || '', lead.friction || '',
      lead.status, lead.pipeline_stage, lead.score,
      lead.source, lead.data_source || '',
      lead.email_verified ? 'Yes' : 'No',
      fmt(lead.first_contacted_at), lead.sequence_touch || 0,
      lead.notes || '', fmt(lead.updated_at),
    ];

    // Colour signal tier
    const tierCell = row.getCell(8);
    const tierColors = { P1: LIME, P2: BLUE, P3: ORANGE };
    if (tierColors[lead.signal_tier]) {
      tierCell.font = { name: 'Arial', color: { argb: tierColors[lead.signal_tier] }, bold: true, size: 9 };
    }

    styleDataRow(row, r);
    row.commit();
  });

  // Auto-filter on leads sheet
  leadsSheet.autoFilter = { from: 'A1', to: `V1` };

  // ── Sheet 2: All Messages ────────────────────────────────────
  const msgsSheet = workbook.addWorksheet('All Messages', {
    properties: { tabColor: { argb: ORANGE.slice(2) } },
  });
  msgsSheet.columns = [
    { header: 'Client', key: 'client', width: 18 },
    { header: 'Created', key: 'created_at', width: 16 },
    { header: 'Lead', key: 'lead_name', width: 20 },
    { header: 'Company', key: 'company', width: 22 },
    { header: 'Channel', key: 'channel', width: 10 },
    { header: 'Subject', key: 'subject', width: 30 },
    { header: 'Body Preview', key: 'body_preview', width: 40 },
    { header: 'Ranger Score', key: 'ranger_score', width: 12 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Ranger Notes', key: 'ranger_notes', width: 30 },
    { header: 'Sent At', key: 'sent_at', width: 16 },
    { header: 'Thread ID', key: 'gmail_thread_id', width: 18 },
    { header: 'Reply?', key: 'reply_detected', width: 8 },
  ];
  styleHeader(msgsSheet);

  msgsRes.rows.forEach((msg, idx) => {
    const r = idx + 2;
    const client = clientMap[msg.client_id];
    const row = msgsSheet.getRow(r);
    row.values = [
      client?.name || 'Unknown',
      fmt(msg.created_at), msg.lead_name, msg.company,
      msg.channel, msg.subject, msg.body_preview,
      msg.ranger_score, msg.status, msg.ranger_notes,
      fmt(msg.sent_at), msg.gmail_thread_id, msg.reply_detected,
    ];

    const statusCell = row.getCell(9);
    const statusColors = { sent: LIME, pending_approval: BLUE, ranger_rejected: ORANGE, failed: 'FFFF4444' };
    if (statusColors[msg.status]) {
      statusCell.font = { name: 'Arial', color: { argb: statusColors[msg.status] }, bold: true, size: 9 };
    }

    styleDataRow(row, r);
    row.commit();
  });

  msgsSheet.autoFilter = { from: 'A1', to: `M1` };

  // ── Sheet 3: Pipeline Summary ────────────────────────────────
  const summarySheet = workbook.addWorksheet('Pipeline Summary', {
    properties: { tabColor: { argb: PURPLE.slice(2) } },
  });
  summarySheet.columns = [
    { header: 'Client', key: 'client', width: 22 },
    { header: 'Total Leads', key: 'total', width: 12 },
    { header: 'P1', key: 'p1', width: 8 },
    { header: 'P2', key: 'p2', width: 8 },
    { header: 'P3', key: 'p3', width: 8 },
    { header: 'Qualified', key: 'qualified', width: 12 },
    { header: 'Contacted', key: 'contacted', width: 12 },
    { header: 'Replied', key: 'replied', width: 10 },
    { header: 'Meetings', key: 'meetings', width: 10 },
    { header: 'Reply Rate', key: 'reply_rate', width: 12 },
  ];
  styleHeader(summarySheet);

  pipelineRes.rows.forEach((p, idx) => {
    const r = idx + 2;
    const client = clientMap[p.client_id];
    const row = summarySheet.getRow(r);
    const contacted = parseInt(p.contacted, 10) || 0;
    const replied = parseInt(p.replied, 10) || 0;
    row.values = [
      client?.name || 'Unknown',
      parseInt(p.total_leads, 10) || 0,
      parseInt(p.p1_leads, 10) || 0,
      parseInt(p.p2_leads, 10) || 0,
      parseInt(p.p3_leads, 10) || 0,
      parseInt(p.qualified, 10) || 0,
      contacted,
      replied,
      parseInt(p.meetings, 10) || 0,
      contacted > 0 ? `${((replied / contacted) * 100).toFixed(1)}%` : '-',
    ];
    styleDataRow(row, r);
    row.commit();
  });

  // ── Sheet 4: Signal Hunt Log ─────────────────────────────────
  const signalSheet = workbook.addWorksheet('Signal Hunts', {
    properties: { tabColor: { argb: LIME.slice(2) } },
  });
  signalSheet.columns = [
    { header: 'Client', key: 'client', width: 18 },
    { header: 'Date', key: 'created_at', width: 16 },
    { header: 'Agent', key: 'agent', width: 16 },
    { header: 'Queries Used', key: 'queries_used', width: 12 },
    { header: 'Signals Found', key: 'signals_found', width: 14 },
    { header: 'Signal Types', key: 'signal_types', width: 30 },
  ];
  styleHeader(signalSheet);

  signalLogsRes.rows.forEach((log, idx) => {
    const r = idx + 2;
    const client = clientMap[log.client_id];
    const row = signalSheet.getRow(r);
    row.values = [
      client?.name || 'Unknown',
      fmt(log.created_at), log.agent,
      log.queries_used || '0', log.signals_found || '0',
      log.signal_types || '',
    ];
    styleDataRow(row, r);
    row.commit();
  });

  // ── Sheet 5: Export Meta ─────────────────────────────────────
  const metaSheet = workbook.addWorksheet('Export Info', {
    properties: { tabColor: { argb: MUTED.slice(2) } },
  });
  metaSheet.columns = [
    { header: 'Field', key: 'field', width: 20 },
    { header: 'Value', key: 'value', width: 40 },
  ];
  styleHeader(metaSheet);

  const metaRows = [
    ['Export Date', new Date().toISOString().slice(0, 19).replace('T', ' ')],
    ['Total Leads', leadsRes.rows.length],
    ['Total Messages', msgsRes.rows.length],
    ['Clients', clients.map(c => c.name).join(', ')],
    ['Generated By', 'BeavrDam Master Export'],
    ['Next Update', 'Weekly (automated)'],
  ];
  metaRows.forEach((m, idx) => {
    const r = idx + 2;
    const row = metaSheet.getRow(r);
    row.values = m;
    styleDataRow(row, r);
    row.commit();
  });

  // ── 7. Save ──────────────────────────────────────────────────
  // Ensure output directory exists
  const fs = require('fs');
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  await workbook.xlsx.writeFile(OUTPUT_FILE);
  console.log(`\n[master-export] ✓ Saved: ${OUTPUT_FILE}`);
  console.log(`[master-export]   Leads: ${leadsRes.rows.length}`);
  console.log(`[master-export]   Messages: ${msgsRes.rows.length}`);
  console.log(`[master-export]   Clients: ${clients.length}`);
}

async function main() {
  try {
    await exportMaster();
  } catch (err) {
    console.error('[master-export] Error:', err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
}

main();
