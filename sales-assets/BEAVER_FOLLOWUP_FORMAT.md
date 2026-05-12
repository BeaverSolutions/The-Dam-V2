# Beaver Solutions / BeavrDam Follow-Up Format — v1.0

> For use by the Sales Beaver agent (BeavrDam) when drafting any LinkedIn DM or email FOLLOW-UP (touches 2-6) on behalf of MJ / Beaver Solutions.
> Companion to `BEAVER_LINKEDIN_OUTREACH_RULES.md` (which governs cold touch 1).
> v1.0 — first version. Created 2026-05-12 after the "still thinking about whether X makes sense" cargo-cult bug.
> **MANDATORY: Sales Beaver runtime injects these rules into every follow-up draft prompt. Mirror lives inline in `beavrdam/server/services/followupSequence.js` — keep in sync if you edit this file. Cross-Location Sync rule in CLAUDE.md applies.**

---

## Why this exists

On 2026-05-12, Sales Beaver drafted three near-identical follow-ups:
- "Still thinking about whether automating outreach makes sense for codeme.pro right now?"
- "Still thinking about whether automating outreach makes sense on your side right now, Zheng?"
- "Still thinking about whether streamlining outbound makes sense for U Mobile right now, or is timing still off?"

All three got rejected by Enforcer at score 0. Reason: the follow-up prompt's example tone was literally that phrasing, Sales Beaver cargo-culted it into every draft, and the structure violated v1.0 outreach rules (no trigger, no value hook, no diagnostic question, no opt-out — just a qualification frame). 55 of 57 follow-ups that morning rejected the same way.

Root cause: the follow-up prompt was written without coordinating to v1.0 structure, then asked Sales Beaver to keep drafts under 30 words "no stats, no proof, no pitch" — which can't satisfy Enforcer's 4-part rubric. Every spec-compliant draft auto-rejected.

This document fixes both: a sharper follow-up standard that also satisfies Enforcer.

---

## The Principle

A follow-up that doesn't add new information is spam. "Just checking in" / "still thinking about" / "circling back" are all tells. Each touch must either deliver a NEW specific insight or reference a NEW verifiable signal about them. Never reuse the same hook twice.

Follow-ups have to be shorter than cold touches (the prospect already has touch 1's context), but every part of the v1.0 4-part structure still has to be present. Compressed, not amputated.

---

## The 4-Part Structure (mandatory)

Every follow-up touch 2-6 has four parts. If any part is missing, regenerate or return `needs_more_research`.

### Part 1 — Reference OR new trigger (mandatory, EXACTLY ONE)

Either:
- **Reference** — name a specific point from a previous touch in this sequence. ("Sent you a note Tuesday on the SDR posting at Mantra...")
- **New trigger** — cite a NEW verifiable event from the last 7-30 days (their post, hire, talk, milestone, vertical shift). Not the same trigger touch 1 used.

Never both. Never neither.

### Part 2 — Insight (mandatory)

One non-obvious observation tied to their specific situation. Peer voice, not vendor.

NOT acceptable:
- A pitch ("we help with...")
- A stat or percentage (cold touch 1 owns the numbers — follow-ups don't repeat them)
- Generic industry commentary ("agencies are facing tough margins")
- Re-stating their public situation ("you're hiring three SDRs")

Acceptable:
- A non-obvious second-order observation about their public move
- A pattern observation across peers in their segment (qualitative, not numeric)
- A specific dynamic in their role you've watched play out

### Part 3 — Narrower ask (mandatory)

A diagnostic question answerable in 1-3 words. Each touch the question gets MORE specific than the previous one.

NOT acceptable:
- Qualification frames: "does this make sense?" / "is this a fit?" / "any thoughts?" / "wdyt?"
- Yes/no on a vague premise
- "Want to chat?" / "Open to a quick call?"
- The same question as a previous touch, reworded

Acceptable:
- "Sourcing or sending the bigger pain?" (1-2 words)
- "In-house or outsourced today?" (1-2 words)
- "Is it the volume or the personalization?" (1 word)
- "Worth 15 min Thursday or next week?" (1-2 words)

### Part 4 — Opt-out (mandatory)

One graceful exit clause. Lowers pressure, signals respect for their time.

Examples:
- "If timing's off, happy to close the loop."
- "If this isn't on your plate, no worries — I'll move on."
- "If outbound isn't a focus right now, totally understand."

Never absent.

---

## Per-Touch Role (on top of the 4-part structure)

| Touch | Day | Role | Word cap |
|-------|-----|------|----------|
| 2 | D+2 | **Reference touch 1 specifically.** Different angle on the same outbound pain. Narrower diagnostic Q than touch 1. | 70 |
| 3 | D+5 | **Pattern interrupt.** Reference a NEW verifiable signal about them (post, hire, talk, milestone). NOT touch 1. | 60 |
| 4 | D+10 | **Contrarian observation.** Industry-level or role-level insight that's non-obvious. Peer voice, not seller. | 70 |
| 5 | D+18 | **Soft break-up.** "Last note from me for now." Door-open clause referencing their specific situation. | 50 |
| 6 | D+30 | **Re-awaken** with a NEW verifiable trigger from last 30d. Fresh conversation, not "touch 6 of 6" vibe. | 70 |

---

## Banned Phrases (auto-reject)

Drafts containing any of these in the body will be regenerated. Patterns are case-insensitive.

- `still thinking` / `just thinking` / `still wondering`
- `just checking in` / `circling back` / `following up on` / `touching base`
- `does .* make sense` (qualification frame)
- `for .* right now\?` (template tell — combined with no trigger above)
- `any thoughts` / `wdyt` / `let me know your thoughts`
- `Most founders` / `Most [role]s I talk to` / `Most [persona] I come across` (cold-tell)
- `quick favor` / `quick ask` (pseudo-personal)
- Formal sign-offs: `Regards,` / `Best regards,` / `Sincerely,` / `Cheers,` — sign as `Michael` naked, no comma sign-off line
- `Hope this finds you well` / `Hope you're doing well` / `Hope all is well`

---

## Banned Content

- Reusing any hook, angle, pain framing, stat, or numeric claim from prior touches in the sequence
- Numbers, percentages, benchmarks of any kind (cold touch 1 owns the stat; follow-ups don't)
- Em dashes (`—`), bullet points, more than 1 question mark per message
- Fabricated company names, products, roles, or facts (anti-fabrication hard gate)
- Generic festive greetings, weather small-talk, "just wanted to..." preamble

---

## Required Self-Check (in `thinking` field before draft returns)

Sales Beaver must include this checklist in its `thinking` field. If any check fails, regenerate or return `needs_more_research`. No draft ships with fewer than 4 parts.

1. **Part 1:** Reference OR new trigger present? Quote the exact phrase you used.
2. **Part 2:** Insight present? Quote it. Confirm: not a stat, not a pitch, not generic.
3. **Part 3:** 1-3-word-answerable diagnostic question present? Quote it. Confirm: not "does this make sense?"
4. **Part 4:** Opt-out clause present? Quote it.
5. **Anti-repetition:** Cite the hooks/angles used in PREVIOUS MESSAGES. Confirm yours is different.
6. **Banned-phrase scan:** Walk the banned list above. Confirm zero hits.
7. **Word count:** Count the body. Confirm under the cap for this touch.
8. **Question count:** Confirm ≤ 1 question mark.

---

## Sign-Off

All follow-ups sign as `Michael` on a single line. No comma, no role title, no "Beaver Solutions". Just the name.

Email format:
```
Hi [FirstName],

[body, under word cap]

Michael
```

LinkedIn DM format:
```
[body, under word cap. No greeting. No sign-off block — name only if natural.]
```

---

## Validation rubric

A passing follow-up draft scores:
- All 4 parts present and labeled by Sales Beaver in `thinking` field
- Zero banned-phrase hits
- Anti-repetition pass (different hook/angle from all prior touches in this sequence)
- Word count under per-touch cap
- ≤ 1 question mark
- Sign-off matches above

A draft that fails any criterion gets regenerated up to 2 times. If it still fails, return `needs_more_research` with the failing criteria named.

---

## Version log

- **v1.0 (2026-05-12)** — initial. Replaces the implicit per-touch instructions in `followupSequence.js` that produced the "still thinking about whether X makes sense" template-spam class. 4-part structure + banned-phrase list + per-touch word caps + mandatory self-check.
