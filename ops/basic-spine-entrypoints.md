# V2.1 Basic Spine Entry Points

Canonical Basic spine:

```text
Signal -> Lead -> Draft -> Enforcer decision -> Approval/send queue -> KPI truth -> Captain action
```

This inventory is Phase 1 guardrail work. No entry point below is automatically approved to run in production. Production scheduled autonomy is currently paused by `SCHEDULED_AUTONOMY_PAUSED`.

## Autonomy State

- Current mode source: `server/services/autonomyState.js`.
- Current production expectation: `mode=paused`, `scheduled_actions_allowed=false`, `spend_allowed=false`, `send_allowed=false`.
- Manual visibility and manual-safe actions may remain available.
- Re-arm requires MJ approval, tenant, spend cap, allowed channels/providers, and rollback condition.

## Canonical Spine

| Stage | Canonical owner | Canonical entry point | Notes |
|---|---|---|---|
| Signal | Captain -> Research | planned V2.1 signal planner | Phase 2 will create explicit signal playbooks. |
| Lead | Research | `server/services/dbBuilder.js#sourceLeadsOnDemand`, `server/services/signalHunt.js#saveSignalLeads` | Must save with `signal_package` after Phase 3. |
| Draft | Sales | `server/routes/autonomous.js#directorExecute` via existing pool/signal leads | Must require evidence package after Phase 4. |
| Enforcer decision | Enforcer | `server/services/agents.js#rangerReview` and approval path | Must route Research vs Sales repair after Phase 4. |
| Approval/send queue | Approval + Send Queue | `server/services/approvals.js`, `server/services/sendQueueWorker.js` | Email send is automated only after approved/trusted policy. LinkedIn remains manual-safe. |
| KPI truth | KPI service | `server/services/kpi.js#recountKpi` | Must run after real sends and manual-send state changes. |
| Captain action | Captain | `server/services/captainOrchestrator.js`, `server/services/directives.js` | Must choose playbooks and stop dry spend after Phase 5. |

## Scheduled Workers

| Entry point | Label | Can spend | Can send | Current pause behavior |
|---|---|---:|---:|---|
| `server/index.js` reply detector/calendar sync | scheduled | No provider spend expected | No | Not paused; read/sync path. |
| `server/index.js` send queue worker | scheduled, canonical send path | No sourcing spend | Yes, for approved email | Not paused by `SCHEDULED_AUTONOMY_PAUSED`; sends only already-approved email. |
| `server/index.js` disabled follow-up scheduler | disabled, legacy | Would use LLM if re-enabled | Can enqueue | Commented out and job health marks disabled. |
| `server/index.js` auto-approval recovery | scheduled, blocked-by-scheduled-pause | No sourcing spend | Can enqueue approved messages | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` pool email enrichment | scheduled, blocked-by-scheduled-pause | Brave/Hunter/MillionVerifier possible | No | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` DB Builder | scheduled, blocked-by-scheduled-pause | Web/LinkedIn/Hunter/MillionVerifier possible | No | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` research enrichment | scheduled, blocked-by-scheduled-pause | Web/LLM/enrichment possible | No | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` daily kickoff | scheduled, blocked-by-scheduled-pause | Can trigger capped top-up | Can draft/enqueue | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` KPI-gap kickoff | scheduled, blocked-by-scheduled-pause | Can trigger kickoff | Can draft/enqueue | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` market sensing | scheduled, blocked-by-scheduled-pause | Brave/LLM possible | No | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` Captain scheduled brief/tune/sweeps | scheduled, blocked-by-scheduled-pause | LLM possible | No direct outbound send | Paused by `SCHEDULED_AUTONOMY_PAUSED`. |
| `server/index.js` LinkedIn stale sweep | scheduled, blocked-by-scheduled-pause | No provider spend expected | Can mutate LinkedIn message state | Not scheduled while paused. |

## Internal API Routes

| Route | Label | Can spend | Can send | Phase 1 note |
|---|---|---:|---:|---|
| `POST /api/autonomous/kickoff` | manual-trigger, canonical but dangerous | Yes | Can draft/enqueue | Must not run while paused unless MJ approves exact action. |
| `POST /api/autonomous/kickoff-all` | disabled, legacy/dangerous | Yes, multi-tenant | Can draft/enqueue | Disabled unless `KICKOFF_ALL_ENABLED=true`; keep out of V2.1 Basic proof. |
| `POST /api/autonomous/send-approved` | internal send worker bridge | No sourcing spend | Yes, email only | Canonical send path for approved email. |
| `GET /api/autonomous/linkedin-queue` | manual-safe | No | No | Canonical manual LinkedIn queue data source. |
| `POST /api/autonomous/linkedin-mark-sent` | manual-safe | No | Marks LinkedIn sent/requested after human action | Canonical manual LinkedIn state update. |
| `POST /api/autonomous/trigger-morning-brief` | manual-trigger | LLM possible | Telegram only | Must not be treated as scheduled proof. |
| `POST /api/autonomous/trigger-quality-tune` | manual-trigger | LLM/DB write possible | No | Requires explicit approval if not dry-run. |
| `POST /api/autonomous/trigger-market-sensing` | manual-trigger | Brave/LLM possible | No | Requires explicit spend approval. |
| `POST /api/autonomous/dry-run-followup-drafts` | manual-trigger | LLM possible | No | Dry-run only; still may spend LLM. |
| `POST /api/autonomous/execute-followup-batch` | manual-trigger | LLM possible | Can enqueue/send-state changes | Requires explicit approval. |
| `POST /api/autonomous/vibe-prospecting/test` | manual diagnostic | VP credits possible | No | Not Basic autonomous sourcing. |
| `POST /api/autonomous/backfill-hunter-emails` | manual maintenance | Hunter/Brave/MillionVerifier possible | No | Not scheduled; needs explicit provider approval. |
| `POST /api/autonomous/bulk-redraft` | manual maintenance | LLM possible | No direct send | Requires explicit approval. |
| `POST /api/autonomous/enrich-cold-signals` | manual-trigger, router-level internal-key auth | Web/LLM possible | No | Protected by `router.use(requireInternalKey)`, but still needs explicit spend approval before production use. |

## Authenticated App Routes

| Route | Label | Can spend | Can send | Phase 1 note |
|---|---|---:|---:|---|
| `POST /api/agents/research/search` | manual app action | LLM/search possible | No | Legacy/manual research surface. |
| `POST /api/agents/sales/generate` | manual app action | LLM possible | No | Should eventually route through signal package preflight. |
| `POST /api/agents/ranger/review` | manual app action | LLM possible | No | Enforcer review surface. |
| `POST /api/agents/director/execute` | manual app action | Can source/draft | Can draft/enqueue | Must obey no-burn and spine contracts. |
| `POST /api/integrations/gmail/send` | manual send | No sourcing spend | Yes, email | Direct send path; must recount KPI. |
| `POST /api/integrations/send` | manual send | No sourcing spend | Yes, email | Direct send path; must recount KPI. |
| `POST /api/import/leads` | manual import | No provider spend | No | Basic-safe lead source if trusted import policy is clear. |
| `POST /api/leads` | manual create | No provider spend | No | Basic-safe manual lead creation. |
| `POST /api/messages` | manual create | No provider spend | No direct send | Must not bypass Enforcer for outbound production use. |
| `POST /api/approvals` / `PUT /api/approvals/:id` | manual approval | No provider spend | Can enqueue approved email | Canonical approval path. |
| LinkedIn approval actions in `server/routes/approvals.js` | manual-safe | No | Marks connection/DM state after human action | Must stay manual-safe in V2.1. |

## GitHub Scheduled Workflows

| Workflow | Label | Can spend | Can send | Phase 1 note |
|---|---|---:|---:|---|
| `.github/workflows/daily-health-pack.yml` | scheduled health | No | Telegram only | Read-only system-health summary. |
| `.github/workflows/kickoff-watchdog.yml` | scheduled health | No | Telegram only | Read-only watchdog. |
| `.github/workflows/platform-health.yml` | scheduled health | No | No | Read-only platform health. |
| `.github/workflows/hourly-report.yml` | manual | No | Telegram/report only | Read-only unless script changes. |
| `.github/workflows/trigger-kickoff.yml` | manual workflow | Yes | Can trigger kickoff | Not allowed while paused without approval. |
| `.github/workflows/trigger-market-sensing.yml` | manual workflow | Yes | No | Not allowed while paused without approval. |
| `.github/workflows/trigger-quality-tune.yml` | manual workflow | LLM/DB write possible | No | Not allowed without approval. |
| `.github/workflows/trigger-rescore.yml` | manual workflow | LLM possible | No | Not allowed without approval. |

## Phase 1 Status

- Manual trigger routes bypass scheduled pause by design. This is acceptable only because health exposes the autonomy state and operators know manual triggers require approval.
- `POST /api/autonomous/enrich-cold-signals` is protected by router-level internal-key auth, but it is still a manual spend route and must not be used as scheduled proof.
- `server/index.js` now uses centralized scheduled-pause logic from `server/services/autonomyState.js`.
- `/health` now exposes `autonomy_state` so pause/manual-only/armed state is visible without relying on individual job skip rows.
- `/api/autonomous/system-health` now exposes the same `autonomy_state` object.
- Phase 1 does not re-arm scheduled autonomy, run paid sourcing, trigger `/kickoff-all`, or activate Tin City.
