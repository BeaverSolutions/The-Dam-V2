# BeavrDam Operations Playbook

Owner: Claude (Backend Partner)
Executor: Open Claw (Captain Beaver)
Effective: 2026-04-21

---

## Daily Ops Checklist (Every Session)

### 1. System Health
- [ ] Railway deployment status — any failed deploys or restarts?
- [ ] `/health` endpoint returning 200?
- [ ] Background jobs running? (DB Builder, send queue, reply detector, follow-up scheduler)
- [ ] Any uncaught errors in Railway logs?
- [ ] Database connection healthy?

### 2. LLM Spend
- [ ] Check `/api/admin/usage` — any client over 80% daily budget?
- [ ] Per-agent cost breakdown normal? (Captain Beaver typically highest)
- [ ] No runaway loops burning tokens?

### 3. Agent Behavior
- [ ] Enforcer pass rate (7-day) — below 60% = prompts too loose, above 95% = gates too weak
- [ ] Research Beaver lead quality — check recent leads for ICP fit (title, geography, industry)
- [ ] Sales Beaver draft quality — spot check 2-3 recent messages
- [ ] Reply handler classifications accurate? Check reply_sentiment in recent logs

### 4. Pipeline Health
- [ ] Leads in pool per client — target 200, alert if below 50
- [ ] Pending approvals queue — anything stale >24h?
- [ ] Send queue — any stuck messages (status='sending' for >5min)?
- [ ] Stale leads — anyone in outreach/qualifying with no activity >5 days?

### 5. Conversion Tracking
- [ ] `conversion_events` table receiving data?
- [ ] `deal_summary` rows being created/updated?

### 6. Security Quick Check
- [ ] No new exposed env vars or credentials in commits
- [ ] Rate limiting active
- [ ] JWT auth functioning

---

## Weekly Ops Review (Every Monday)

### Performance Audit
- [ ] Reply rate trend (week over week) — target >2%
- [ ] Messages sent vs target (80/day/client)
- [ ] Lead quality score distribution (P1/P2/P3)
- [ ] Enforcer rejection patterns — what's getting caught?
- [ ] Conversion funnel: leads → contacted → replied → booked → closed

### Agent Intelligence Audit
- [ ] Review Captain Beaver's weekly_learnings in agent_memory
- [ ] Check Research Beaver's db_builder_config — pool health metrics
- [ ] Review Enforcer rejection reasons — any new patterns?
- [ ] Sales Beaver follow-up quality — are FU2/FU3 introducing new angles?

### Infrastructure Review
- [ ] Database size / table bloat
- [ ] Migration status — any pending?
- [ ] Railway resource usage
- [ ] API key expirations approaching?

### Improvement Identification
- [ ] One product improvement to propose to MJ
- [ ] One security hardening to implement
- [ ] One agent behavior refinement

---

## Incident Response

### Background Job Stalled
1. Check Railway logs for the specific job
2. Look for error patterns (DB connection, API timeout, budget exceeded)
3. If DB Builder: check `agent_memory` for `research_beaver/used_queries` corruption
4. If Send Queue: check `send_queue` table for stuck `sending` status rows
5. Fix root cause → restart only if necessary

### Lead Quality Degradation
1. Check ICP config in `agent_memory` — is it loaded correctly?
2. Check Research Beaver verification logs — Haiku completing?
3. Check DEFAULT_TITLES/DEFAULT_INDUSTRIES — fallback kicking in?
4. Tighten BANNED_TITLE_KEYWORDS if new patterns emerge

### LLM Budget Exceeded
1. Check which agent is burning tokens
2. Check for infinite loops in agent calls
3. Verify budget.js daily reset is working
4. If legitimate high usage: discuss budget increase with MJ

### Email Deliverability Issues
1. Check send_queue for failure patterns
2. Check Gmail OAuth token status
3. Check AgentMail API health
4. Review bounce rates in logs

---

## End-of-Day Summary Template

File: `ops/daily/YYYY-MM-DD.md`

```markdown
# Ops Summary — YYYY-MM-DD

## System Status
- Railway: [UP/DOWN/DEGRADED]
- Background Jobs: [ALL RUNNING / issues]
- LLM Spend: $X.XX / $Y.YY budget

## Key Metrics
- Leads sourced today: X
- Messages sent: X
- Replies received: X
- Enforcer pass rate: X%

## Issues Found
- [description + resolution]

## Improvements Made
- [what changed and why]

## Lessons Learned
- [patterns to watch for]

## Tomorrow's Focus
- [priority items]
```

---

## Escalation to MJ

Only escalate when:
1. System is down and can't self-recover
2. Budget decision needed (increase/decrease)
3. Client-facing issue (emails bouncing, wrong messages sent)
4. Security incident
5. Product decision required (feature scope, ICP changes)

Everything else: fix it, log it, move on.
