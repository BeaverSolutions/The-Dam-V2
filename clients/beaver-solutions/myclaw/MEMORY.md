# MEMORY.md — What Claw Always Knows

## Preferences

1. **Tools / stack MJ uses daily:**
   Claude Code, Git Bash, Supabase SQL editor, Railway dashboard, Telegram

2. **Response styles that work:**
   Tables for status. Single line for quick answers. Code blocks for anything to paste.
   Never prose paragraphs for operational updates.

3. **Things that annoy MJ — never do these:**
   - Recap what just happened before answering
   - Ask clarifying questions when the answer is inferable
   - Add emoji to everything
   - Say "Great!" or "Sure!" before responding
   - Repeat the same warning more than once

---

## Projects

### The Dam v2 — LIVE IN PRODUCTION
- **What it is:** Multi-tenant B2B outbound sales automation platform
- **URL:** https://app.beaver.solutions
- **Status:** Production. Railway auto-deploys on push to main.
- **Repo:** BeaverSolutions/The-Dam-V2 on GitHub
- **DB:** Supabase (PostgreSQL), hosted separately from Railway
- **Stack:** React/Vite (frontend) → Node.js/Express (backend) → PostgreSQL → Claude AI agents

### 5 Pilot Clients — Onboarding in Progress
| Client | Contact | Status |
|--------|---------|--------|
| Beaver Solutions | MJ | Live — pilot running |
| TRL | Adrian | DB missing — needs provisioning |
| The Gaming Company | Adrian, Keith | Discovery call pending |
| MGMX Sdn Bhd | Matthew Ho | Discovery call pending |
| Emplifive | Michael | Discovery call pending |

### OpenClaw / MyClaw — THIS INSTANCE
- **What it is:** Claw (this agent) running on MyClaw Lite ($16/mo)
- **Role:** Operational layer that calls The Dam API on MJ's behalf
- **Status:** Freshly set up. Skill files being loaded now.

---

## The Dam — API Reference

**Base URL:** `https://app.beaver.solutions`

**Internal API Key:** stored in MyClaw secrets as `DAM_INTERNAL_KEY`

**Key endpoints Claw uses:**
```
POST /api/autonomous/kickoff                    → fire daily kickoff for a client
POST /api/autonomous/kickoff-all               → fire kickoff for ALL clients
GET  /api/autonomous/pending-approvals         → fetch messages awaiting MJ approval
POST /api/autonomous/approve                   → approve a message { approval_id }
POST /api/autonomous/reject                    → reject a message { approval_id, reason }
GET  /api/autonomous/recent-replies            → replies in last N hours (default 24h)
POST /api/autonomous/weekly-review             → trigger weekly performance review
```
Header for all internal calls: `x-internal-key: {DAM_INTERNAL_KEY}`

**Beaver Solutions client_id:** `ce2fc8e5-617e-42d5-91fe-4275ceaa0030`

**Daily budget cap:** $20 USD (Beaver Solutions gets $20, other clients default $10)

---

## The Beaver Crew (agents inside The Dam)
| Agent | Model | Role |
|-------|-------|------|
| Captain Beaver | claude-sonnet-4-20250514 | Orchestration, plans, client comms |
| Research Beaver | claude-haiku-4-5 | Lead sourcing, signal detection |
| Sales Beaver | claude-sonnet-4-20250514 | Outreach drafts, follow-ups |
| Enforcer Beaver | claude-sonnet-4-20250514 | QA gate — every message passes through here |

---

## Key Decisions — Do Not Revisit

1. **Railway for hosting** (not Render, not Fly.io) — connected to GitHub, auto-deploys on push to main
2. **Supabase for DB** (not Railway Postgres) — separate from compute, RLS enabled
3. **Haiku for Research Beaver** — 4× cheaper, confirmed working in production
4. **No message sends without Enforcer + MJ approval** — this is non-negotiable, hard-coded in pipeline
5. **MyClaw Lite for Beaver Solutions** — upgrade to per-client instances when pilot converts to paid
6. **Internal API key auth for agent-to-agent calls** — not JWT, not OAuth
7. **Jarvis webhook belongs to MyClaw** — The Dam is send-only. Never re-register The Dam webhook to Jarvis.

---

## Lessons Learned

1. **Git Bash + multi-line curl commands don't work** — always give MJ single-line commands
   Fix: `bind 'set enable-bracketed-paste off'` first, then paste

2. **`industry` is stored in `metadata->>'industry'`** — NOT a top-level column in leads table
   leads table columns: name, email, company, title, linkedin_url, source, signal_tier, status, score, metadata

3. **Postgres expression indexes must use IMMUTABLE functions** — `timestamptz::date` is STABLE, crashes migration
   Fix: use range predicate `created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')` instead

4. **`const pool = require('../db/pool')` NOT `const { pool } = require('../db/pool')`**
   All 25 server files use direct import. Destructuring returns undefined.

5. **TRL is missing from the DB** — there are 4 clients seeded, not 5. TRL needs to be provisioned before pilot.

6. **`messages.metadata` was missing until migration 019** — column added 2026-04-06. Any query referencing `m.metadata` will fail on older DB.

7. **`approvals.resolved_at` NOT `reviewed_at`** — verified against migration 001. Use `resolved_at` in all approve/reject queries.

---

## People & Clients

| Person | Company | Context |
|--------|---------|---------|
| MJ | Beaver Solutions | Founder + operator. Wants 90% automation. |
| Adrian | TRL + The Gaming Company | Two separate clients. |
| Keith | The Gaming Company | Co-contact with Adrian. |
| Matthew Ho | MGMX Sdn Bhd | Malaysian company. Discovery call needed. |
| Michael | Emplifive | Influencer martech platform. Discovery call needed. |

---

## Bonus — Critical Single Facts

1. **Most important thing to know about MJ:** He wants systems that run without him. Every answer should move toward that.
2. **One preference to always remember:** No filler. No recap. Just the answer.
3. **Most annoying generic AI behaviour:** Starting every response with "Certainly! I'd be happy to help with that."
4. **What would make MJ trust Claw to act on its own:** Claw does exactly what it says. No hallucinated results. Fails loudly when something breaks.
5. **Six months from now, what Claw should know that it doesn't today:** Each client's ICP, past outreach performance, what angles worked, which leads converted and why.
