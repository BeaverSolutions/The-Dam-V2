# BeavrDam Codebase Audit Findings Report (2026-05-16)

This report summarizes the findings of a comprehensive codebase audit conducted by Jules on May 16, 2026.

## 1. Summary of Findings

| ID | Title | Severity | File:Line |
|:---|:---|:---|:---|
| F-01 | LinkedIn Outreach remains a manual bottleneck | CRITICAL | `server/services/sendQueueWorker.js:505`, `client/src/pages/Approvals.jsx:1345` |
| F-02 | `founder_feedback` loop never fires for LinkedIn sends | CRITICAL | `server/services/approvals.js:357`, `server/routes/leads.js:110` |
| F-03 | Half-fix drift between Signal and Kickoff pipelines | HIGH | `server/services/agents.js:1726, L1813, L2995, L3114` |
| F-04 | Migration Idempotency Risks | HIGH | `server/db/migrations/002, 017, 027, etc.` |
| F-05 | RLS Bypass via shared Pool usage | HIGH | Throughout `server/services/` |
| F-06 | Uninstrumented "Silent Drop" paths | HIGH | `server/services/agents.js:1664, L1765, L1806, L2944, L3048, L3096` |
| F-07 | Lack of Quota/Pool Exhaustion Alerting | HIGH | `server/services/research.js`, `server/services/dbBuilder.js:485` |
| F-08 | Lead State Transition Gaps | MEDIUM | `server/routes/leads.js` |
| F-09 | Potential connection leak in `tenantScope` | MEDIUM | `server/middleware/tenantScope.js:45` |
| F-10 | Information leak in `/health` endpoint | LOW | `server/index.js:158` |
| F-11 | Physically duplicated Auto-Approve logic | LOW | `server/services/agents.js:1924, L3344` |

---

## 2. Findings by Severity

### CRITICAL — Breaks Hero-Film Promises or Security

#### [F-01] LinkedIn Outreach remains a manual bottleneck
- **Exact Path**: `server/services/sendQueueWorker.js` (Line 505), `client/src/pages/Approvals.jsx` (Line 1345)
- **Problem**: BeavrDam does not autonomously deliver LinkedIn messages. They land in the `approvals` table and then the "Ready to Send" tab, where a human must manually copy-paste into LinkedIn and click "DM Sent" to mark the row as sent. This breaks the fundamental promise of a system that runs without the founder's manual operation.
- **Suggested Fix**: Implement an automated LinkedIn sender (e.g., via a Playwright worker or a Chrome Extension bridge) that consumes approved LinkedIn messages from the queue and executes the delivery automatically.

#### [F-02] `founder_feedback` loop never fires for LinkedIn sends
- **Exact Path**: `server/services/approvals.js:357`, `server/routes/leads.js:110`
- **Problem**: The capture of founder edits for the learning loop relies on `original_body` metadata being present and a diff being sent back to the API. In the current manual LinkedIn workflow, the `final_body` is rarely passed back, and the `dm-sent` route (`approvals.js:357`) does not accept an `edited_body` parameter. This is why the `founder_feedback` table has 0 rows.
- **Suggested Fix**: Update the `dm-sent` UI and API to accept a `final_body` parameter. Ensure the "Copy Message" button in the UI snapshots the initial state so a diff can be calculated when "DM Sent" is eventually clicked.

---

### HIGH — Silent Failures, Half-Fixes, or Autonomy Blockers

#### [F-03] Half-fix drift between Signal and Kickoff pipelines
- **Exact Path**: `server/services/agents.js` (L1726 vs L2995, L1813 vs L3114)
- **Problem**: `processLeadPipeline` (Kickoff) has been updated with Vibe Prospecting (VP) enrichment and specific `CHANNEL_HINTS`, while `processExistingLeadsPipeline` (Signal) has not. This means rich-signal leads (the most valuable) currently receive lower-quality prompts and less enrichment than standard cold leads.
- **Suggested Fix**: Complete the Phase 2 migration by moving all shared logic into the `pipeline.js` service and making both agent paths thin wrappers around `pipeline.processLead`.

#### [F-04] Migration Idempotency Risks
- **Exact Path**: `server/db/migrations/002_rls_policies.sql`, `017_llm_usage_budget.sql`, `027_rls_and_constraints.sql`
- **Problem**: Most database migrations containing `CREATE POLICY`, `CREATE INDEX`, or `CREATE TRIGGER` lack existence guards (e.g., `IF NOT EXISTS`). This causes the server to crash on redeployment if the database objects already exist, which caused the 18h outage on May 12th.
- **Suggested Fix**: Retrofit all SQL migration files with `IF NOT EXISTS` guards or wrap creation logic in `DO` blocks that check `pg_policies` and `pg_indexes`.

#### [F-05] RLS Bypass via shared Pool usage
- **Exact Path**: Throughout `server/services/` (e.g., `leads.js`, `messages.js`, `approvals.js`)
- **Problem**: While `tenantScope` middleware activates RLS by setting `app.current_client_id`, this only applies to the specific connection checked out for that request. Most service code imports the global `pool` and calls `pool.query` directly, which uses a random connection that may not have the tenant context set, effectively bypassing Row-Level Security.
- **Suggested Fix**: Mandate the use of `req.tenantDb.query` in routes and refactor service functions to accept a `db` client as an argument instead of relying on the global singleton.

#### [F-06] Uninstrumented "Silent Drop" paths
- **Exact Path**: `server/services/agents.js` (L1664, L1765, L1806, L2944, L3048, L3096)
- **Problem**: Multiple early return paths in both pipelines (e.g., Circuit Breaker, LinkedIn already tried, Dedup guard) write to `pipeline_traces` but do not write an action log to the primary `logs` table. This makes high-level debugging of lead loss impossible without complex table joins.
- **Suggested Fix**: Ensure every exit path in `agents.js` calls `logsService.createLog` with a specific action like `draft_skipped` or `lead_blocked`.

#### [F-07] Lack of Quota/Pool Exhaustion Alerting
- **Exact Path**: `server/services/research.js`, `server/services/dbBuilder.js:485`
- **Problem**: When the Brave Search quota is hit (HTTP 402) or the lead pool dries up, Research Beaver stops sourcing. There is no active Telegram alert to MJ for these states; the system simply stays idle until noticed manually.
- **Suggested Fix**: Add a watchdog task in `captainOrchestrator.js` that checks for `research_no_results` or HTTP 402 logs and fires a Telegram alert if sourcing has been flat for >4 hours.

---

### MEDIUM — Correctness Risk or Degraded Behaviour

#### [F-08] Lead State Transition Gaps
- **Exact Path**: `server/routes/leads.js`
- **Problem**: There are no dedicated API endpoints for transitioning leads to `meeting_booked` or `closed_won`. Users are forced to use the generic `PUT /api/leads/:id` and manually supply a `next_action`, which is error-prone and bypasses standard side-effect tracking.
- **Suggested Fix**: Implement dedicated POST endpoints like `/api/leads/:id/book-meeting` and `/api/leads/:id/close-deal` that handle all side effects (logs, conversion tracking, feedback events) atomically.

#### [F-09] Potential connection leak in `tenantScope`
- **Exact Path**: `server/middleware/tenantScope.js:45`
- **Problem**: `tenantScope` acquires a client and relies on `res.on('finish')` to release it. If an error occurs in a middleware *after* `tenantScope` but before the route handler (or if `next()` is never called), the client may remain checked out, eventually exhausting the pool.
- **Suggested Fix**: Wrap the connection acquisition and `next()` call in a try/finally block or use a more robust scoped-connection pattern.

---

### LOW — Code Quality and Maintainability

#### [F-10] Information leak in `/health` endpoint
- **Exact Path**: `server/index.js:158`
- **Problem**: The `/health` endpoint explicitly returns whether specific API keys are "set" or "missing". While not a direct secret leak, this provides environment fingerprinting data to unauthenticated users.
- **Suggested Fix**: Return simple booleans for internal health diagnostics or remove key status from the public response.

#### [F-11] Physically duplicated Auto-Approve logic
- **Exact Path**: `server/services/agents.js` (L1924 and L3344)
- **Problem**: The logic for "Seasoned Client" and "30-day Dedup" gates is duplicated line-for-line in two places.
- **Suggested Fix**: Consolidate into a single `pipeline.canAutoApprove(clientId, leadId)` helper.

---

## 3. Autonomy Gaps (P3 + P4)

The BeavrDam "Autonomous" promise is currently compromised by several structural bottlenecks and silence-on-failure patterns:

1.  **The LinkedIn Sending Manual Bottleneck**: Outreach on the primary channel (representing ~85% of volume) requires manual copy-paste-send for every approved draft. This is the single largest blocker to true autonomy.
2.  **Silent Cron Failures**: Background jobs rely on `setInterval`. If an unhandled error occurs within an interval, the task may stop firing without alert until the process restarts.
3.  **Quota and Pool Exhaustion**: There is no active alerting for Brave quota burn ($55 cap) or lead pool depletion. The system "flatlines" silently, appearing healthy but producing zero output.
4.  **Incomplete Feedback Loop**: The founder's manual edits on LinkedIn are not captured, meaning the system never learns to "clone the founder" for the majority of its outreach.

---

## 4. Priority (P1-P10) & Layer A Coverage Notes

- **P1 (Silent-drop)**: 14 uninstrumented exit paths identified across both pipelines.
- **P2 (Half-fix)**: Significant behavioral differences found in enrichment, context, and error handling between Signal and Kickoff paths.
- **P3 (Hero-film)**: Goal 1 (50/day) fails on LinkedIn sends; Goal 2 (Two Thoughts) is implemented but previously misrouted; Goal 3 (Founder Clone) is broken for manual sends.
- **P4 (Autonomy)**: Structure is reactive rather than proactive; lacks watchdog alerts for critical blockers.
- **P5 (Channel Discipline)**: Robustly implemented via `selectChannel` and source-message tracking in `replyHandler`.
- **P6 (Migration Safety)**: High risk due to missing existence guards in most SQL policies and indexes.
- **P7 (Env-var gates)**: Inconsistent behavior; some return silently (Budget), others throw (Claude initialization).
- **P8 (VP Sourcing)**: **NOTE: This review was static-only.** The code follows credit discipline and ICP gating correctly, but the review did not execute the path against the live Explorium API. The reported "zero results" in production suggest a runtime or data-matching issue not visible in static analysis.
- **P9 (Generated columns)**: Correctly handled; `daily_kpi.kpi_met` is correctly excluded from UPDATEs.
- **P10 (Endpoint coverage)**: Major gaps in lifecycle-specific endpoints (Book Meeting, Close Deal).
- **Layer A (General Review)**: Identified RLS bypass risks and potential connection leaks in middleware.

---

## 5. Test Results

- **Status**: 147 passed (100% of existing suite)
- **Scope**: Covers ICP filtering, auto-fix rules, business day math, and basic lead quality.
- **What is NOT covered**:
  - External API interactions (Anthropic, Brave, Hunter, Explorium).
  - Full background job lifecycles and concurrency.
  - Multi-turn reply classification and drafting.
  - Row Level Security (RLS) enforcement.
