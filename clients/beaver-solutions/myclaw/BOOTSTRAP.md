# BOOTSTRAP.md — Claw Startup Sequence

Run this sequence every time a new session starts. Fully automatic. Silent unless something is wrong or MJ needs a prompt.

---

## Step 1 — Load Identity Files

Load in this exact order:
1. `AGENTS.md` — rules of engagement
2. `USER.md` — who MJ is
3. `IDENTITY.md` — who Claw is
4. `SOUL.md` — how Claw behaves
5. `MEMORY.md` — permanent context
6. `TOOLS.md` — environment references

If any file fails to load: report to MJ immediately. Do not proceed without AGENTS.md, USER.md, or MEMORY.md — these are non-negotiable.

---

## Step 2 — Load Today's Daily Log

Check for `memory/YYYY-MM-DD.md` where YYYY-MM-DD is today's date in GMT+8.

- If the file exists: load it. This is today's running context.
- If it does not exist: create it with a single header line:

```
# Daily Log — {Day}, {Date} (GMT+8)

[Session started {HH:MM GMT+8}]
```

---

## Step 3 — Check The Dam API

Ping the pending-approvals endpoint to confirm The Dam is reachable:

```
GET https://the-dam-v2-production.up.railway.app/api/autonomous/pending-approvals?client_id=ce2fc8e5-617e-42d5-91fe-4275ceaa0030
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
```

| Result | Action |
|--------|--------|
| 200 OK | Silent. Continue. |
| Timeout (>10s) | Alert MJ: "The Dam is not responding. Check Railway." Stop here. |
| 401 Unauthorized | Alert MJ: "Internal key rejected. Check DAM_INTERNAL_KEY secret." Stop here. |
| 500 Error | Alert MJ: "The Dam returned a server error on startup. Check Railway logs." Continue with reduced capability. |

Record result in today's daily log:
```
[{HH:MM}] Bootstrap — The Dam: {status}
```

---

## Step 4 — Check Morning Brief Status

Read today's daily log. Has a morning brief already been sent today?

- Look for the line: `Morning brief fired.`
- If found: skip. Do not re-fire the kickoff.
- If not found AND current time is between 8:00AM and 10:00AM GMT+8: activate `dam-morning-brief.md` now.
- If not found AND current time is after 10:00AM: do not fire kickoff. Note it in the log:

```
[{HH:MM}] Bootstrap — Morning brief was not sent today. Session started late.
```

---

## Step 5 — Check Pending Approvals

Use the data already fetched in Step 3.

- If 0 approvals: silent.
- If 1–4 approvals: note in daily log. Include in next interaction if MJ asks what's on.
- If 5+ approvals: alert MJ immediately:

```
Queue alert: {N} messages are waiting for your approval. Reply "show approvals" to review.
```

---

## Step 6 — Set Up Scheduled Tasks

Register cron jobs if not already running. Check `memory/heartbeat-state.json` to see which are active.

| Job | Schedule (GMT+8) | Skill |
|-----|-----------------|-------|
| Morning brief | 8:00 AM daily | `dam-morning-brief.md` |
| Reply check | Every 2 hours, 9AM–6PM weekdays | `dam-reply-check.md` |
| Heartbeat | Every 4 hours | `HEARTBEAT.md` |

If any job is missing from the state file: register it and log:
```
[{HH:MM}] Bootstrap — Registered cron: {job name}
```

---

## Step 7 — Ready

Bootstrap complete. Log it:
```
[{HH:MM}] Bootstrap complete. The Dam: {status}. Approvals: {N}. Crons: active.
```

Send nothing to MJ unless:
- The Dam is down
- 5+ approvals are queued
- A cron job failed to register
- Morning brief was missed and it's before 10AM

Otherwise: stay silent. Wait for MJ or the first scheduled trigger.

---

## Bootstrap Failure Protocol

If Steps 1–3 cannot complete:

1. Log the failure to `memory/YYYY-MM-DD.md` with the error
2. Send MJ one message:

```
Claw failed to start cleanly.
Issue: {what failed}
Error: {exact message}
Fix: {suggested action}
```

3. Enter standby. Respond to MJ's messages but do not run any automated tasks until the issue is resolved.
