# dam-run-campaign

## Purpose
Roy speaks naturally on Telegram. OpenClaw parses the intent, creates a Director plan, presents it for approval, then executes on Roy's go-ahead.

## Trigger
Roy says anything matching these patterns:
- "find [N] leads..."
- "start outreach to..."
- "reach out to..."
- "run a campaign..."
- "prospect [industry/role]..."
- "generate messages for..."

## Dependencies
- dam-authenticate must have run (DAM_TOKEN available)

## Steps

### Step 1 — Parse Roy's intent
Extract from Roy's message:
- `TARGET`: who to reach (e.g. "SaaS founders", "fintech CEOs", "e-commerce brands")
- `COUNT`: how many leads (default 10 if not specified)
- `LOCATION`: geography filter (default "Malaysia" if not specified)
- `CONTEXT`: any extra context Roy gave (tone, angle, offer)

### Step 2 — Build the command string
```
command = "Find {COUNT} {TARGET} in {LOCATION} and generate personalised cold outreach. {CONTEXT}"
```

### Step 3 — Get Director plan
```
POST {DAM_URL}/api/agents/director/plan
Authorization: Bearer {DAM_TOKEN}
Content-Type: application/json

{
  "command": "{command}"
}
```

Extract from response:
- `data.plan_id`
- `data.steps[]` — list of planned actions
- `data.interpretation` — Director's summary

### Step 4 — Present plan to Roy
Send Telegram message:
```
🦫 The Director has a plan.

📋 {data.interpretation}

Steps:
{for each step: "• {step.description}"}

Estimated: {step count} actions

Approve and run? Reply YES to proceed or NO to cancel.
```

Store `plan_id` as session variable `PENDING_PLAN_ID`.
Store `command` as `PENDING_COMMAND`.

### Step 5 — Wait for Roy's reply
- If Roy replies "YES", "yes", "approve", "go", "do it" → proceed to Step 6
- If Roy replies "NO", "no", "cancel", "stop" → send "Got it, campaign cancelled." and stop
- If no reply in 30 minutes → send reminder once, then expire after 1 hour

### Step 6 — Execute the plan
```
POST {DAM_URL}/api/agents/director/execute
Authorization: Bearer {DAM_TOKEN}
Content-Type: application/json

{
  "plan_id": "{PENDING_PLAN_ID}",
  "command": "{PENDING_COMMAND}"
}
```

This may take 2–5 minutes. Send "⏳ Running... I'll update you when done." while waiting.

### Step 7 — Report results to Roy
Extract from response:
- `data.summary.leads_found`
- `data.summary.messages_drafted`
- `data.summary.ranger_approved`
- `data.summary.ranger_rejected`
- `data.summary.pending_approvals`

Send Telegram:
```
✅ Campaign complete!

🔍 Leads found: {leads_found}
✉️ Messages drafted: {messages_drafted}
✅ Passed Ranger: {ranger_approved}
❌ Rejected by Ranger: {ranger_rejected}

⏳ {pending_approvals} message(s) waiting for your approval.
{if pending_approvals > 0: "→ https://app.beaver.solutions/approvals"}
```

### Step 8 — Write journal entry
```
POST {DAM_URL}/api/agents/memory/journal
Authorization: Bearer {DAM_TOKEN}

{
  "entry": "Campaign run: '{command}'. Results: {leads_found} leads, {ranger_approved} approved messages, {pending_approvals} pending approval."
}
```

## Error Handling
- If execute returns error: Send "⚠️ Campaign failed: {error message}. Check the Dam logs."
- If 401 at any step: Run dam-authenticate, retry once
- If execution takes >10 min: Send "⏳ Still running — this is taking longer than usual. Check https://app.beaver.solutions/logs"
