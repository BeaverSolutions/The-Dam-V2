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

- 25 migrations applied (001-025) + 2 audit fixes (026-027)
- AI Enforcer (rangerReview) active on all messages and follow-ups
- Captain validation gate active before Enforcer
- Timing-safe secret comparisons on all auth endpoints
- RLS enabled on all tenant-scoped tables
- 5 pilot clients onboarded (3 seeded + 3 manual)
- Autonomous pipeline: n8n triggers → Captain → Research → Sales → Enforcer → Approval → Send

## Key Files

| Area | Files |
|------|-------|
| Pipeline orchestration | `server/services/agents.js` (directorExecute, rangerReview, captainValidate) |
| Autonomous endpoints | `server/routes/autonomous.js` (kickoff, approve, reject, send-approved) |
| Agent config/prompts | `server/config/agents.js` |
| Client configs | `clients/[slug]/config.md` |
| Shared agent rules | `clients/_core/agent-roles.md`, `clients/_core/ranger-rules.md` |
| Migrations | `server/db/migrations/001-027` |

## What NOT to build yet

- Playwright browser automation
- WhatsApp integration
- Advanced analytics / NRR tracking
- White label
- Scaling infrastructure
