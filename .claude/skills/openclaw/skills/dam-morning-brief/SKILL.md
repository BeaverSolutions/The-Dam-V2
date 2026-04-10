---
name: dam-morning-brief
description: Deliver a daily morning briefing to MJ via Telegram. Covers pipeline health, pending approvals, and today's recommended actions. Runs weekdays 8:00 AM local time, or on command "morning brief", "what's the status", "dam status".
---

# dam-morning-brief

## Purpose
Deliver a daily morning briefing to Roy via Telegram. Covers pipeline health, pending approvals, and today's recommended actions.

## Trigger
- Schedule: Every weekday (Mon–Fri) at 8:00 AM local time
- Manual: Roy says "morning brief", "what's the status", "dam status"

## Dependencies
- dam-authenticate must have run successfully (DAM_TOKEN available)

## Steps

1. Fetch the Director's brief:
   ```
   GET {DAM_URL}/api/agents/director/brief
   Authorization: Bearer {DAM_TOKEN}
   ```

2. Fetch pending approvals count:
   ```
   GET {DAM_URL}/api/approvals?status=pending&perPage=1
   Authorization: Bearer {DAM_TOKEN}
   ```
   Extract `meta.total` as `PENDING_COUNT`

3. Fetch dashboard stats:
   ```
   GET {DAM_URL}/api/dashboard/stats
   Authorization: Bearer {DAM_TOKEN}
   ```

4. Format and send this Telegram message:
   ```
   🦫 Good morning! Here's your Dam briefing.

   📊 Pipeline Today
   • Leads in pipeline: {stats.total_leads}
   • Sent today: {stats.sent_today}
   • Replies: {stats.replies}
   • Meetings booked: {stats.meetings}

   ⏳ Pending Approvals: {PENDING_COUNT}
   {if PENDING_COUNT > 0: "→ Review at https://app.beaver.solutions/approvals"}

   🎯 Director's Recommendation
   {brief.recommendation or brief.summary}

   Reply with a command to kick off outreach, e.g:
   "Find 10 SaaS founders in KL"
   ```

5. Log to journal:
   ```
   POST {DAM_URL}/api/myclaw/memory
   Authorization: Bearer {DAM_TOKEN}
   Content-Type: application/json

   {
     "client_id": "{DAM_CLIENT_ID}",
     "agent": "captain_beaver",
     "memory_type": "journal",
     "key": "morning_brief_log",
     "content": "Morning brief delivered. Pending: {PENDING_COUNT}. Pipeline: {stats summary}"
   }
   ```

## Error Handling
- If API call fails: Send Telegram "⚠️ Could not fetch Dam status. Check Railway deployment."
- If 401: Run dam-authenticate then retry once
