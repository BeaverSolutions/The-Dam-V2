'use strict';

const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const logsService = require('./logs');

const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOWNLOAD_PATH = '/api/exports/database.xlsx';

function fmt(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function safeSlug(value) {
  return String(value || 'beavrdam')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'beavrdam';
}

function addSheet(workbook, name, columns, rows) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.columns = columns.map(col => ({
    header: col.header,
    key: col.key,
    width: col.width || 18,
  }));
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).alignment = { vertical: 'middle' };
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of rows) {
    const formatted = {};
    for (const col of columns) formatted[col.key] = fmt(row[col.key]);
    worksheet.addRow(formatted);
  }

  worksheet.eachRow(row => {
    row.eachCell(cell => {
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  });
}

async function loadExportData(clientId) {
  const [
    clientRes,
    leadsRes,
    messagesRes,
    approvalsRes,
    kpiRes,
    memoryRes,
    sendQueueRes,
  ] = await Promise.all([
    pool.query(
      `SELECT id, name, slug, created_at
       FROM clients
       WHERE id = $1
       LIMIT 1`,
      [clientId]
    ),
    pool.query(
      `SELECT
         id, created_at, updated_at, name, company, title, email, email_verified,
         email_source, linkedin_url, source, signal_tier, lead_tier,
         buying_signal_strength, signal_dated_at, status, pipeline_stage, score,
         country, vertical, company_size, first_contacted_at, next_followup_at,
         last_reply_at, meeting_date, meeting_notes,
         metadata->>'signal' AS signal,
         metadata->>'why_now' AS why_now,
         metadata->>'angle' AS angle,
         metadata->>'friction' AS friction,
         metadata AS metadata
       FROM leads
       WHERE client_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [clientId]
    ),
    pool.query(
      `SELECT
         m.id, m.created_at, m.updated_at, m.sent_at, l.name AS lead_name,
         l.company AS lead_company, m.channel, m.subject, m.body, m.status,
         m.ranger_score, m.ranger_notes, m.revision_count, m.follow_up_day,
         m.gmail_thread_id, m.agentmail_thread_id, m.reply_detected_at,
         m.reply_snippet, m.metadata
       FROM messages m
       JOIN leads l ON l.id = m.lead_id AND l.client_id = m.client_id
       WHERE m.client_id = $1
       ORDER BY m.created_at DESC`,
      [clientId]
    ),
    pool.query(
      `SELECT
         a.id, a.created_at, a.resolved_at, a.requested_by, a.status, a.notes,
         l.name AS lead_name, l.company AS lead_company, m.channel, m.subject,
         m.ranger_score, m.status AS message_status
       FROM approvals a
       JOIN messages m ON m.id = a.message_id AND m.client_id = a.client_id
       JOIN leads l ON l.id = m.lead_id AND l.client_id = m.client_id
       WHERE a.client_id = $1
       ORDER BY a.created_at DESC`,
      [clientId]
    ),
    pool.query(
      `SELECT
         date, target, target_email_sent, target_linkedin_sent, outreach_sent,
         outreach_email, outreach_linkedin, leads_found, replies_received,
         meetings_booked, kpi_met, created_at, updated_at
       FROM daily_kpi
       WHERE client_id = $1
       ORDER BY date DESC`,
      [clientId]
    ),
    pool.query(
      `SELECT created_at, updated_at, agent, memory_type, key, content
       FROM agent_memory
       WHERE client_id = $1 AND memory_type <> 'secret'
       ORDER BY updated_at DESC`,
      [clientId]
    ),
    pool.query(
      `SELECT
         sq.id, sq.created_at, sq.updated_at, sq.status, sq.attempt_count,
         sq.last_attempted_at, sq.next_retry_at, sq.error_reason,
         l.name AS lead_name, l.company AS lead_company, m.channel, m.subject
       FROM send_queue sq
       JOIN messages m ON m.id = sq.message_id AND m.client_id = sq.client_id
       JOIN leads l ON l.id = m.lead_id AND l.client_id = m.client_id
       WHERE sq.client_id = $1
       ORDER BY sq.created_at DESC`,
      [clientId]
    ),
  ]);

  return {
    client: clientRes.rows[0] || { id: clientId, name: 'BeavrDam Client', slug: 'beavrdam' },
    leads: leadsRes.rows,
    messages: messagesRes.rows,
    approvals: approvalsRes.rows,
    dailyKpi: kpiRes.rows,
    memory: memoryRes.rows,
    sendQueue: sendQueueRes.rows,
  };
}

async function buildDatabaseWorkbook(clientId) {
  const data = await loadExportData(clientId);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BeavrDam';
  workbook.created = new Date();
  workbook.modified = new Date();

  addSheet(workbook, 'Export Info', [
    { header: 'Field', key: 'field', width: 24 },
    { header: 'Value', key: 'value', width: 64 },
  ], [
    { field: 'Client', value: data.client.name },
    { field: 'Client slug', value: data.client.slug },
    { field: 'Generated at', value: new Date().toISOString() },
    { field: 'Leads', value: data.leads.length },
    { field: 'Messages', value: data.messages.length },
    { field: 'Approvals', value: data.approvals.length },
    { field: 'Daily KPI rows', value: data.dailyKpi.length },
    { field: 'Agent memory rows', value: data.memory.length },
    { field: 'Send queue rows', value: data.sendQueue.length },
    { field: 'Security note', value: 'Authenticated tenant export. Secret memory rows are excluded.' },
  ]);

  addSheet(workbook, 'Leads', [
    { header: 'Lead ID', key: 'id', width: 38 },
    { header: 'Created', key: 'created_at', width: 24 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Company', key: 'company', width: 28 },
    { header: 'Title', key: 'title', width: 28 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Email verified', key: 'email_verified', width: 16 },
    { header: 'Email source', key: 'email_source', width: 18 },
    { header: 'LinkedIn', key: 'linkedin_url', width: 42 },
    { header: 'Tier', key: 'lead_tier', width: 10 },
    { header: 'Signal tier', key: 'signal_tier', width: 12 },
    { header: 'Signal strength', key: 'buying_signal_strength', width: 18 },
    { header: 'Signal date', key: 'signal_dated_at', width: 20 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Pipeline stage', key: 'pipeline_stage', width: 20 },
    { header: 'Score', key: 'score', width: 10 },
    { header: 'Country', key: 'country', width: 12 },
    { header: 'Vertical', key: 'vertical', width: 18 },
    { header: 'Company size', key: 'company_size', width: 16 },
    { header: 'First contacted', key: 'first_contacted_at', width: 24 },
    { header: 'Next follow-up', key: 'next_followup_at', width: 24 },
    { header: 'Last reply', key: 'last_reply_at', width: 24 },
    { header: 'Meeting date', key: 'meeting_date', width: 24 },
    { header: 'Signal', key: 'signal', width: 36 },
    { header: 'Why now', key: 'why_now', width: 36 },
    { header: 'Angle', key: 'angle', width: 36 },
    { header: 'Friction', key: 'friction', width: 36 },
    { header: 'Metadata', key: 'metadata', width: 60 },
  ], data.leads);

  addSheet(workbook, 'Messages', [
    { header: 'Message ID', key: 'id', width: 38 },
    { header: 'Created', key: 'created_at', width: 24 },
    { header: 'Sent', key: 'sent_at', width: 24 },
    { header: 'Lead', key: 'lead_name', width: 24 },
    { header: 'Company', key: 'lead_company', width: 28 },
    { header: 'Channel', key: 'channel', width: 12 },
    { header: 'Subject', key: 'subject', width: 40 },
    { header: 'Body', key: 'body', width: 70 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Enforcer score', key: 'ranger_score', width: 16 },
    { header: 'Enforcer notes', key: 'ranger_notes', width: 50 },
    { header: 'Follow-up day', key: 'follow_up_day', width: 14 },
    { header: 'Gmail thread', key: 'gmail_thread_id', width: 28 },
    { header: 'AgentMail thread', key: 'agentmail_thread_id', width: 28 },
    { header: 'Reply detected', key: 'reply_detected_at', width: 24 },
    { header: 'Reply snippet', key: 'reply_snippet', width: 50 },
    { header: 'Metadata', key: 'metadata', width: 60 },
  ], data.messages);

  addSheet(workbook, 'Approvals', [
    { header: 'Approval ID', key: 'id', width: 38 },
    { header: 'Created', key: 'created_at', width: 24 },
    { header: 'Resolved', key: 'resolved_at', width: 24 },
    { header: 'Requested by', key: 'requested_by', width: 20 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Lead', key: 'lead_name', width: 24 },
    { header: 'Company', key: 'lead_company', width: 28 },
    { header: 'Channel', key: 'channel', width: 12 },
    { header: 'Subject', key: 'subject', width: 40 },
    { header: 'Enforcer score', key: 'ranger_score', width: 16 },
    { header: 'Message status', key: 'message_status', width: 18 },
    { header: 'Notes', key: 'notes', width: 50 },
  ], data.approvals);

  addSheet(workbook, 'Daily KPI', [
    { header: 'Date', key: 'date', width: 16 },
    { header: 'Target', key: 'target', width: 10 },
    { header: 'Email target', key: 'target_email_sent', width: 14 },
    { header: 'LinkedIn target', key: 'target_linkedin_sent', width: 16 },
    { header: 'Outreach sent', key: 'outreach_sent', width: 14 },
    { header: 'Email sent', key: 'outreach_email', width: 14 },
    { header: 'LinkedIn sent', key: 'outreach_linkedin', width: 16 },
    { header: 'Leads found', key: 'leads_found', width: 14 },
    { header: 'Replies', key: 'replies_received', width: 12 },
    { header: 'Meetings', key: 'meetings_booked', width: 12 },
    { header: 'KPI met', key: 'kpi_met', width: 12 },
  ], data.dailyKpi);

  addSheet(workbook, 'Agent Memory', [
    { header: 'Created', key: 'created_at', width: 24 },
    { header: 'Updated', key: 'updated_at', width: 24 },
    { header: 'Agent', key: 'agent', width: 20 },
    { header: 'Type', key: 'memory_type', width: 16 },
    { header: 'Key', key: 'key', width: 30 },
    { header: 'Content', key: 'content', width: 80 },
  ], data.memory);

  addSheet(workbook, 'Send Queue', [
    { header: 'Queue ID', key: 'id', width: 38 },
    { header: 'Created', key: 'created_at', width: 24 },
    { header: 'Updated', key: 'updated_at', width: 24 },
    { header: 'Lead', key: 'lead_name', width: 24 },
    { header: 'Company', key: 'lead_company', width: 28 },
    { header: 'Channel', key: 'channel', width: 12 },
    { header: 'Subject', key: 'subject', width: 40 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Attempts', key: 'attempt_count', width: 12 },
    { header: 'Last attempted', key: 'last_attempted_at', width: 24 },
    { header: 'Next retry', key: 'next_retry_at', width: 24 },
    { header: 'Error', key: 'error_reason', width: 50 },
  ], data.sendQueue);

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `${safeSlug(data.client.slug || data.client.name)}-beavrdam-database.xlsx`;

  return {
    filename,
    contentType: CONTENT_TYPE,
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    counts: {
      leads: data.leads.length,
      messages: data.messages.length,
      approvals: data.approvals.length,
      daily_kpi: data.dailyKpi.length,
      agent_memory: data.memory.length,
      send_queue: data.sendQueue.length,
    },
  };
}

async function getDatabaseExportSummary(clientId) {
  const { rows: [client] } = await pool.query(
    `SELECT name, slug FROM clients WHERE id = $1 LIMIT 1`,
    [clientId]
  );
  const [
    leads,
    messages,
    approvals,
    dailyKpi,
    memory,
    sendQueue,
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM leads WHERE client_id = $1 AND deleted_at IS NULL`, [clientId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM messages WHERE client_id = $1`, [clientId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM approvals WHERE client_id = $1`, [clientId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM daily_kpi WHERE client_id = $1`, [clientId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM agent_memory WHERE client_id = $1 AND memory_type <> 'secret'`, [clientId]),
    pool.query(`SELECT COUNT(*)::int AS count FROM send_queue WHERE client_id = $1`, [clientId]),
  ]);

  const filename = `${safeSlug(client?.slug || client?.name)}-beavrdam-database.xlsx`;
  const counts = {
    leads: leads.rows[0].count,
    messages: messages.rows[0].count,
    approvals: approvals.rows[0].count,
    daily_kpi: dailyKpi.rows[0].count,
    agent_memory: memory.rows[0].count,
    send_queue: sendQueue.rows[0].count,
  };

  await logsService.createLog(clientId, {
    agent: 'captain_beaver',
    action: 'database_export_requested',
    target_type: 'client',
    metadata: { filename, counts, format: 'xlsx' },
  }).catch(() => {});

  return {
    ok: true,
    format: 'xlsx',
    filename,
    download_url: DOWNLOAD_PATH,
    counts,
    message: `Database export ready: ${DOWNLOAD_PATH}`,
  };
}

module.exports = {
  CONTENT_TYPE,
  DOWNLOAD_PATH,
  buildDatabaseWorkbook,
  getDatabaseExportSummary,
};
