# HEARTBEAT.md — Claw Periodic Health Check

Runs every 4 hours while active. Fully silent unless something needs attention. This is Claw staying alive and paying attention, not reporting in.

State is tracked in `memory/heartbeat-state.json`.

---

## Schedule

| Time (GMT+8) | What runs |
|-------------|-----------|
| 8:00 AM | Bootstrap (not heartbeat) |
| 10:00 AM | Heartbeat #1 |
| 12:00 PM | Heartbeat #2 + daily note synthesis check |
| 2:00 PM | Heartbeat #3 |
| 4:00 PM | Heartbeat #4 |
| 6:00 PM | Heartbeat #5 + end-of-day log |
| Outside work hours | Heartbeat every 4 hours but no MJ alerts unless Critical tier |

---

## Heartbeat Sequence

### H1 — Ping The Dam
```
GET /api/autonomous/pending-approvals?client_id=ce2fc8e5-617e-42d5-91fe-4275ceaa0030
Headers: x-internal-key: {DAM_INTERNAL_KEY}
```

| Result | Action |
|--------|--------|
| 200 OK | Silent |
| Timeout or 5xx | Critical alert to MJ. See alert format below. |
| 401 | Critical alert — key may have rotated |

---

### H2 — Check Approval Queue Depth

Use data from H1.

| Queue depth | Action |
|-------------|--------|
| 0–2 | Silent |
| 3–4 | High priority — surface at next MJ interaction: "You have {N} messages waiting for approval." |
| 5+ | Immediate alert: "Queue alert: {N} approvals pending. Reply 'show approvals' to review." |
| Same count as last heartbeat (no change for 4+ hours) | Add note to daily log: "Approval queue stalled at {N} for {X} hours. MJ may not have seen it." Alert once if it's been 8+ hours. |

---

### H3 — Check for Urgent Replies (during work hours only)

```
GET /api/autonomous/recent-replies?client_id=ce2fc8e5-617e-42d5-91fe-4275ceaa0030&hours=3
Headers: x-internal-key: {DAM_INTERNAL_KEY}
```

| Result | Action |
|--------|--------|
| 0 replies | Silent |
| Neutral / objection only | Batch for next morning brief |
| Any positive reply | Immediate alert. See format below. |
| 5+ replies in 3h window | Alert MJ regardless of classification — unusual volume |

---

### H4 — Synthesize Daily Notes (12PM and 6PM only)

At 12PM and 6PM, check `memory/YYYY-MM-DD.md` for today.

If the log has more than 20 entries: summarise the morning session into a condensed block at the top of the file. Keep the raw entries below it. This keeps the file readable without losing detail.

Pattern:
```
## Morning Summary (synthesised at {time})
- {2–4 bullet points covering what happened, decisions made, approvals actioned}

---
[Raw entries below]
```

Do NOT modify MEMORY.md during heartbeat unless a new confirmed pattern has emerged. MEMORY.md is curated, not a running log.

---

### H5 — End-of-Day Wrap (6PM only)

At 6PM, run a brief wrap-up:

1. Count from today's daily log: messages approved, messages rejected, replies actioned
2. Check if morning brief was fired today
3. Check if any cron jobs failed (scan daily log for error entries)

If everything ran clean:
```
[18:00] End of day. Approved: {N}. Rejected: {N}. Replies actioned: {N}. No errors.
```
Log this to daily notes. Silent to MJ unless there are unresolved items.

If there are unresolved items (stalled approvals, missed cron, unanswered hot reply), send MJ:
```
End of day — a few things carried over:
- {item 1}
- {item 2}
Reply tomorrow or handle in The Dam UI.
```

---

### H6 — Update Heartbeat State

After every heartbeat, write to `memory/heartbeat-state.json`:

```json
{
  "last_run": "{ISO timestamp GMT+8}",
  "the_dam_status": "ok | timeout | error",
  "approvals_count": {N},
  "last_positive_reply": "{ISO timestamp or null}",
  "crons_active": ["morning-brief", "reply-check", "heartbeat"],
  "daily_log_entries": {N},
  "errors_today": []
}
```

---

## Alert Formats

### Critical — The Dam is down
```
The Dam is not responding.
Last successful ping: {time GMT+8}
Check: railway.app → the-dam-v2 → Logs tab
```

### Critical — Positive reply received
```
Hot reply — act today.
{lead_name} ({lead_company}) replied at {time GMT+8}
"{reply body truncated to 100 chars}..."
Reply "check replies" for full context.
```

### High — Queue depth 5+
```
Queue alert: {N} messages waiting for your approval.
Oldest: {hours} hours ago.
Reply "show approvals" to review.
```

---

## What Heartbeat Does NOT Do

- Does not fire the daily kickoff (that's the morning brief cron)
- Does not send routine "all clear" messages — silence means everything is fine
- Does not update MEMORY.md unless a durable new pattern is confirmed
- Does not alert MJ for things that can wait until morning
- Does not re-alert for the same issue within 4 hours

---

## Improvement Observation Window

The heartbeat is also when Claw runs its observation pass.

Every 3rd heartbeat (roughly every 12 hours), Claw should ask:
- Is there a recurring pattern in today's log worth noting?
- Did anything take longer than expected?
- Is there a suggestion worth surfacing to MJ?

If yes: draft one suggestion. Hold it. Deliver it at the next natural interaction with MJ, not as an interrupt.

Format for suggestions:
```
Observation: {what was noticed}
Why it matters: {one sentence}
Suggestion: {what Claw recommends}
Decision needed: {what MJ needs to say yes or no to}
```
