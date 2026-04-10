# Skill: dam-chat

## Trigger
Activate when MJ asks Claw to:
- Talk to Captain Beaver / The Dam in natural language
- Fire a custom command ("find 20 agency founders in KL", "run signal hunt", "what's my status")
- Check KPIs, approvals, replies, or memory
- Anything that doesn't fit the existing `dam-morning-brief`, `dam-approval-notify`, or `dam-reply-check` skills

## What This Skill Does
Sends a free-form command to The Dam's conversational bot endpoint. Captain Beaver interprets the intent (KPI query, kickoff command, signal hunt, etc.) and either responds with live data or dispatches the beavers in the background.

This is Claw's single entry point for any Dam operation that isn't covered by a purpose-built skill.

## Prerequisites
- `DAM_INTERNAL_KEY` stored in secrets
- Beaver Solutions client_id: `ce2fc8e5-617e-42d5-91fe-4275ceaa0030`

---

## Execution

```
POST https://app.beaver.solutions/api/autonomous/chat
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
  Content-Type: application/json
Body:
  {
    "client_id": "ce2fc8e5-617e-42d5-91fe-4275ceaa0030",
    "message": "<MJ's command or question, verbatim>",
    "thread_id": "<optional — pass the previous thread_id to continue a conversation>"
  }
```

### Response shape
```json
{
  "data": {
    "reply": "string — Captain Beaver's response for MJ",
    "actions_taken": ["array of actions the endpoint executed"],
    "data": { "context-specific payload": "..." },
    "thread_id": "thread_<timestamp>"
  }
}
```

---

## Intent Examples

### Status / KPI
```
Message: "what's my status today"
Response: Live counts — sent_today, pending_approval, leads_today, rejected_today
Use: for "how's the dam doing", "are we on track", "KPI check"
```

### Kickoff / Execute
```
Message: "find 20 marketing agency founders in KL"
Response: Fires directorExecute in background, returns plan_id
Use: for any "find X", "run Y", "kickoff" style command
```

### Approvals
```
Message: "any approvals pending"
Response: List of up to 10 pending messages with ranger scores
Use: for "what needs approval", "show queue"
```

### Signal Hunt
```
Message: "run signal hunt"
Response: Fires runSignalHunt in background — auto-triggers outreach on results
Use: for "find buying signals", "hiring triggers", "what's hot"
```

### Replies
```
Message: "any replies"
Response: List of leads who replied in the last 48 hours
Use: for "who responded", "check replies"
```

### Memory / ICP
```
Message: "what's my current ICP"
Response: Lists recent agent_memory entries
Use: for "show memory", "what are we targeting"
```

---

## How Claw Should Respond to MJ

After calling the endpoint:

1. **If reply field is populated** → relay it to MJ verbatim via Telegram.
2. **If the response includes structured data** (approvals list, KPI counts, replies list) → format it as a clean Telegram message with the actual values. Never dump raw JSON to MJ.
3. **If actions_taken includes triggered_director_execute or triggered_signal_hunt** → tell MJ it's running in the background and suggest the follow-up command to check progress.
4. **If the endpoint errored (non-200)** → alert MJ with the error code and a clear next action ("Dam API returned 401 — check DAM_INTERNAL_KEY", "Dam API timed out — check Railway status").

---

## Conversation Continuity

- Save the returned `thread_id` in the daily log under `dam_chat_threads`.
- On follow-up messages from MJ related to the same topic (e.g. MJ says "and what about yesterday" after asking about today), pass the same `thread_id` back to maintain context.
- Start a new thread when the topic clearly changes.

---

## Error Handling

| Error | Action |
|-------|--------|
| 401 Unauthorized | Check `DAM_INTERNAL_KEY` is set. Alert MJ. Stop. |
| 400 Missing fields | Bug — report to MJ, include body sent. |
| 500 Server error | Retry once after 3 seconds. If still fails, alert MJ with "Dam API error — check Railway logs." |
| Timeout (>30s) | Alert MJ. Many Dam operations are async, so a timeout here suggests infra issues. |

---

## Notes

- This endpoint is **fire-and-forget** for long-running operations. Kickoff and signal hunt return immediately with a confirmation — the actual work happens in the background over 30-180 seconds.
- For real-time progress, poll with a `status` message every 30-60 seconds after firing a command.
- This skill **does not replace** `dam-morning-brief` — that skill has a specific daily cadence and format. `dam-chat` is for ad-hoc commands outside that routine.
- Logs from chat interactions land in the `logs` table with `agent='captain'` and `action='chat_inbound'/'chat_reply'`. Claude-code and MJ can read them via the dashboard.
