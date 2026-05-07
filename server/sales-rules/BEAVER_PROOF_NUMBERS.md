<!-- DEPLOYED COPY. Edit MJxClaude/sales-assets/ first, then sync here. -->
<!-- Sync direction: MJxClaude/sales-assets/ → beavrdam/server/sales-rules/ -->
<!-- Last sync: 2026-05-06 -->

# Beaver Solutions / BeavrDam Proof Numbers — Source of Truth

> Every numeric claim in cold outreach (Path A proof anchors + Path B value hooks) must come from this file.
> If a number isn't in this file, it does NOT go in a DM.
> v1.0 of the Beaver LinkedIn Outreach Rules enforces this via the banned-phrase / hallucination validator.
> Last updated: 2026-05-06

## Status legend

- **VERIFIED:** confirmed against client data or public source. Safe to use.
- **PENDING:** drafted but not yet confirmed. Do NOT send until promoted to VERIFIED.
- **DEPRECATED:** previously used, now retired. Do NOT use.

---

## Verified client outcomes (Path A proof anchors)

> **Status as of 2026-05-06: EMPTY.** Beaver Solutions has 0 paying clients with verified, prospect-facing outbound outcomes. Path A is DISABLED in v1.0 of the rules. Every cold DM defaults to Path B until at least one row is added below.

| Vertical / Persona | Client | Outcome statement (exact wording) | Status | Source / verifier | Date verified |
|---|---|---|---|---|---|
| _empty_ | _empty_ | _empty_ | _empty_ | _empty_ | _empty_ |

### How to populate

1. Land a paying client. Run a campaign. Capture before/after metrics.
2. Get explicit client consent (email or written) to use the number prospect-facing.
3. Draft the outcome statement in the exact form a DM line will use it.
4. Adrian / Keith / MJ confirms the number against the source.
5. Add the row, set status VERIFIED, log the date.
6. Update BEAVER_LINKEDIN_OUTREACH_RULES.md to allow Path A for that segment.

---

## Approved benchmark numbers (industry, public sources)

These are acceptable in Path B value hooks where appropriate, sourced from publicly documented benchmarks. They do NOT make a claim about BeavrDam performance — they describe the market baseline.

| Number | Context | Source |
|---|---|---|
| 1-5% reply rate | Generic cold LinkedIn template | LinkedIn Sales Solutions, HubSpot, RevPilots |
| 10-15% reply rate | Personalised research-led LinkedIn outreach | HubSpot, Lavender benchmarks |
| 1-3% reply rate | Generic cold email | Gartner, Apollo public benchmarks |
| 8-12% reply rate | Personalised cold email | Lavender, Outreach.io public benchmarks |
| 6-12 hours/week | Founder-led outbound time | SMB / agency surveys (multiple) |
| 50+ DMs/week | Typical founder-led outbound volume | SMB / agency surveys |
| 92% | SEA WhatsApp daily active rate | We Are Social / Meltwater Digital 2025 |

Anything outside this table OR the verified-clients table above must NOT appear in a DM.

---

## Approved BeavrDam product facts (for context, not numeric claims)

These are statements about what BeavrDam IS — not performance claims. Safe to reference in conversational replies (not cold DMs).

- "AI outreach platform built on Beaver Solutions"
- "Research → Sales → Enforcer → Captain Beavers (4 agents)"
- "WhatsApp-native for SEA"
- "Live at app.beaver.solutions"

Do NOT claim:
- Specific reply rate uplifts vs manual ("BeavrDam users see 3x reply rates" — not yet verifiable)
- Time savings ("saves 10 hours/week" — not yet verifiable per client)
- Conversion rates from DM to meeting (no client data yet)

---

## Promotion process (PENDING → VERIFIED)

1. Pull the metric from the client's actual campaign data (Supabase or shared dashboard).
2. Get client written consent for prospect-facing use.
3. Adrian / Keith / MJ cross-checks the number against the source.
4. Update this file: row in verified table, status VERIFIED, verifier name, date.
5. Update `BEAVER_LINKEDIN_OUTREACH_RULES.md` segment-match rules to enable Path A for that vertical.

## Retirement

If a number becomes stale or contested, mark DEPRECATED with a date. Do not delete (audit trail).

---

## Open actions (2026-05-06)

- [ ] Land first paying client → first verified outcome
- [ ] Confirm client consent template for prospect-facing use of metrics
- [ ] Set up Supabase view for pulling campaign-level metrics ready for prospect-facing wording
