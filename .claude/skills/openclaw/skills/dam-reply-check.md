# dam-reply-check

## Purpose
Detect when leads reply to outreach emails and alert Roy immediately so he can respond while the lead is warm.

## Trigger
- Schedule: Every 15 minutes, 8:00 AM – 9:00 PM daily
- Manual: Roy says "any replies?", "check replies", "did anyone respond?"

## Dependencies
- dam-authenticate must have run (DAM_TOKEN available)

## State
Track `LAST_CHECK_TIME` — timestamp of last successful check. Default to 15 minutes ago on first run.

## Steps

### Step 1 — Fetch recent reply logs
```
GET {DAM_URL}/api/logs?action=reply_detected&limit=20
Authorization: Bearer {DAM_TOKEN}
```

Filter results: only logs where `created_at > LAST_CHECK_TIME`

Extract for each new reply:
- `target_id` → this is the message ID
- `metadata.lead_name`
- `metadata.lead_company`
- `metadata.reply_snippet` (first 100 chars of reply)
- `created_at`

### Step 2 — Decision gate
- If no new replies since last check: Update `LAST_CHECK_TIME`, do nothing.
- If new replies found: Proceed to Step 3.

### Step 3 — Alert Roy for each reply
Send one Telegram message per reply:
```
🔔 Reply from {lead_name} at {lead_company}!

"{reply_snippet}..."

→ View thread: https://app.beaver.solutions/messages
```

If more than 3 replies at once, batch into one message:
```
🔔 {count} new replies!

{for each:}
• {lead_name} ({lead_company}) — "{snippet}..."

→ View all: https://app.beaver.solutions/messages
```

### Step 4 — Update last check time
Store current timestamp as `LAST_CHECK_TIME`.

### Step 5 — Optional: Roy asks to see full thread
If Roy replies "show me" or "see full thread" after a reply alert:
```
GET {DAM_URL}/api/messages/{message_id}
Authorization: Bearer {DAM_TOKEN}
```
Format and send the full message thread to Telegram.

## Error Handling
- If API fails: Skip silently. Update LAST_CHECK_TIME anyway to avoid duplicate alerts next run.
- If 401: Run dam-authenticate, retry once.
