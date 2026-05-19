# NEXT-SESSION — BeavrDam Autonomous Fix

*Updated 2026-05-19 (start of day). Prior session: 2026-05-18 shipped 5 commits.*

## Where we are

The autonomous loop was producing 0 leads. Root cause: two compounding bugs in series — an impossible verification threshold, then a contact-gate score field mismatch dropping every LinkedIn-only lead. Both fixed. Never-burn-a-lead restored. Sales Beaver prompt upgraded to stop cold-tells.

**5 commits shipped to The-Dam-V2 main (all pushed, all live):**

| SHA | What |
|-----|------|
| `0acd5e2` | Research diagnostics — `research_no_results` logs provider config + likely_cause |
| `ec93f35` | Circuit breaker — MAX_SEARCH_ROUNDS=4, stop paid search after 2 zero-yield rounds |
| `0857fd5` | Two sourcing bugs — verifyCandidate threshold 50→40; contactGate reads `quality_score` fallback |
| `ec601ee` | Never-burn-a-lead — `surfaceUnrewrittenDraft` at 3 burn sites; `applyEnforcerDecision` marks LinkedIn approvals `linkedin_requested` |
| `bc961b8` | Sales Beaver v3 prompt — APPROVED CLOSERS + DIAGNOSTIC QUESTIONS + before/after example |

## IMMEDIATE NEXT: verify the loop is actually autonomous

The 5 commits are shipped but UNVERIFIED end-to-end. The whole point of 2026-05-19 is to confirm: does the loop now produce leads → clean drafts → approval queue?

**First action — run `beavrdam-status`** (read-only Supabase, zero cost). Then check the last Captain kickoff.

Validation query:
```sql
SELECT stage, status, COUNT(*) FROM pipeline_traces
WHERE client_id = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
  AND created_at > NOW() - INTERVAL '12 hours'
GROUP BY 1, 2 ORDER BY 1;
```

Decision tree on the output:
- **Leads sourced + drafts created + rows in approval queue** → loop is autonomous. Jules stays parked (see follow-up). Move to lower-severity audit.
- **0 leads sourced** → check Railway logs for the `[research] provider-config:` line (added in 0acd5e2) — it prints which providers are live. If Brave is the only source and it's capped/empty, sourcing is still blocked → Google CSE setup becomes P0.
- **Leads sourced but 0 drafts** → check `pipeline_traces` for `draft_failed`; inspect a failed lead's ranger_notes.
- **Drafts created but not in approval queue** → check `applyEnforcerDecision` / surfaceUnrewrittenDraft path.

**Jules condition:** if the loop is NOT autonomous by EOD 2026-05-19, MJ's standing instruction is to re-engage Jules for a re-audit of these 5 commits. If autonomous, Jules stays parked.

## Build queue (priority order)

1. **Verify autonomy** (above) — the gate for everything else.
2. **Google CSE setup** — free tier 100/day, removes Brave dependency. 2 Railway env vars: `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX`. ~15 min. Research Beaver gets a working Layer 2 source.
3. **Lower-severity audit findings:**
   - `pending_send` cap dead-end — `processExistingLeadsPipeline` may silently exit when leads pile up in `pending_send`.
   - `integrations.js:324` — a status update path may regress `pipeline_stage` backward.
   - same-day dedup excludes failed-run leads — a lead researched in a failed kickoff won't be picked up by a later kickoff the same day. MJ decision: fix or leave.

## Hard rules from 2026-05-18 mistakes

- **"Approved" reference content can still fail the code gates.** The outreach-rules file had an approved question containing an em dash that `codeEnforcerGates` instakills. Before porting any "approved" example into an agent prompt, run it against the deterministic gates first.
- **Write logs incrementally.** The 2026-05-18 end-of-day crashed on a 1M-context API error and lost the whole closeout. Log decisions + daily-log legs as work happens, not deferred to one end-of-day batch. Do not run end-of-day on a 1M-context session.
- **Never-burn-a-lead is a standing rule.** Leads that fail drafting/Enforcer surface to the approval queue, never discarded. If any code path discards a lead on draft failure, that's a regression.

## Cost ceiling for next session

- Pre-authorized: read-only Supabase queries (`beavrdam-status`, validation SQL), Railway log reads, git operations.
- Requires MJ approval: triggering a manual `/kickoff` (burns LLM + possibly sourcing credits), topping up Explorium/VP, any new metered-provider config.
- A Captain kickoff fires on its own 09:30 MYT schedule — observe that rather than forcing one.

## Queued for MJ (surface in first response)

- Set The-Dam-V2 repo private if not done: `gh repo edit BeaverSolutions/The-Dam-V2 --visibility private --accept-visibility-change-consequences`
- Decide Explorium/VP: top up, wait for Brave June 1, or LinkedIn-sync path.
- `b7ff837` spend cap commit — sitting local, needs MJ's `LLM_MONTHLY_BUDGET_USD` value before push.
- Google CSE: MJ creates the 2 API credentials (free, no card) so Brain can wire them.
