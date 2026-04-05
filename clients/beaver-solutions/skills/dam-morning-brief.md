# Skill: dam-morning-brief

## Trigger
Activate when:
- It is 8:00 AM GMT+8 (daily cron)
- MJ says: "morning brief", "start the day", "what's on today", "kickoff"
- MJ sends a message first thing in the morning with no other context

## What This Skill Does
Fires The Dam's autonomous daily kickoff for Beaver Solutions, waits for initial processing, then pulls a full status summary and delivers it to MJ in one clean message. This is MJ's daily operating brief.

## Prerequisites
- `DAM_INTERNAL_KEY` stored in secrets
- Beaver Solutions client_id: `ce2fc8e5-617e-42d5-91fe-4275ceaa0030`

---

## Execution Steps

### Step 1 — Fire the kickoff
```
POST https://the-dam-v2-production.up.railway.app/api/autonomous/kickoff
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
  Content-Type: application/json
Body:
  {"client_id":"ce2fc8e5-617e-42d5-91fe-4275ceaa0030"}
```
Expected response: `{"data":{"status":"kickoff_started","client_id":"..."}}`

If response is not `kickoff_started`:
- Report error to MJ immediately: "The Dam kickoff failed — [error]. Check Railway logs."
- Stop here. Do not proceed.

Send confirmation to MJ: "Kickoff fired. Fetching status in 45 seconds..."

### Step 2 — Wait
Wait 45 seconds. The Dam agents run in the background during this time.

### Step 3 — Pull pending approvals
```
GET https://the-dam-v2-production.up.railway.app/api/autonomous/pending-approvals?client_id=ce2fc8e5-617e-42d5-91fe-4275ceaa0030
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
```
Store the full response as `approvals_data`.

### Step 4 — Pull recent replies (last 24h)
```
GET https://the-dam-v2-production.up.railway.app/api/autonomous/recent-replies?client_id=ce2fc8e5-617e-42d5-91fe-4275ceaa0030&hours=24
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
```
Store as `replies_data`.

### Step 5 — Check today's date and log
Write a one-line entry to `memory/YYYY-MM-DD.md`:
```
[08:00 GMT+8] Morning brief fired. Approvals: {count}. Replies: {count}.
```

### Step 6 — Build and send the morning brief

Format the message exactly like this. Replace values with real data. Convert all times to GMT+8.

---

**Good morning. Here's your brief.**

**Replies needing response** ← most urgent, show first
[If replies_data.meta.total > 0]
List each reply:
- {lead_name} ({lead_company}) — {classification} — replied at {replied_at in GMT+8}
  > "{reply_body truncated to 80 chars}..."

[If no replies]
- No new replies in the last 24 hours.

---

**Pending approvals** ← messages drafted and waiting for MJ to approve
[If approvals_data.meta.total > 0]
List each approval (max 5, flag if more):
- #{index} {lead_name} ({lead_company}) — {channel} — {subject}
  > "{body truncated to 100 chars}..."

[If more than 5]
- ...and {remaining} more. Reply "show approvals" to see all.

[If no approvals]
- No messages pending approval.

---

**Actions**
- Reply `approve #1` to approve a message
- Reply `reject #1` to reject a message
- Reply `show approvals` for full message content
- Reply `check replies` to see all reply threads

---

Send this as a single Telegram message. No preamble. No "Good job!" No padding.

---

## Error Handling

| Error | Action |
|-------|--------|
| Kickoff POST fails (non-200) | Alert MJ, stop. Include error message. |
| Approvals GET fails | Report "Could not fetch approvals — [error]" but still deliver rest of brief |
| Replies GET fails | Report "Could not fetch replies — [error]" but still deliver rest of brief |
| Both secondary fetches fail | Report "The Dam API may be down. Check Railway." |
| Timeout (>30s on any call) | Flag as timeout, report to MJ, suggest checking Railway |

---

## Notes
- The kickoff itself takes 30–120 seconds to complete in the background. The brief shows what was queued from yesterday plus any urgent items from today. New messages from today's kickoff appear in the approvals queue throughout the morning.
- If MJ runs this outside work hours, still fire it but note "outside work hours" in the log.
- Only fire kickoff once per day. If already fired today (check daily log), skip Step 1–2 and go straight to Step 3–6.
