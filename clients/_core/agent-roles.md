# Agent Roles & Pipeline — DO NOT EDIT PER CLIENT

This describes the fixed pipeline that runs for every client.
Individual agent behaviour is tuned in each client's config.md — not here.

---

## The Crew

| Agent | Colour | Role |
|-------|--------|------|
| Captain Beaver | Purple (#A855F7) | Orchestrates daily runs, reads ICP + memory, builds the plan |
| Research Beaver | Blue (#00B4FF) | Finds leads matching ICP, scores P1/P2/P3, detects friction |
| Sales Beaver | Orange (#FF8C00) | Drafts personalised outreach and follow-ups |
| Enforcer Beaver | Police Blue (#2563EB) | QA gate — reviews every message before it enters the approval queue |

---

## Mandatory Pipeline (cannot be skipped)

```
8:30am MYT — n8n triggers daily kickoff (gated: AUTONOMOUS_ENABLED_CLIENTS env var)
  → Captain Beaver: pre-flight check (ICP defined? Signal identified?)
  → Captain Beaver: daily priority order
      1. Open conversations (reply handling)
      2. Due follow-ups
      3. New outreach to fill gap
      4. Sourcing new leads (only if 1–3 are done)
  → DB-first check: draw uncontacted leads from pool (14-day cooldown, NOT IN pipeline)
      If pool has ≥5 ready leads → use pool, skip cold research
      If pool insufficient → Research Beaver runs cold search
  → Research Beaver: DB Builder runs every 15min in background (separate from kickoff)
      Maintains pool of 200 ready leads per client. P1 first, P2 only if P1 exhausted, P3 skip.
  → Sales Beaver: personalisation search (Brave) per lead → draft message
  → Enforcer Beaver: review every message (hard gates — see ranger-rules.md)
  → Approved messages → approval queue
  → Client approves/rejects each message in The Dam UI
  → Approved → sent via Gmail (AgentMail as fallback)
  → All actions logged to activity log
  → Dashboard updates
```

**NO message ever sends without passing Enforcer Beaver AND client approval.**

**Don't-approach-twice rule:** Leads with `first_contacted_at` within 14 days OR with in-pipeline messages (pending_ranger / pending_approval / approved / pending_send / sending / sent) are excluded from all pool draws and Captain's `search_internal_leads` tool.

---

## Memory System

- `agent_memory` table stores: mistakes, schema facts, proven patterns, ICP snapshots
- Captain Beaver reads ALL agent memories at kickoff → builds shared context brief
- Sales Beaver reads Enforcer Beaver rejection patterns before drafting
- Research Beaver reads ICP memory before sourcing
- Any agent error → logged to agent_memory with: mistake, cause, new rule

---

## Background Jobs (always running, independent of n8n)

| Job | Interval | Purpose |
|-----|----------|---------|
| DB Builder | Every 15min (3min startup delay) | Research Beaver maintains lead pool. Checks pool health per enabled client, sources new leads when pool < 200. Env: `DB_BUILDER_ENABLED_CLIENTS` |
| Reply detector | Every 5min | Checks for incoming replies, classifies response type |
| Send queue worker | Every 60s | Sends approved messages via Gmail |
| Follow-up scheduler | Every 30min | Drafts and submits due follow-ups through Enforcer |

## Weekly Cadence (n8n scheduled)

| Day | Task |
|-----|------|
| Monday | Pipeline review + top 5 deal strategy |
| Wednesday | Outreach review + next batch generation |
| Friday | Performance audit via Captain Beaver |
| Sunday 11pm | Weekly review job → feeds weekly_learnings table |

---

_Last updated: 2026-04-16_
