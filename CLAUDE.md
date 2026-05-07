# The Dam v2 — Project Context

See parent CLAUDE.md at `../CLAUDE.md` for full architecture rules and agent intelligence.

## Quick Start

```bash
# Start everything
docker-compose up

# Frontend: http://localhost:5173
# Backend:  http://localhost:3001
# DB:       localhost:5432

# Seed login credentials
admin@beaversolutions.com / ***REMOVED***
admin@trl.com / ***REMOVED***
admin@thegamingcompany.com / ***REMOVED***
```

## Dev without Docker

```bash
# Terminal 1 — backend
cd server && npm install && node index.js

# Terminal 2 — frontend
cd client && npm install && npm run dev
```

Set `DATABASE_URL` in the root `.env` file (not server/.env).

## Current State (2026-05-05)

- **54+ migrations applied** (not 039). Latest: 054 (`agent_memory.agent` CHECK expanded for `market_sensor` + `captain_orchestrator`).
- **Phase 5 (Goal-Hunting) shipped 2026-05-03.** Captain Orchestrator drives the loop via the `agent_directives` bus (separate from chat-tool Captain Beaver).
- **Day 2 of Beaver Team Remodel shipped 2026-05-01.** Channel-router consolidated into `selectChannel()`. VP enrichment in draft path. Soft-reject TTL purge. Sales+Enforcer KPI self-reporting. Phase E live (9 sources × top-3 weighted signals × Haiku extraction).
- **Channel logic:** email-first by default (commit `ecfba3d`, 2026-04-30). `blocked_no_email` holds for enrichment; LinkedIn fallback at touch 3 only. Sender hardcoded to "Michael Jerry" for `beaver-solutions` tenant.
- **ICP v2 hard gate** at code level via `applyIcpV2Filter`. SMB target locked: boutique/independent agencies + B2B-services orgs (telemarketing/training/lead-gen/recruitment), 5–50 staff. Network agencies hard-rejected.
- **Operational target: 50 outreach/day** = 30 email + 20 LinkedIn (locked 2026-04-30, replaces 80/day). `routes/autonomous.js` has stale `|| 80` fallback — patch to `|| 50` when seen.
- **Migration ordering:** apply migration to Supabase BEFORE pushing dependent code. Reverse order crashes inserts.
- **DB:** Supabase project `the-dam-v2` / `zzvfisddztsinbnhfcnq`. Query via Supabase MCP, NOT local pg scripts. The Railway Postgres URL in any `.env` is a deprecated orphan.
- **Beaver Solutions tenant UUID:** `ce2fc8e5-617e-42d5-91fe-4275ceaa0030`
- **Trial cohort closed 2026-04-25.** Active tenants in DB: Beaver Solutions (active outbound), TRL / GamerExchange / Mastercard / Emplifive / MGMax (seeded, dormant). 0 paid conversions from W17 trial. Findings: leads not 100% ICP, LinkedIn-first bad, email-first confirmed.
- **Cron stack scheduled** (see parent CLAUDE.md § Background Jobs for the full list — morning brief 09:00, kickoff 09:30, market sensing 08:30, EOD 19:00, stuck-state hourly 09-19, etc.)
- **Removed:** `services/myclaw.js`, `routes/myclaw.js`, `services/apollo.js`. Don't reintroduce.
- **Enrichment:** Hunter `domainSearch` for email + `company_size`. No other paid vendors without MJ sign-off (`MJxClaude/memory/feedback_dont_pay_to_fix_bad_sourcing.md`).
- Search stack: Brave → Google CSE → DuckDuckGo (Serper removed)
- DB-first pipeline: impromptu chat/kickoff requests draw from pool before triggering cold research
- Don't-approach-twice: 14-day cooldown + NOT EXISTS check on in-pipeline messages
- LLM spend visible: `llm_usage` table, `/api/dashboard/llm-usage` endpoint, dashboard widget
- RLS enabled on all tenant-scoped tables. Timing-safe secret comparisons on all auth endpoints.

**Active blockers (per `01 — Product/roadmap.md`):**
- `DB_BUILDER_ENABLED_CLIENTS` env var on Railway not confirmed → directives sit unread
- `routes/autonomous.js` `|| 80` fallback (one-line patch)
- Gmail OAuth not browser-authorized for trial clients
- Calendar OAuth dead

## Key Files

| Area | Files |
|------|-------|
| Pipeline orchestration | `server/services/agents.js` (consolidated `selectChannel()`, `applyIcpV2Filter`, memory system) |
| Captain Orchestrator (goal-hunting loop) | `server/services/captainOrchestrator.js` — writes to `agent_directives` bus |
| Captain Beaver (chat tool) | `server/services/captainBeaver.js` — Telegram chat via `handleChat()`, plan generation |
| Autonomous endpoints | `server/routes/autonomous.js` (kickoff, approve, reject, send-approved, chat, linkedin-sync-replies) |
| Agent config/prompts | `server/config/agents.js` |
| Client configs | `clients/[slug]/config.md` |
| Shared agent rules | `clients/_core/agent-roles.md`, `clients/_core/ranger-rules.md` |
| DB Builder | `server/services/dbBuilder.js` |
| Search service | `server/services/searchService.js` (Brave → CSE → DDG chain) |
| Migrations | `server/db/migrations/001-054+` |
| Canonical product roadmap | `../01 — Product/roadmap.md` |
| Cross-brain memory | `../beaver-brain/MEMORY.md` |

## What NOT to build yet

- Playwright browser automation
- WhatsApp integration
- Advanced analytics / NRR tracking
- White label
- Scaling infrastructure
