# Skill: dam-approval-notify

## Trigger
Activate when MJ says:
- "show approvals"
- "any approvals?"
- "what needs approval?"
- "what's in the queue?"
- "review messages"
- `approve #N` — to approve a specific item by number
- `reject #N` — to reject a specific item by number
- `reject #N [reason]` — to reject with a reason

Also runs as part of `dam-morning-brief.md` (Step 3).

## What This Skill Does
Fetches all pending messages from BeavrDam's approval queue, presents each one with full context (lead profile + message body), and lets MJ approve or reject directly from Telegram with a simple reply command.

## Prerequisites
- `DAM_INTERNAL_KEY` stored in secrets
- Beaver Solutions client_id: `ce2fc8e5-617e-42d5-91fe-4275ceaa0030`

---

## Execution Steps

### When MJ asks to see approvals

**Step 1 — Fetch the queue**
```
GET https://beavrdam-production.up.railway.app/api/autonomous/pending-approvals?client_id=ce2fc8e5-617e-42d5-91fe-4275ceaa0030
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
```

**Step 2 — Store the list in session memory**
Number each approval 1 through N. Save the mapping of `#N → approval_id + message_id` so MJ can refer to approvals by number.

**Step 3 — Present the queue**

If queue is empty:
> "Queue is clear. Nothing pending approval right now."

If queue has items, send ONE message formatted like this:

---
**Approval Queue — {total} pending**

**#1 — {lead_name}, {lead_title} at {lead_company}**
Channel: {channel} | Industry: {lead_industry}
LinkedIn: {lead_linkedin if present, else "⚠️ No LinkedIn — verify manually"}
Source: {lead_source} | Signal: {lead_signal if present}
{If lead_source is "ai_generated": show "⚠️ AI-generated lead — verify LinkedIn before approving"}
Subject: {subject}
```
{full message body}
```

---

**#2 — {lead_name}, {lead_title} at {lead_company}**
Channel: {channel} | Industry: {lead_industry}
LinkedIn: {lead_linkedin if present, else "⚠️ No LinkedIn — verify manually"}
Source: {lead_source} | Signal: {lead_signal if present}
{If lead_source is "ai_generated": show "⚠️ AI-generated lead — verify LinkedIn before approving"}
Subject: {subject}
```
{full message body}
```

---
[Continue for all items, max 10 per message. If more than 10, send a second message.]

**Reply commands:**
- `approve #1` to approve
- `reject #1` to reject
- `reject #1 too generic` to reject with reason
- `approve all` to approve everything in the queue (only use if all LinkedIn URLs verified)

---

### When MJ says `approve #N`

**Step 1 — Look up approval_id from session memory**
Find the approval_id mapped to #N.

If not found: "I don't have #N in memory. Run 'show approvals' first."

**Step 2 — Call approve endpoint**
```
POST https://beavrdam-production.up.railway.app/api/autonomous/approve
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
  Content-Type: application/json
Body:
  {
    "approval_id": "{approval_id}",
    "client_id": "ce2fc8e5-617e-42d5-91fe-4275ceaa0030"
  }
```

**Step 3 — Confirm to MJ**
Success: "Approved. Message to {lead_name} at {lead_company} is queued for send."
Error: "Approval failed — [error]. Try again or check BeavrDam UI."

**Step 4 — Log to daily notes**
`[{time GMT+8}] Approved message #{N} to {lead_name} ({lead_company}).`

---

### When MJ says `reject #N` or `reject #N [reason]`

**Step 1 — Look up approval_id from session memory**

**Step 2 — Call reject endpoint**
```
POST https://beavrdam-production.up.railway.app/api/autonomous/reject
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
  Content-Type: application/json
Body:
  {
    "approval_id": "{approval_id}",
    "client_id": "ce2fc8e5-617e-42d5-91fe-4275ceaa0030",
    "reason": "{reason if provided, else 'rejected_by_mj'}"
  }
```

**Step 3 — Confirm to MJ**
Success: "Rejected. Message to {lead_name} at {lead_company} removed from queue."
Error: "Rejection failed — [error]."

**Step 4 — Log to daily notes**
`[{time GMT+8}] Rejected message #{N} to {lead_name} ({lead_company}). Reason: {reason}.`

---

### When MJ says `approve all`

Loop through every approval in session memory, calling the approve endpoint for each.
Report: "Approved {success_count} messages. {fail_count} failed — [list failures]."

---

## Error Handling

| Error | Action |
|-------|--------|
| GET pending-approvals fails | "Could not reach BeavrDam. Check Railway." |
| Approval not found (404) | "Already actioned or ID mismatch. Run 'show approvals' to refresh." |
| Approve/reject call fails | Report error, do not retry automatically |
| Session memory lost | Ask MJ to run "show approvals" again to reload the list |

---

## Notes
- Always show the full message body, not a truncated version. MJ needs to read the exact message he's approving.
- If a message contains a Ranger rejection reason in metadata, show it: "Note: Ranger flagged this — {reject_reason}. It was revised and re-submitted."
- Never approve or reject without MJ's explicit command. Presenting the queue is passive. Acting on it requires a command.
