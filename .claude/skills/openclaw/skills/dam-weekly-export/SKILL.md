---
name: dam-weekly-export
description: Export the master database (combining all clients) and per-client trackers to .xlsx files every Sunday night. Keeps the in-house database bank current. Use when MJ says "export data", "update master database", or on the Sunday 11pm schedule.
---

# dam-weekly-export

## Purpose
Export the master database and per-client trackers every week. Keeps our in-house database bank up to date for reference and offline use.

## Trigger
- Schedule: Every Sunday at 11:00 PM local time
- Manual: Roy says "export data", "update master database", "export leads"

## Dependencies
- dam-authenticate must have run (DAM_TOKEN available)
- Server must have `exceljs` installed

## Steps

### Step 1 — Run master database export
```bash
cd {DAM_PROJECT_DIR}
node server/scripts/exportMasterDatabase.js
```

This creates/updates `output/master-database.xlsx` with:
- All Leads (every client, combined)
- All Messages (every client, combined)
- Pipeline Summary (per client stats)
- Signal Hunts (signal search activity log)
- Export Info (timestamp and totals)

### Step 2 — Run per-client exports
```bash
node server/scripts/exportClientData.js all
```

This updates each `clients/<slug>/<slug>-tracker.xlsx`.

### Step 3 — Report to Roy
Send Telegram:
```
📊 Weekly Data Export Complete

Master database updated: output/master-database.xlsx
• {total_leads} total leads across all clients
• {total_messages} total messages

Per-client trackers updated:
{for each client: "• {client_name}: {lead_count} leads"}

All files ready for reference.
```

### Step 4 — Log to journal
```
POST {DAM_URL}/api/myclaw/memory
Authorization: Bearer {DAM_TOKEN}
Content-Type: application/json

{
  "client_id": "{CLIENT_ID}",
  "agent": "captain_beaver",
  "memory_type": "journal",
  "key": "weekly_export_log",
  "content": "Weekly export completed. Master: {total_leads} leads, {total_messages} messages."
}
```

## Error Handling
- If ExcelJS not installed: Send "⚠️ ExcelJS missing. Run npm install exceljs."
- If DB connection fails: Send "⚠️ Database connection failed. Check Railway."
- If export script throws: Send error message + suggest checking logs
