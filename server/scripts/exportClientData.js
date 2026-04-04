#!/usr/bin/env node
'use strict';

/**
 * Export client data from Supabase into the client's Excel tracker.
 *
 * Usage:
 *   node server/scripts/exportClientData.js <client-slug>
 *   node server/scripts/exportClientData.js beaver-solutions
 *   node server/scripts/exportClientData.js all
 *
 * Requires:
 *   npm install exceljs   (run once from project root)
 *
 * What it does:
 *   1. Finds the client by slug in the DB
 *   2. Pulls all leads, messages, agent_memory, weekly_learnings
 *   3. Opens clients/<slug>/<slug>-tracker.xlsx
 *   4. Populates the Leads, Messages, Weekly KPIs, Agent Memory sheets
 *   5. Saves the file back
 */

require('dotenv').config();
const path = require('path');
const pool = require('../db/pool');

// Try to load ExcelJS — install it if missing
let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch {
  console.error('ExcelJS not installed. Run: npm install exceljs');
  process.exit(1);
}

const CLIENTS_DIR = path.join(__dirname, '../../clients');

const BG    = 'FF060A0F';
const PANEL = 'FF0D1420';
const LIME  = 'FFC8FF00';
const BLUE  = 'FF00B4FF';
const ORANGE= 'FFFF8C00';
const PURPLE= 'FFA855F7';
const TEXT  = 'FFE2E8F0';
const MUTED = 'FF94A3B8';

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

async function exportClient(slug) {
  console.log(`\n[export] Starting export for: ${slug}`);

  // ── 1. Find client ───────────────────────────────────────────
  const clientRes = await pool.query(
    `SELECT id, name, slug FROM clients WHERE slug = $1`, [slug]
  );
  if (clientRes.rows.length === 0) {
    console.error(`[export] Client not found: ${slug}`);
    return;
  }
  const client = clientRes.rows[0];
  const cid = client.id;
  console.log(`[export] Client: ${client.name} (${cid})`);

  // ── 2. Pull data ─────────────────────────────────────────────
  const [leadsRes, msgsRes, memRes, kpiRes] = await Promise.all([
    pool.query(`
      SELECT
        created_at, name, company, title, email,
        signal_tier, status, score, pipeline_stage, source,
        apollo_enriched, email_verified, linkedin_url,
        metadata->>'short_description' AS notes
      FROM leads
      WHERE client_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC
    `, [cid]),

    pool.query(`
      SELECT
        m.created_at, l.name AS lead_name, l.company,
        m.channel, m.subject, LEFT(m.body, 120) AS body_preview,
        m.ranger_score, m.status, m.ranger_notes,
        m.sent_at, m.gmail_thread_id,
        CASE WHEN m.reply_detected_at IS NOT NULL THEN 'Yes' ELSE 'No' END AS reply_detected
      FROM messages m
      JOIN leads l ON l.id = m.lead_id
      WHERE m.client_id = $1
      ORDER BY m.created_at DESC
    `, [cid]),

    pool.query(`
      SELECT created_at, agent, memory_type, key,
             content::text AS summary, updated_at
      FROM agent_memory
      WHERE client_id = $1
      ORDER BY updated_at DESC
    `, [cid]),

    pool.query(`
      SELECT date, leads_found, outreach_sent AS emails_sent,
             replies_received AS replies, meetings_booked,
             outreach_linkedin, outreach_email
      FROM daily_kpi
      WHERE client_id = $1
      ORDER BY date DESC
      LIMIT 52
    `, [cid]),
  ]);

  console.log(`[export] Leads: ${leadsRes.rows.length}, Messages: ${msgsRes.rows.length}, Memory: ${memRes.rows.length}, KPI rows: ${kpiRes.rows.length}`);

  // ── 3. Open workbook ─────────────────────────────────────────
  const xlsxPath = path.join(CLIENTS_DIR, slug, `${slug}-tracker.xlsx`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  // ── 4. Populate Leads sheet ──────────────────────────────────
  const leadsSheet = workbook.getWorksheet('Leads');
  if (leadsSheet) {
    // Clear old data rows (keep header row 1)
    const lastRow = leadsSheet.rowCount;
    for (let r = lastRow; r >= 2; r--) leadsSheet.spliceRows(r, 1);

    leadsRes.rows.forEach((lead, idx) => {
      const r = idx + 2;
      const row = leadsSheet.getRow(r);
      row.values = [
        fmt(lead.created_at), lead.name, lead.company, lead.title,
        lead.email, lead.signal_tier, lead.status, lead.score,
        lead.pipeline_stage, lead.source,
        lead.apollo_enriched ? 'Yes' : 'No',
        lead.email_verified ? 'Yes' : 'No',
        lead.linkedin_url, lead.notes,
      ];
      row.eachCell(cell => {
        cell.fill = bgFill(rowBg(r));
        cell.font = { name: 'Arial', color: { argb: TEXT }, size: 9 };
        cell.border = {
          bottom: { style: 'thin', color: { argb: 'FF1E293B' } },
        };
      });
      row.commit();
    });
    console.log(`[export] Leads sheet populated (${leadsRes.rows.length} rows)`);
  }

  // ── 5. Populate Messages sheet ───────────────────────────────
  const msgsSheet = workbook.getWorksheet('Messages');
  if (msgsSheet) {
    const lastRow = msgsSheet.rowCount;
    for (let r = lastRow; r >= 2; r--) msgsSheet.spliceRows(r, 1);

    msgsRes.rows.forEach((msg, idx) => {
      const r = idx + 2;
      const row = msgsSheet.getRow(r);
      row.values = [
        fmt(msg.created_at), msg.lead_name, msg.company,
        msg.channel, msg.subject, msg.body_preview,
        msg.ranger_score, msg.status, msg.ranger_notes,
        fmt(msg.sent_at), msg.gmail_thread_id, msg.reply_detected,
      ];
      // Colour-code status column (col 8)
      const statusCell = row.getCell(8);
      const statusColors = {
        sent: LIME, pending_approval: BLUE,
        ranger_rejected: ORANGE, failed: 'FFFF4444',
      };
      if (statusColors[msg.status]) {
        statusCell.font = { name: 'Arial', color: { argb: statusColors[msg.status] }, bold: true, size: 9 };
      }
      row.eachCell(cell => {
        cell.fill = bgFill(rowBg(r));
        if (!cell.font?.color?.argb || cell.font.color.argb === TEXT) {
          cell.font = { name: 'Arial', color: { argb: TEXT }, size: 9 };
        }
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF1E293B' } } };
      });
      row.commit();
    });
    console.log(`[export] Messages sheet populated (${msgsRes.rows.length} rows)`);
  }

  // ── 6. Populate Agent Memory sheet ───────────────────────────
  const memSheet = workbook.getWorksheet('Agent Memory');
  if (memSheet) {
    const lastRow = memSheet.rowCount;
    for (let r = lastRow; r >= 2; r--) memSheet.spliceRows(r, 1);

    memRes.rows.forEach((mem, idx) => {
      const r = idx + 2;
      const row = memSheet.getRow(r);
      // Truncate summary for readability
      let summary = mem.summary || '';
      try { const parsed = JSON.parse(summary); summary = JSON.stringify(parsed, null, 0).slice(0, 200); } catch {}
      row.values = [fmt(mem.created_at), mem.agent, mem.memory_type, mem.key, summary, fmt(mem.updated_at)];
      row.eachCell(cell => {
        cell.fill = bgFill(rowBg(r));
        cell.font = { name: 'Arial', color: { argb: TEXT }, size: 9 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF1E293B' } } };
      });
      row.commit();
    });
    console.log(`[export] Agent Memory sheet populated (${memRes.rows.length} rows)`);
  }

  // ── 7. Populate Weekly KPIs sheet (aggregate daily → weekly) ─
  const kpiSheet = workbook.getWorksheet('Weekly KPIs');
  if (kpiSheet && kpiRes.rows.length > 0) {
    const lastRow = kpiSheet.rowCount;
    for (let r = lastRow; r >= 2; r--) kpiSheet.spliceRows(r, 1);

    // Group daily KPIs by ISO week
    const weeks = {};
    kpiRes.rows.forEach(day => {
      const d = new Date(day.date);
      // Get Monday of this week
      const mon = new Date(d);
      mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const key = mon.toISOString().slice(0, 10);
      if (!weeks[key]) weeks[key] = { date: key, leads: 0, sent: 0, replies: 0, meetings: 0 };
      weeks[key].leads    += parseInt(day.leads_found, 10) || 0;
      weeks[key].sent     += parseInt(day.emails_sent, 10) || 0;
      weeks[key].replies  += parseInt(day.replies, 10) || 0;
      weeks[key].meetings += parseInt(day.meetings_booked, 10) || 0;
    });

    Object.values(weeks).sort((a, b) => b.date.localeCompare(a.date)).forEach((wk, idx) => {
      const r = idx + 2;
      const row = kpiSheet.getRow(r);
      // Cols: Week Starting, Leads Found, Emails Sent, Replies, Meetings Booked,
      //       Reply Rate (formula), Meeting Rate (formula), Ranger Pass Rate (formula),
      //       P1 Leads, P2 Leads, Best Angle, Director Notes
      row.values = [wk.date, wk.leads, wk.sent, wk.replies, wk.meetings];
      // Formulas for rates (cols 6-8 already set in template, but re-apply)
      row.getCell(6).value = { formula: `IFERROR(D${r}/C${r},"-")`, result: wk.sent > 0 ? wk.replies / wk.sent : 0 };
      row.getCell(7).value = { formula: `IFERROR(E${r}/C${r},"-")`, result: wk.sent > 0 ? wk.meetings / wk.sent : 0 };
      row.getCell(6).numFmt = '0.0%';
      row.getCell(7).numFmt = '0.0%';
      row.eachCell(cell => {
        cell.fill = bgFill(rowBg(r));
        cell.font = { name: 'Arial', color: { argb: TEXT }, size: 9 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FF1E293B' } } };
      });
      row.commit();
    });
    console.log(`[export] Weekly KPIs populated (${Object.keys(weeks).length} weeks)`);
  }

  // ── 8. Save ──────────────────────────────────────────────────
  await workbook.xlsx.writeFile(xlsxPath);
  console.log(`[export] ✓ Saved: ${xlsxPath}`);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node server/scripts/exportClientData.js <slug|all>');
    console.error('  e.g. node server/scripts/exportClientData.js beaver-solutions');
    process.exit(1);
  }

  try {
    if (arg === 'all') {
      const result = await pool.query(`SELECT slug FROM clients WHERE slug IS NOT NULL ORDER BY name`);
      for (const row of result.rows) {
        await exportClient(row.slug);
      }
    } else {
      await exportClient(arg);
    }
    console.log('\n[export] All done.');
  } catch (err) {
    console.error('[export] Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();
