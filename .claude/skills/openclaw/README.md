# OpenClaw × The Dam — Skill Vault

This folder is the OpenClaw Obsidian vault. Open it in Obsidian on the dedicated PC account.

## Architecture

```
Roy (Telegram)
  ↓
OpenClaw (this PC account — runs 24/7)
  ↓  uses skills below
The Dam API (Railway — https://app.beaver.solutions)
  ↓
Director → Research → Sales → Enforcer → Approvals
  ↓
Gmail → Lead
```

## Environment Variables (store as OpenClaw secrets — never in skill files)

| Variable | Value | Where to get it |
|----------|-------|-----------------|
| `DAM_URL` | `https://app.beaver.solutions` | Fixed |
| `DAM_EMAIL` | `admin@beaversolutions.com` | The Dam login |
| `DAM_PASSWORD` | [your password] | The Dam login |
| `DAM_CLIENT_ID` | [Beaver Solutions UUID] | Supabase → clients table |
| `INTERNAL_API_KEY` | [Railway env var] | Railway → The Dam server env |
| `TELEGRAM_CHAT_ID` | [your chat ID] | Already set up |

## Skills (load all into OpenClaw)

| Skill | Schedule | Purpose |
|-------|----------|---------|
| `dam-authenticate` | On startup + every 6 days | Login and store JWT |
| `dam-morning-brief` | Weekdays 8:00 AM | Daily pipeline status to Roy |
| `dam-run-campaign` | On Roy's command | Full campaign: find leads → draft → approve → send |
| `dam-approval-notify` | Every 30 min, 9AM–7PM | Nudge Roy when messages await approval |
| `dam-reply-check` | Every 15 min, 8AM–9PM | Alert Roy when leads reply |
| `dam-followup` | Weekdays 9:00 AM | Trigger follow-up sequences |
| `dam-signal-hunt` | Every 6 hours | Proactive buying signal detection → lead creation |
| `dam-weekly-export` | Sundays 11:00 PM | Master database + per-client tracker export |

## Shared Memory Contract

MyClaw and Claude share the same `agent_memory` table via `/api/myclaw/memory`. Both systems read and write to the same keys. This is how they stay aligned without direct communication.

| Memory Key | Owner | Purpose |
|------------|-------|---------|
| `icp` | Claude / MJ | Client ICP — industries, titles, geographies |
| `signal_hunt_config` | MJ / Claude | Signal types to prioritise, excluded companies |
| `signal_hunt_log` | MyClaw | Last run results, queries used, signals found |
| `signal_patterns` | MyClaw | Which signal types produce best leads (auto-learned) |
| `used_signal_queries` | MyClaw | Query dedup — prevents repeating same searches |
| `used_queries` | Claude | Research Beaver query dedup |
| `schema_facts` | Claude | Verified DB columns and API facts |
| `myclaw_rejections` | MyClaw | Enforcer rejection patterns |

**Rule:** Before writing to a shared key, always READ it first to avoid overwriting the other system's data. Merge, don't replace.

## Golden Rule

**OpenClaw never auto-approves or auto-sends messages.**
Every message drafted by Sales Beaver must pass:
1. Enforcer Beaver (automatic — built into The Dam)
2. Roy's manual approval (in the web app or via Telegram)

Only then does it send.

## Setup Order

1. Install OpenClaw on dedicated PC account
2. Open this folder as Obsidian vault
3. Add all env variables as OpenClaw secrets
4. Load each skill file into OpenClaw
5. Run `dam-authenticate` manually — confirm "Authenticated" message
6. Run `dam-morning-brief` manually — confirm brief arrives on Telegram
7. Test campaign: type "Find 5 test leads in KL" on Telegram
8. Confirm full pipeline runs end-to-end
