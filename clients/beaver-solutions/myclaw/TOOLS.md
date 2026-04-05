# TOOLS.md — Claw's Environment

Environment-specific references. Skills = how to use tools. This file = the specific config for MJ's setup.

---

## The Dam API

| Item | Value |
|------|-------|
| Base URL | `https://the-dam-v2-production.up.railway.app` |
| Auth header | `x-internal-key: {DAM_INTERNAL_KEY}` |
| Content-Type | `application/json` |
| Secret storage | MyClaw secrets → key name: `DAM_INTERNAL_KEY` |

**Beaver Solutions client_id:** `ce2fc8e5-617e-42d5-91fe-4275ceaa0030`

### Endpoints Claw Uses

```
POST /api/autonomous/kickoff
     Body: {"client_id":"<uuid>"}
     → Fires Captain Beaver daily run

GET  /api/autonomous/pending-approvals?client_id=<uuid>
     → Returns full message + lead context for all pending approvals

POST /api/autonomous/approve
     Body: {"approval_id":"<uuid>","client_id":"<uuid>"}
     → Approves a message, moves it to pending_send

POST /api/autonomous/reject
     Body: {"approval_id":"<uuid>","client_id":"<uuid>","reason":"<string>"}
     → Rejects a message, logs reason

GET  /api/autonomous/recent-replies?client_id=<uuid>&hours=24
     → Returns leads who replied in the last N hours

POST /api/autonomous/weekly-review
     Body: {} (no body needed, internal key only)
     → Triggers weekly performance review
```

### Response Format
```json
// Success
{ "data": {}, "meta": {} }

// Error
{ "error": "message", "code": "ERROR_CODE" }
```

---

## Telegram Channel

| Item | Value |
|------|-------|
| Primary channel | Private DM with MJ |
| MJ's handle | @[MJ's handle — fill in] |
| Language | English, Malaysian English OK |
| Timezone for all times | GMT+8 |

---

## Memory Locations

| File | Purpose |
|------|---------|
| `MEMORY.md` | Permanent facts — always loaded |
| `memory/YYYY-MM-DD.md` | Daily running log — today's events |
| `AGENTS.md` | Rules of engagement — always loaded |
| `USER.md` | Who MJ is — always loaded |
| `IDENTITY.md` | Who Claw is |
| `SOUL.md` | How Claw behaves |
| `TOOLS.md` | This file |

---

## Skills

| Skill file | When it runs |
|-----------|-------------|
| `dam-morning-brief.md` | 8AM GMT+8 daily, or "morning brief" / "start the day" |
| `dam-approval-notify.md` | "show approvals" / "any approvals?" / "what needs approval?" |
| `dam-reply-check.md` | "check replies" / "any replies?" / every 2 hours 9AM–6PM |

---

## Notification Rules

- All messages to MJ go to private Telegram DM.
- No financial figures in any group chat.
- Critical alerts: immediate.
- Routine status: batch into morning brief where possible.
- Never send the same notification twice for the same event.
