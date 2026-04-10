---
name: dam-approval-notify
description: Poll for pending approvals every 30 minutes during business hours (Mon-Sat 9AM-7PM) and nudge MJ via Telegram if messages are waiting. Also triggered by commands "any approvals?" or "what's pending?". Skips notification if count unchanged in last 2 hours.
---

# dam-approval-notify

## Purpose
Poll for pending approvals every 30 minutes during business hours and nudge Roy if messages are waiting. Roy should never forget to approve.

## Trigger
- Schedule: Every 30 minutes, Monday–Saturday, 9:00 AM – 7:00 PM local time
- Manual: Roy says "any approvals?", "what's pending?"

## Dependencies
- dam-authenticate must have run (DAM_TOKEN available)

## Steps

### Step 1 — Fetch pending approvals
```
GET {DAM_URL}/api/approvals?status=pending&perPage=50
Authorization: Bearer {DAM_TOKEN}
```

Extract:
- `meta.total` as `PENDING_COUNT`
- `data[]` — list of pending approvals

### Step 2 — Decision gate
- If `PENDING_COUNT === 0`: Do nothing. No Telegram message.
- If `PENDING_COUNT > 0`: Proceed to Step 3.

### Step 3 — Format approval summary
For each approval (max 5 shown), extract:
- Lead name from `data[n].lead_name`
- Message preview (first 80 chars of `data[n].message_body`)
- Ranger score from `data[n].ranger_score`

### Step 4 — Send Telegram notification
```
⏳ {PENDING_COUNT} message(s) awaiting your approval.

{for first 3 approvals:}
• {lead_name} — "{message_preview}..." (Ranger: {ranger_score}/100)

{if PENDING_COUNT > 3: "...and {PENDING_COUNT - 3} more."}

→ Review & approve: https://app.beaver.solutions/approvals
```

### Step 5 — Avoid spam
Track the last notification time. If the same count was notified less than 2 hours ago and count hasn't increased, skip the notification.

Only send again if:
- Count has increased since last notification, OR
- 2+ hours have passed since last notification, OR
- Roy manually triggers this skill

## Error Handling
- If API fails: Skip silently (do not spam Roy with error alerts for routine polls)
- If 401: Run dam-authenticate, retry once
