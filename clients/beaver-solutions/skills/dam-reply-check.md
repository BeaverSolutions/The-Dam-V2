# Skill: dam-reply-check

## Trigger
Activate when MJ says:
- "check replies"
- "any replies?"
- "who replied?"
- "what's in the inbox?"
- "show replies"
- "any hot leads?"

Also runs automatically every 2 hours between 9AM and 6PM GMT+8.

## What This Skill Does
Checks BeavrDam for new prospect replies, classifies urgency by reply type (positive/neutral/objection/no-fit), and surfaces the most important threads first. MJ decides what to do with each one.

## Prerequisites
- `DAM_INTERNAL_KEY` stored in secrets
- Beaver Solutions client_id: `ce2fc8e5-617e-42d5-91fe-4275ceaa0030`

---

## Execution Steps

### Step 1 — Fetch recent replies

For manual trigger: use last 48 hours.
For automated 2-hour check: use last 3 hours (slight overlap to avoid gaps).

```
GET https://beavrdam-production.up.railway.app/api/autonomous/recent-replies?client_id=ce2fc8e5-617e-42d5-91fe-4275ceaa0030&hours={N}
Headers:
  x-internal-key: {DAM_INTERNAL_KEY}
```

### Step 2 — Classify and sort

Sort replies into tiers before presenting:

**Tier 1 — Act now (classification = positive)**
These are interested prospects. MJ should respond today.

**Tier 2 — Needs a response (classification = neutral or objection)**
Prospects who replied but didn't commit. Need a thoughtful follow-up.

**Tier 3 — No action needed (classification = no_fit)**
Hard nos, wrong person, unsubscribes. Flag for MJ's awareness but no action required.

**Unclassified — classification is null or missing**
BeavrDam hasn't classified this yet. Show it under "Needs review."

### Step 3 — Check for stall alerts

Stall = a lead that was contacted 3 or more days ago with no reply since, and no follow-up scheduled.

Note: BeavrDam tracks this internally. If `recent-replies` shows 0 results across 72 hours, flag it:
> "No replies in 72 hours. Consider checking stalled leads in BeavrDam UI."

### Step 4 — Build and send the reply report

If no replies found:
> "No new replies in the last {N} hours. Pipeline is quiet."

If replies found, send this format:

---
**Reply Check — {total} new** _(last {N}h, as of {time GMT+8})_

**HOT — Act today** 🔴
[For each Tier 1 reply]
- **{lead_name}** ({lead_title}, {lead_company})
  Replied {replied_at in GMT+8}
  > "{reply_body truncated to 120 chars}..."
  Classification: Positive — Sales Beaver should offer 2 time slots

**Needs response** 🟡
[For each Tier 2 reply]
- **{lead_name}** ({lead_company})
  Replied {replied_at in GMT+8}
  > "{reply_body truncated to 120 chars}..."
  Classification: {Neutral / Objection}

**FYI — No action needed** ⚫
[For each Tier 3 reply — one line only]
- {lead_name} ({lead_company}) — {classification}

---

**Next step:** Open BeavrDam to draft responses, or reply "draft response for {lead_name}" and I'll queue it via Sales Beaver.

---

### Step 5 — Log to daily notes
`[{time GMT+8}] Reply check: {total} replies found. Hot: {tier1_count}. Neutral/objection: {tier2_count}. No-fit: {tier3_count}.`

---

## Special Cases

### "Draft response for {lead_name}"
When MJ replies with this after seeing the reply check, Claw should:
1. Note the lead and classification from the reply data
2. Tell MJ: "Sales Beaver is queued to draft for {lead_name}. This will appear in your approvals queue after Enforcer reviews it. Run 'show approvals' in a few minutes."
3. Note: Claw does not directly call Sales Beaver. The kickoff cycle handles drafting. This is informational.

### Positive reply from a referred lead
If `lead_company` or `lead_name` is flagged as referred in metadata, surface it at the top regardless of tier:
> "REFERRED LEAD replied — {lead_name} via {connector name}. Handle personally."

### Two reschedules from same lead
If the daily notes or metadata show 2+ reschedules from the same lead, flag it:
> "{lead_name} has rescheduled twice. BeavrDam will auto-move to Nurture. No further outreach."

---

## Automated Run Rules (every 2 hours, 9AM–6PM GMT+8)

- Only notify MJ if Tier 1 (positive) replies are found.
- If only Tier 2/3 replies found, batch them for the next morning brief. Do not interrupt MJ.
- If no replies: stay silent. Do not send "all clear" messages.
- Exception: if 5+ replies come in within a 2-hour window, alert regardless of tier — unusual volume may signal a campaign spike.

---

## Error Handling

| Error | Action |
|-------|--------|
| GET recent-replies fails | "Could not check replies — [error]. Check Railway." |
| Timeout | "Reply check timed out. Try again." |
| Empty data array with 200 OK | "No replies found. Pipeline is quiet." — this is normal |
