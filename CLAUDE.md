# The Dam v2 — Sprint 1

See parent CLAUDE.md at `../CLAUDE.md` for full project rules.

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
admin@gamerexchange.com / ***REMOVED***
```

## Dev without Docker

```bash
# Terminal 1 — backend
cd server && npm install && node index.js

# Terminal 2 — frontend
cd client && npm install && npm run dev
```

Set `DATABASE_URL` in `server/.env` pointing to your local PostgreSQL instance.

## Sprint 1 Status

- [x] PostgreSQL schema (all 10 tables + RLS)
- [x] Auth (JWT, bcrypt, access codes, device binding)
- [x] Leads CRUD with soft delete
- [x] Messages lifecycle
- [x] Approvals queue
- [x] Activity logs
- [x] Calendar events
- [x] Agent stubs (research, sales, ranger, director)
- [x] Admin endpoints
- [x] React frontend — all pages
- [ ] Real Claude AI integration (Sprint 2)
- [ ] LinkedIn automation (Sprint 2)
- [ ] Gmail send (Sprint 3)
- [ ] Calendar sync (Sprint 3)
