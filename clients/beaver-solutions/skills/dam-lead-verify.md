# Skill: dam-lead-verify

## Trigger
Activate when MJ says:
- `verify #N` — verify a specific approval queue item
- `verify [name] at [company]` — verify a specific person
- `check #N` — same as verify
- "is this person real?"
- "can you check this lead?"

Also runs automatically before `approve all` — verify every lead first, flag any that fail, ask MJ to confirm before approving flagged ones.

## What This Skill Does
Googles a prospect to confirm they exist before MJ approves outreach to them.
Prevents sending messages to hallucinated people.
Returns: real/not found + LinkedIn URL + confidence level.

---

## Execution Steps

### When MJ says `verify #N`

**Step 1 — Get lead details from session memory**
Look up the lead mapped to #N from the last `show approvals` run.
Need: `lead_name`, `lead_company`, `lead_title`, `lead_linkedin` (if present).

If no session memory: "Run 'show approvals' first so I know which lead is #N."

**Step 2 — Google search**
Search for: `"{lead_name}" "{lead_company}" site:linkedin.com`

If that returns nothing, try: `"{lead_name}" "{lead_company}" LinkedIn`

**Step 3 — Evaluate the result**

| Result | Verdict |
|--------|---------|
| LinkedIn URL found matching name + company | VERIFIED |
| Name found but different company | PARTIAL — flag it |
| Company found but different person | PARTIAL — flag it |
| No results at all | NOT FOUND |

**Step 4 — Report back to MJ**

VERIFIED:
> "#N — [Name] at [Company]: Verified.
> LinkedIn: [URL]
> Safe to approve."

PARTIAL:
> "#N — [Name] at [Company]: Partial match only.
> Found: [what was found]
> Mismatch: [what didn't match]
> Recommend: reject and source manually."

NOT FOUND:
> "#N — [Name] at [Company]: Cannot verify. No LinkedIn or web presence found.
> This lead may be hallucinated.
> Recommend: reject #N"

---

### When MJ says `verify [name] at [company]`

Same as above but use the provided name and company directly.
Skip session memory lookup.

Example: `verify Kenneth Khoo at Juicebox Marketing`

---

### When MJ says `approve all`

Before approving anything:
1. Run verify on every item in the queue
2. Build a summary:

> "Verified [X] of [total] leads before approving.
>
> VERIFIED (safe to approve):
> - #1 Sarah Lim at Growth Pilots — LinkedIn confirmed
> - #3 Shawn Liew at Supahands — LinkedIn confirmed
>
> FAILED (do not approve):
> - #2 Raj Patel at Digital Nexus — not found
> - #5 Marcus Wong at Amplify — partial match only
>
> Approving [X] verified leads now. Rejecting [Y] unverified ones.
> Reply 'yes' to confirm, or 'cancel' to review manually."

Wait for MJ's confirmation before taking any action.

---

## Confidence Levels

| Signal | Weight |
|--------|--------|
| Exact LinkedIn URL match (name + company) | High — approve |
| Google shows them on company website | High — approve |
| Multiple sources confirm (LinkedIn + news/press) | Very high |
| Only one source, partial info | Medium — flag |
| Zero results | Low — reject |

---

## Notes
- Always show the LinkedIn URL found (even if different from what The Dam stored)
- If The Dam stored a linkedin_url and Google confirms the same URL → extra confidence
- If The Dam stored a linkedin_url but Google finds a different URL → flag the mismatch
- This skill does NOT update the lead record. It only informs MJ's decision.
- If lead source is `apollo` or `serper`, skip verification — these are already real. Just confirm to MJ: "#N — [Name]: Source is [apollo/serper] — verified automatically. Safe to approve."
