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

## Current State

- 39 migrations applied (001-039)
- AI Enforcer (rangerReview) active on all messages and follow-ups
- Captain validation gate active before Enforcer
- Timing-safe secret comparisons on all auth endpoints
- RLS enabled on all tenant-scoped tables
- 5 pilot clients onboarded (3 seeded + 3 manual)
- DB Builder running every 15min — Research Beaver continuously maintains lead pool (target: 200 ready leads per client)
- DB-first pipeline: impromptu chat/kickoff requests draw from pool before triggering cold research
- Don't-approach-twice: 14-day cooldown + NOT EXISTS check on in-pipeline messages
- Search stack: Brave → Google CSE → DuckDuckGo (Serper removed)
- n8n gated: only clients in `AUTONOMOUS_ENABLED_CLIENTS` env var receive n8n-triggered daily kickoffs
- LLM spend visible: `llm_usage` table, `/api/dashboard/llm-usage` endpoint, dashboard widget

## Key Files

| Area | Files |
|------|-------|
| Pipeline orchestration | `server/services/agents.js` (directorExecute, rangerReview, captainValidate, searchPersonalisationSignals) |
| Autonomous endpoints | `server/routes/autonomous.js` (kickoff, approve, reject, send-approved, chat) |
| Agent config/prompts | `server/config/agents.js` |
| Client configs | `clients/[slug]/config.md` |
| Shared agent rules | `clients/_core/agent-roles.md`, `clients/_core/ranger-rules.md` |
| DB Builder | `server/services/dbBuilder.js` |
| Search service | `server/services/searchService.js` (Brave → CSE → DDG chain) |
| Migrations | `server/db/migrations/001-039` |

## What NOT to build yet

- Playwright browser automation
- WhatsApp integration
- Advanced analytics / NRR tracking
- White label
- Scaling infrastructure
