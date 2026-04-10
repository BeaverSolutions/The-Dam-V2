---
name: dam-followup
description: Trigger The Dam's autonomous follow-up queue (Day 2, 4, 7) — Sales Beaver drafts, Enforcer QAs, then queues for MJ's approval. Never sends without approval. Runs weekdays 9:00 AM, or on commands "check follow-ups", "any follow-ups due?".
---

# dam-followup

## Purpose
When a lead hasn't replied after 2, 4, or 7 days, automatically draft a follow-up via Sales Beaver, run it through Ranger, and queue it for Roy's approval. Never sends without approval.

## Trigger
- Schedule: Every weekday at 9:00 AM (runs after morning brief)
- Manual: Roy says "check follow-ups", "any follow-ups due?"

## Dependencies
- dam-authenticate must have run (DAM_TOKEN available)

## Steps

### Step 1 — Trigger autonomous kickoff (includes follow-up processing)
```
POST {DAM_URL}/api/autonomous/kickoff
x-internal-key: {INTERNAL_API_KEY}
Content-Type: application/json

{
  "client_id": "{DAM_CLIENT_ID}"
}
```

Note: `DAM_CLIENT_ID` is the UUID of the client (Beaver Solutions). Store in env vars.
Note: `INTERNAL_API_KEY` is a separate secret from the JWT — store in OpenClaw secrets.

The autonomous kickoff already handles:
- Processing due follow-ups (Day 2, Day 4, Day 7)
- Drafting follow-up messages via Sales Beaver
- Running each through Ranger
- Queuing approved ones for Roy's approval

### Step 2 — Report to Roy
After kickoff completes, check for new pending approvals:
```
GET {DAM_URL}/api/approvals?status=pending&perPage=1
Authorization: Bearer {DAM_TOKEN}
```

If new approvals were added, send Telegram:
```
📬 Follow-ups queued for your approval.

{PENDING_COUNT} message(s) ready to review.
→ https://app.beaver.solutions/approvals
```

If no new follow-ups: Stay silent.

## Follow-up Timing Rules (built into The Dam)
- Day 0: Initial outreach
- Day 2: Follow-up 1 — different angle on same pain
- Day 4: Follow-up 2 — one-line social proof only
- Day 7: Follow-up 3 — easy out ("happy to leave this here if timing's off")

These timings are enforced by The Dam's followup_queue table. OpenClaw just triggers the kickoff.

## Error Handling
- If kickoff returns error: Send "⚠️ Follow-up run failed. Check Railway logs."
- Log all outcomes to The Dam's activity log automatically (handled by autonomous kickoff)
