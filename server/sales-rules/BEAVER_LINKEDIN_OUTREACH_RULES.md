<!-- DEPLOYED COPY. Edit MJxClaude/sales-assets/ first, then sync here. -->
<!-- Sync direction: MJxClaude/sales-assets/ → beavrdam/server/sales-rules/ -->
<!-- Last sync: 2026-05-06 -->

# Beaver Solutions / BeavrDam LinkedIn Outreach Rules — v1.0

> For use by the Sales Beaver agent (BeavrDam) when drafting any LinkedIn message on behalf of MJ / Beaver Solutions.
> v1.0 mirrors Emplifive Outreach Rules v2.3 structure, adapted for BeavrDam's pain set (outbound itself) and pre-proof state.
> Last updated: 2026-05-06
> **MANDATORY: Cowork-Beaver and the Sales Beaver agent must Read this file at every session start / every drafting cycle, before generating any DM.**

---

## v1.0 release notes (2026-05-06)

**Why this exists:** BeavrDam's previous DM template (sample sent to Zheng Yen at Mackyclyde SEO) was generating ~1-3% reply rates. Failure modes:
- Pretended to be personal but didn't name the company or any specific signal
- Lectured ("SEO agencies that win consistently...")
- Used "Most founders I talk to..." (recognised cold-outreach tell)
- Asked an essay-question ("At what point does the time spent...") that requires reflection, not a 5-second reply

v1.0 imports the Emplifive v2.3 structural framework (verifiable trigger + Path A/Path B split + opt-out + validators) and adapts it to BeavrDam's product reality: BeavrDam sells outbound automation, so every value hook anchors to outbound pain (not the prospect's vertical-specific pain).

### Two key differences from Emplifive v2.3

1. **Path A (vertical-matched proof anchor) is currently DISABLED for Beaver.** Reason: Beaver Solutions has 0 paying clients as of 2026-04-30 with documented outbound outcomes. Until at least 1 client has a verifiable, prospect-facing outcome statement in `BEAVER_PROOF_NUMBERS.md`, every cold DM defaults to Path B (engagement-led).
2. **Pain set is outbound, not influencer ops.** Every Path B value hook (line 3) must tie back to one of five approved BeavrDam pains. See section "Segment-pain whitelist" below.

---

## The One Thing That Matters

Every message moves the conversation toward a booked discovery call OR a qualified disqualification. Friendly replies, soft questions, and "let's stay in touch" loops are not progress.

---

## The 4-part Cold Message Structure

Every cold first message has four parts. If any required part is missing, regenerate.

### Part 1 — Trigger anchor (mandatory)

A verifiable event in their world from the last 60 days. Same 10 signal types as Emplifive v2.1:

1. LinkedIn post by them or their company in the last 60 days
2. Trade press / news mention (verified)
3. Hire or job posting (especially sales / BD / SDR roles)
4. Partnership, expansion, product launch, funding
5. Talk, podcast, panel appearance
6. A named campaign visible publicly
7. Their company mentioned in another company's post or press
8. Predecessor's exit / their promotion / leadership change
9. Industry event sponsored or attended
10. Regulatory or industry shift directly affecting their vertical

NOT acceptable: logical inference, generic festive greetings, pure connection acceptance, "I see your industry is X" without a specific event.

Verification: every trigger must be findable via web search, Hunter, or LinkedIn scrape. If the research agent did not produce a verifiable trigger, do NOT draft. Skip the prospect or route back to research.

### Part 2 — Proof anchor (CONDITIONAL — currently DISABLED for Beaver)

**Status: SKIP** until `BEAVER_PROOF_NUMBERS.md` lists at least 1 VERIFIED outcome statement.

When the file is populated, the rule mirrors Emplifive v2.3:
- Use only when the prospect's segment matches a verified outcome statement
- One client name, one specific number, exact wording from the source-of-truth file
- No paraphrasing, no interpolation
- If no segment-matched entry exists, default to Path B

For now, every cold DM goes Path B.

### Part 3 — The ask (Path A or Path B)

#### Path A — Deliverable-led (DISABLED for Beaver until Path 2 has a real asset)
"Mind if I send the [real asset]?" Currently no Beaver assets in production. Skip.

#### Path B — Engagement-led (DEFAULT for all Beaver cold DMs)

A 1-3-word-answerable diagnostic question grounded in their specific outbound reality.

Constraints:
- Answerable in 1-3 words: yes/no, a number, a percentage, a frequency (rarely / weekly / daily), a pick-one (in-house / agency, daily / weekly)
- Max 14 words in the question itself
- Must end in "?"
- Must connect to outbound, prospecting, pipeline, or sales-team-time pain (not the prospect's vertical-specific pain)

Approved Path B question patterns for Beaver:
- "How many hours a week is the team spending on cold outreach right now?"
- "What % of inbound vs outbound is filling pipeline this quarter?"
- "How many DMs is the team sending weekly to fill pipeline?"
- "Who's running outbound right now — you, an SDR, or an agency?"
- "What reply rate are you seeing on cold LinkedIn templates lately?"
- "How often does outbound become a Friday afternoon problem, weekly or rarely?"

### Part 4 — Opt-out clause (varied)

Approved variants (rotate across batch — never the same closer twice in a row):
- "If outbound isn't a 2026 priority, no worries."
- "Happy to drop it here, no obligation."
- "If pipeline's full, no rush."
- "If timing's off, no need to reply."
- Implicit (omit when the question is already low-cost)

---

## Segment-pain whitelist (NEW — Beaver-specific)

Every Path B line 3 must tie back to ONE of these five approved BeavrDam pains. If the generated value hook does not anchor to one of these, reject and regenerate.

1. **Hours spent on manual prospecting and DM writing** (founder/SDR doing it personally)
2. **Low reply rates on generic templates** (1-5% baseline)
3. **Founder/principal doing outbound instead of delegating** (deal-flow capped by founder time)
4. **Pipeline gap between current outreach volume and target meetings** (running 200 DMs/month, getting 2 meetings)
5. **Inconsistent outbound** (busy-week-quiet-week pattern killing pipeline predictability)

If the writer agent generates a hook that anchors to the prospect's vertical-specific pain (e.g., SEO ranking issues for an SEO agency), reject. Beaver sells outbound automation. Every DM must position outbound as the pain.

---

## Cold message examples (v1.0-compliant)

### Path B example 1 — Agency founder, trigger = recent post

> Hi Zheng Yen, saw Mackyclyde is running SEO retainers across SEA. Quick question: how many hours a week does the team spend on cold outreach to fill the pipeline? Asking because outbound is eating 8-10 hours a week for most agency founders running their own pipeline in MY/SG, with reply rates under 5% on generic templates. If outbound isn't a 2026 priority, no worries.

Trigger: Mackyclyde anchor (specific company + service). Path B (no Beaver case study). Question: "X hours" or "too many" — 1-3 words. Pain anchor: hours on outreach (whitelist #1) + low reply rates (whitelist #2). Opt-out: present, varied. Word count: 67. 4 sentences.

### Path B example 2 — B2B founder, trigger = funding announcement

> Hi [first_name], saw [Company] closed the [round] last month. Quick question: now that you're scaling, is outbound running through you, an SDR hire, or an agency? Asking because most founders post-raise are still personally writing 50+ DMs a week before they delegate, and pipeline volatility tracks the founder's calendar. Happy to drop the BeavrDam walkthrough here if useful, no obligation.

Trigger: funding event verified. Path B. Question: pick-one (founder / SDR / agency) — 1-3 words. Pain anchor: founder doing outbound (whitelist #3) + inconsistent outbound (whitelist #5). Opt-out: varied phrasing. *(Note: walkthrough mention assumes the asset exists. If not in Andika-equivalent Beaver library, drop the offer line.)*

### Path B example 3 — SDR-led sales team, trigger = SDR job posting

> Hi [first_name], saw [Company] is hiring an SDR on LinkedIn. Quick question: what reply rate is your current SDR pulling on cold LinkedIn DMs, weekly average? Asking because the agencies and B2B teams in MY/SG using AI for prospecting research are clearing 10-15% on personalised sends — generic templates are still stuck at 1-5%. If pipeline's already full, no rush.

Trigger: hire event. Path B. Question: "X%" or rough range — 1-3 words. Pain anchor: low reply rates (whitelist #2) + pipeline gap (whitelist #4). Opt-out: varied.

---

## Hard limits

- 4 sentences MAX after greeting. 3 is better.
- Total word count under 70.
- No em dashes anywhere.
- No vendor-speak ("we help teams like yours", "leverage", "we work with").
- No qualification questions ("do you do outbound?") — assume they do, ask HOW.
- No soft CTAs ("worth a chat", "15 minutes this week", "happy to jump on a call") on first or second message.
- No formal sign-offs. End with the question or with "Michael".
- Sign as Michael, never MJ.
- No bullet points inside prospect-facing messages.
- Malaysian tone: warm + direct.

---

## Banned-phrase regex (auto-reject at draft time)

Any draft containing the following must be rejected and regenerated. Max 3 regen attempts before routing back to research.

- "Most founders I talk to" / "Most [persona] I talk to" pattern
- "At what point does" / "How do you think about" / "What's your approach to"
- "I help" or "I work with" as the opening verb
- "leverage" / "leveraging"
- "we help teams like yours" / "agencies like yours" / "founders like you"
- "worth a chat" / "15 minutes this week" / "happy to jump on a call" on first/second message
- "passionate about" / "results-driven"
- Em dashes (—)
- "Hope this finds you well" / "I hope you're doing well"

Structural rejects:
- More than 4 sentences after greeting
- Total word count over 70
- Question not ending in "?"
- Question over 14 words
- Line 1 missing `{{company_name}}` or a specific named asset (service, client, market, post topic)
- Value hook (line 3) NOT tied to the segment-pain whitelist

---

## Required-input contract (drop, don't fall back)

Before drafting, validate ALL of the following are present and non-null:

| Field | Type | Notes |
|---|---|---|
| `first_name` | string | Required |
| `company_name` | string | Required, must appear in line 1 |
| `persona_segment` | string | e.g., "B2B founder running outbound in MY" |
| `verifiable_trigger` | object | `{text, date, source_url}` — last 60 days |
| `vertical_match` | boolean | Drives Path A/B (currently always false for Beaver) |
| `segment_pain_id` | int (1-5) | Which whitelist pain anchors line 3 |
| `deliverable_id` | string \| null | Only if a real Beaver asset exists; else null |

If any required field is null, mark prospect as `needs_more_research` and route back to Research Beaver. Do NOT generate a fallback DM with generic copy.

---

## Approved-numbers list reference

All numeric claims in cold DMs must come from `sales-assets/BEAVER_PROOF_NUMBERS.md`. Validator: any "%" or numeric range in the generated draft is checked against the approved list. If not matched, reject.

Currently approved benchmark numbers (industry, not client-specific):
- 1-5% reply rate (generic cold LinkedIn templates)
- 10-15% reply rate (personalised research-led LinkedIn)
- 1-3% reply rate (generic cold email)
- 8-12% reply rate (personalised cold email)
- 6-12 hours/week (founder-led outbound time)
- 50+ DMs/week (typical founder-led outbound volume)

Anything else: not approved, do not cite.

---

## Hallucination guard

The Sales Beaver agent must NOT invent:
- Specific BeavrDam outcomes (e.g., "we get 15% reply rates") — only cite when added to BEAVER_PROOF_NUMBERS.md as VERIFIED
- Named competitor performance claims
- Industry stats with decimal precision (e.g., "32.4% of founders...")
- Client testimonials, client names, client outcomes (no clients yet with verified outcomes)

Any of the above triggers an immediate reject. If the writer agent attempts to cite a number not on the approved list, log the violation to `logs/beavrdam-hallucination-attempts.md` for review.

---

## Warm intro (someone referred you)

The connector's name does the heavy lifting. Different rules apply.

Structure: Connector's name + one specific observation about prospect's work + one conversational question. No ask in DM 1. No proof anchor needed (the connector IS the proof).

> Hi [first_name], Michael here from Beaver Solutions. [Connector] mentioned your name and said it'd be good to connect. [Specific observation about their company]. Curious how outbound is running on your side right now.

Meeting ask comes only after they reply.

---

## When they reply

**They engage / show interest:**
Diagnostic question first, THEN suggest a 15-min slot with two specific times.

> Good to hear. Before I send anything over: is outbound running in-house or through an agency right now? Want to make sure 15 mins is actually useful. Tuesday 11am or Wednesday 3pm MYT?

**They say "not the right time" / "no budget":**
Ask what would change. If vague, tag nurture and stop.

**They say "we already have a tool":**
Ask which one and where the gap is.

> Good to know. Is it mainly for sending or for prospect research too? Want to know if there's still a gap worth talking about.

**They went silent after a diagnostic question (5-7 days):**
Replace the open diagnostic with a binary-frame pattern observation grounded in their context. Same play as Emplifive v2.2 silent-after-diagnostic move. One-word reply either way.

> [first_name], no rush on the [topic] question. Most [their specific setup] default to [specific pattern], and [hidden pain] quietly slips. Sound familiar, or running it differently?

---

## Follow-up sequence

Three follow-ups max. Day 3, Day 7, Day 14. Each must say something new.

- **FU1 (Day 3):** new trigger from their world (different post, news, hire). No pitch.
- **FU2 (Day 7):** Path B value hook with a different segment-pain angle than DM 1. Diagnostic question.
- **FU3 (Day 14):** Escalate stakeholder OR value-leave (drop a relevant asset if one exists). NOT a break-up.

After FU3 with no reply: move to nurture, stop. Re-engage only on a fresh trigger event.

---

## Channel triangulation

| Day | Channel | Format |
|---|---|---|
| 0 | LinkedIn connection request + note | ≤300 chars, observation only, no ask |
| 0 (same day) | Email if Hunter-verified | Full 4-part Path B structure |
| 2 (after LI accept) | LinkedIn DM | Reference connection accept + light nudge on email |
| 4 | LinkedIn DM | Different trigger angle, full Path B |
| 7 | WhatsApp if number publicly available | Casual one-liner, mobile formatting |
| 14 | LinkedIn DM | FU3 (escalate or value-leave) |

WhatsApp rules: only if number is publicly listed. Once is enough. Never scrape from private sources.

---

## Measurement & variant testing

Every batch of 50+ cold sends must split across 3-5 variants. No single-variant batches.

Tracking schema (Supabase table on Beaver Solutions tenant):

| Column | Type | Notes |
|---|---|---|
| variant_id | A/B/C/D/E | Locked at send time |
| prospect_id | uuid | FK to prospects table |
| persona_segment | text | For slicing |
| trigger_type | text | post / hire / funding / campaign / event |
| send_date | date | |
| send_channel | text | LI / Email / WhatsApp |
| reply_at | date \| null | |
| reply_type | text | positive / neutral / objection / nofit |
| meeting_booked | boolean | |
| segment_pain_id | int | Which of the 5 was anchored |

Rules:
- Min 10 sends per variant before drawing conclusions
- After 50 total sends, kill bottom variant, double top variant in next batch
- After 200 sends, persona-slice (Founder vs SDR vs Agency reply rates per variant)
- Weekly review (Friday PM) to call winners + losers

Failure modes:
- All variants tied within 1 reply rate point → batch too small or variants too similar. Re-design.
- All variants ≤2% reply rate → messaging probably isn't the leak. Audit the prospect list (ICP gate).
- One variant 3×+ but only 5 sends → not enough signal yet. Run another 10.

---

## Booking the call

- Always suggest two specific times. Never "let me know when you're free".
- 15 or 30 minutes. Don't call it a "demo" in the first ask.
- Once they say yes, send the calendar invite within the hour.
- One reschedule fine. Two reschedules with no follow-through = nurture.

---

## Basic qualification check

Before spending too much time:
1. They run outbound (or want to) — not just thinking about it
2. Real pain in current outbound (volume, replies, time, consistency)
3. Budget or budget cycle within 3 months

If unclear by meeting time, use the meeting to find out. If none are true after the meeting, mark Lost or Nurture and move on.

---

## Tone and writing style

- Person to person, not company to prospect
- Short sentences, WhatsApp-style, not email-newsletter
- No em dashes
- No bullet points in prospect-facing messages
- No formal sign-offs. End with the question or with "Michael".
- Sign as Michael, never MJ
- Malaysian tone: warm + direct

---

## Pipeline stage rules

- "No budget right now" = Nurture, not Proposal
- A booked-but-unhappened meeting is not Demo Done
- Friendliness is not progression. Stages move on confirmed next steps only.

---

## Signs to stop chasing

- Two reschedules with no rebook effort
- "Happy with what we have" + zero curiosity
- No reply after 3 follow-ups
- "Not the right time" with no clear timeline
- They engage socially (likes, "interesting") but never agree to a call

After stopping, re-engage ONLY on a fresh trigger event.

---

## v1.0 in one sentence

Every cold message: verifiable trigger from their last 60 days + Path B (1-3-word-answerable diagnostic question grounded in one of the 5 approved outbound pains) + varied opt-out. All numbers from `BEAVER_PROOF_NUMBERS.md`. All drafts pass the banned-phrase regex. Path A (proof anchor) stays disabled until at least one client outcome is VERIFIED. If the required-input contract isn't satisfied, drop the prospect — never fall back to generic.

---

## Roadmap

- **v1.1 (when first client outcome verified):** enable Path A. Update BEAVER_PROOF_NUMBERS.md with first VERIFIED entry. Path A still gated on segment match.
- **v1.2 (when 3+ assets in production library):** enable real-deliverable Path A asks. Until then, no "mind if I send the walkthrough" without a real walkthrough URL.
- **v2.0 (when 50+ paying clients):** review whether to maintain Path B as default or shift to Path A primary.
