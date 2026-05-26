# NEXT-SESSION — BeavrDam Autonomous Fix

*Updated 2026-05-19 (EOD). This is the MJxClaude mirror — canonical copy lives at `Desktop/Beaver Solutions/beavrdam/projects/beavrdam-rebuild/NEXT-SESSION.md`. Keep both in sync.*

## Locked priority for next session

**Validate Sales Beaver's per-lead angle-finding produced real, personal drafts.**
Tomorrow's 09:30 MYT kickoff is the test. After it runs:
- Pull 5-10 drafts from the kickoff and read them. Each opener must anchor on a
  real, verifiable fact about the prospect (a dated event OR a true company/role
  observation). None should read as generic spam.
- Query `pipeline_traces` for the kickoff: count survivors at every stage.
- Confirm `metadata.signal` got populated on the drafted leads (ensureLeadAngle
  runs inside salesGenerate).

## What shipped today (2026-05-19)

Full-codebase audit closed out — Sprints 1-5 — plus:
- **Sales Beaver finds a real angle for every lead** (`6856f7f`). synthesizeColdSignal
  never returns "nothing found"; ensureLeadAngle researches an angle on the spot
  before every draft; no lead is skipped for lack of a dated signal. 54 wrongly
  "no_signal"-marked leads reclaimed. Verified: a test batch produced real
  verifiable angles, 0 came back no-signal.
- VP cold pool: 17 leads carry verified angles; 49 more get one automatically
  when Sales Beaver drafts them; 14 are company-null (VP-import gap — unanchorable).
- Weekly master-DB export → Beaver Solutions folder, Mondays 07:00 (Windows task).
- A8-6 — Enforcer weekly teaching note wired into the Sales Beaver prompt.

## Carry-forwards (deferred with reason — not forgotten)

1. **A7-2** — flip `RLS_ENFORCE_ENABLED=true` on Railway. Grants verified complete;
   do it in a watched window, ideally right after a kickoff confirms healthy.
2. **A8-5 / A8-7 / A8-8** — dead learning loops (feedback_events consumer,
   weekly_strategy reader, computeEnforcerCalibration caller). Need a design
   decision on what consumes each — a scoped session, not a mechanical fix.
3. **14 company-null VP leads** — unanchorable. Needs a VP re-export with company
   names, or a backfill. Not a pipeline bug.
4. **A8-6 teaching note** — wired but produces nothing until the first Sunday
   `runEnforcerTeaching` runs (needs >= MIN_REVIEWS_FOR_TEACHING reviews).

## Validation SQL (run after tomorrow's kickoff)

```sql
-- Kickoff funnel — survivors at each stage
SELECT stage, status, COUNT(*) FROM pipeline_traces
WHERE client_id='ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
  AND created_at > NOW() - INTERVAL '6 hours'
GROUP BY 1,2 ORDER BY 1,2;

-- Did drafted leads get a real angle?
SELECT name, company, metadata->>'signal_source' AS src, LEFT(metadata->>'signal',90) AS angle
FROM leads
WHERE client_id='ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
  AND metadata->>'signal' IS NOT NULL
ORDER BY updated_at DESC LIMIT 15;
```
