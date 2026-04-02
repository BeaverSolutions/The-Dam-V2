---
name: openclaw-integration
description: "Plan and implement OpenClaw integration with The Dam. Use when connecting OpenClaw as an external orchestration layer, setting up OpenClaw to control The Dam agents, or building the bridge between OpenClaw's task execution and The Dam's pipeline API."
---

# OpenClaw Integration — The Dam v2

## What OpenClaw Is (Context)

OpenClaw is an autonomous AI agent framework — it operates a computer 24/7, executes goals without supervision, and improves over time. Unlike The Dam's browser-based UI, OpenClaw communicates via Telegram or Discord and can be left to run unattended overnight.

**The integration goal:** OpenClaw becomes the "outer brain" that drives The Dam via API. Roy talks to OpenClaw on Telegram → OpenClaw calls The Dam → The Dam's crew executes.

```
Roy (Telegram) → OpenClaw → The Dam API → Director → Research/Sales/Ranger → Approvals → Gmail
```

---

## Architecture: Two Modes

### Mode 1: OpenClaw as Commander (Phase 1 — Build This First)
OpenClaw sends commands to The Dam's existing Director endpoint. The Dam handles everything internally. OpenClaw just initiates campaigns and relays status back to Roy via Telegram.

```
OpenClaw skill → POST /api/agents/director/plan → Director plans → POST /api/agents/director/execute → Results
```

**Roy's experience:**
> Roy on Telegram: "Find 10 fintech founders in Singapore and start outreach"
> OpenClaw: Calls The Dam API, gets plan back
> OpenClaw to Roy: "The Director has a plan — 4 steps, ~10 leads. Approve? [Yes/No]"
> Roy replies: "Yes"
> OpenClaw: Calls execute endpoint, waits for results
> OpenClaw to Roy: "Done — 8 leads found, 5 messages drafted, 3 passed Ranger. Go to Approvals to send."

### Mode 2: OpenClaw as Full Orchestrator (Phase 2)
OpenClaw bypasses the Director and directly orchestrates Research Beaver, Sales Beaver, and Ranger via individual API endpoints. More flexible, more control.

---

## The Dam API Endpoints OpenClaw Will Use

All endpoints require JWT auth. OpenClaw stores the token as a skill variable.

```
# Auth
POST /api/auth/login                  → Get JWT token

# Director (Mode 1)
POST /api/agents/director/plan        → Create campaign plan
POST /api/agents/director/execute     → Execute approved plan
GET  /api/agents/director/brief       → Morning status summary

# Pipeline (Mode 2 — direct agent control)
POST /api/agents/research/search      → Find leads
POST /api/agents/sales/generate       → Draft message for lead
POST /api/agents/ranger/review        → QA a message

# Approvals
GET  /api/approvals?status=pending    → Get pending approvals
PUT  /api/approvals/:id               → Approve or reject

# Memory
GET  /api/agents/memory               → Read agent memory
POST /api/agents/memory/journal       → Write journal entry

# Dashboard
GET  /api/dashboard/stats             → Pipeline summary
```

---

## OpenClaw Skill Files to Create

### 1. `dam-authenticate.md`
Logs into The Dam and stores the JWT token for subsequent calls.

```
Goal: Authenticate with The Dam
Steps:
1. POST to {DAM_URL}/api/auth/login with credentials
2. Store returned token as session variable DAM_TOKEN
3. Token expires in 7 days — re-authenticate if 401 received
```

### 2. `dam-morning-brief.md`
Runs daily at 8AM. Gets the Director's brief and sends it to Roy via Telegram.

```
Goal: Deliver morning brief
Schedule: Every weekday at 8:00 AM
Steps:
1. GET /api/agents/director/brief
2. Format the summary and stats into a Telegram message
3. Include pending approval count with deep link to approvals page
4. Send to Roy's Telegram
```

### 3. `dam-run-campaign.md`
Roy triggers this by speaking to OpenClaw naturally. OpenClaw parses the intent and calls The Dam.

```
Goal: Run a sales campaign
Trigger: Roy says anything like "find leads", "start outreach", "reach out to..."
Steps:
1. Extract: target description, count, any filters from Roy's message
2. POST /api/agents/director/plan with extracted command
3. If plan returned: Present steps to Roy, ask for approval
4. If Roy approves: POST /api/agents/director/execute
5. Wait for execution result (poll or webhook)
6. Report summary to Roy: leads found, messages drafted, Ranger score, pending approvals
7. Write journal entry: POST /api/agents/memory/journal with campaign summary
```

### 4. `dam-approval-notify.md`
Runs every 30 minutes to check for pending approvals and nudge Roy.

```
Goal: Notify Roy of pending approvals
Schedule: Every 30 minutes during business hours (9AM–7PM)
Steps:
1. GET /api/approvals?status=pending
2. If count > 0: Send Telegram message to Roy with count and direct link
3. If count = 0: Silent — do not send
```

### 5. `dam-reply-check.md`
Checks for lead replies and notifies Roy immediately.

```
Goal: Alert on lead replies
Schedule: Every 15 minutes
Steps:
1. GET /api/logs?action=reply_detected&since=15min
2. For each new reply: Send Telegram alert with lead name, company, snippet
3. Roy can reply "see full thread" → OpenClaw fetches and shows in Telegram
```

---

## Implementation Roadmap

### Phase 1 — Connection (Week 1)
- [ ] Deploy The Dam to Railway ✅ (done)
- [ ] Create OpenClaw account at cloud.clawbot.ai or install locally
- [ ] Connect Claude API key to OpenClaw (use Claude Opus 4.6)
- [ ] Set up Telegram bot for OpenClaw
- [ ] Create `dam-authenticate.md` skill in OpenClaw
- [ ] Test: Ask OpenClaw to log into The Dam and return a morning brief
- [ ] Create `dam-morning-brief.md` — schedule at 8AM weekdays

### Phase 2 — Campaign Control (Week 2)
- [ ] Create `dam-run-campaign.md` skill
- [ ] Test end-to-end: Roy on Telegram → OpenClaw → Director plan → Roy approves → execute
- [ ] Create `dam-approval-notify.md` — 30-min polling
- [ ] Roy tests from mobile: one full campaign without touching the browser

### Phase 3 — Autonomous Mode (Week 3+)
- [ ] Create `dam-reply-check.md` — 15-min reply detection alerts
- [ ] Add `dam-followup.md` — when lead replies, OpenClaw drafts a follow-up via Sales Beaver
- [ ] Morning brief includes daily targets set by OpenClaw based on pipeline health
- [ ] OpenClaw can propose and run campaigns without Roy asking — just confirms first

---

## Security Notes

- The Dam JWT must be stored as an OpenClaw secret variable (never in skill text)
- Set a dedicated OpenClaw user in The Dam with `role: agent` (Phase 2 — add this role)
- Rate limit: The Dam already enforces 100 req/min — OpenClaw polling respects this
- Approval gate is ALWAYS Roy — OpenClaw never auto-approves messages

---

## Environment Variables OpenClaw Needs

```
DAM_URL=https://[your-railway-domain].railway.app
DAM_EMAIL=admin@beaversolutions.com
DAM_PASSWORD=[password]
TELEGRAM_CHAT_ID=[Roy's Telegram chat ID]
```

---

## Testing the Connection

Once OpenClaw is installed and Telegram is set up, test with:

> "Check the status of The Dam and tell me how many leads we have"

OpenClaw should:
1. Authenticate with The Dam
2. Call GET /api/dashboard/stats
3. Reply on Telegram with the stats

That's the full connection validated.
