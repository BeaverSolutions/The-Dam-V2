# Agent Roles & Pipeline — DO NOT EDIT PER CLIENT

This describes the fixed pipeline that runs for every client.
Individual agent behaviour is tuned in each client's config.md — not here.

---

## The Crew

| Agent | Colour | Role |
|-------|--------|------|
| The Director | Purple | Orchestrates daily runs, reads ICP + memory, builds the plan |
| Research Beaver | Blue | Finds leads matching ICP, scores P1/P2/P3, detects friction |
| Sales Beaver | Lime | Drafts personalised outreach and follow-ups |
| The Ranger | Orange | QA gate — reviews every message before it enters the approval queue |

---

## Mandatory Pipeline (cannot be skipped)

```
8:30am MYT — n8n triggers daily kickoff
  → Director: pre-flight check (ICP defined? Signal identified?)
  → Director: daily priority order
      1. Open conversations (reply handling)
      2. Due follow-ups
      3. New outreach to fill gap
      4. Sourcing new leads (only if 1–3 are done)
  → Research Beaver: find leads (P1 first, P2 only if P1 exhausted, P3 skip)
  → Sales Beaver: draft messages per lead
  → Ranger: review every message (hard gates — see ranger-rules.md)
  → Approved messages → approval queue
  → Client approves/rejects each message in The Dam UI
  → Approved → sent via AgentMail
  → All actions logged to activity log
  → Dashboard updates
```

**NO message ever sends without passing Ranger AND client approval.**

---

## Memory System

- `agent_memory` table stores: mistakes, schema facts, proven patterns, ICP snapshots
- Director reads ALL agent memories at kickoff → builds shared context brief
- Sales Beaver reads Ranger rejection patterns before drafting
- Research Beaver reads ICP memory before sourcing
- Any agent error → logged to agent_memory with: mistake, cause, new rule

---

## Weekly Cadence (n8n scheduled)

| Day | Task |
|-----|------|
| Monday | Pipeline review + top 5 deal strategy |
| Wednesday | Outreach review + next batch generation |
| Friday | Performance audit via Director |
| Sunday 11pm | Weekly review job → feeds weekly_learnings table |

---

_Last updated: 2026-04-03_
