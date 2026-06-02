# V2.1 Phase 2 Architecture Notes

Date: 2026-06-02
Branch: codex/v2-1-basic-foundation

## Source Of Truth

This note satisfies Phase 2 Step 2.0 from `V2.1-PHASED-IMPLEMENTATION-PLAN.md`.

Read before implementation:
- `C:\Users\MJ2\MJxClaude\logs\2026-06-02.md`
- `C:\Users\MJ2\MJxClaude\projects\beavrdam-rebuild\UNIVERSAL-SIGNAL-ENGINE-PLAN.md`
- `C:\Users\MJ2\MJxClaude\projects\beavrdam-rebuild\V2.1-BEAVER-UPGRADE-PLAN.md`
- `C:\Users\MJ2\MJxClaude\context\current-priorities-beaver.md`

No conflict found between the older architecture discussion and the locked V2.1 plan after MJ's correction: the correct Research principle is signal-source-first, then company extraction and ICP filtering.

## Locked Research Flow

```text
Captain selects signal playbook
-> Research searches the correct source channel
-> Research extracts companies from signal-source evidence
-> ICP and reject rules run
-> decision maker found
-> contact found
-> signal_package saved
-> Sales drafts only from signal_package
-> Enforcer grades evidence and copy
-> Captain tracks yield and stops dry spend
```

For the Beaver sales-hiring signal:

```text
sales/BD/SDR vacancy + geo lock
-> jobs/careers/job boards/LinkedIn jobs
-> extract companies
-> filter by ICP
-> find founder/CEO/head-of-sales
-> find/verify contact
-> save signal_package
```

Industry can help narrow results, but role plus geo must work even when industry is missing.

## Universal Signal Families

Phase 2 must support the ten locked signal families:

- hiring/capability build
- expansion/growth
- capital/budget event
- active GTM spend
- category/vendor intent
- technology/stack change
- leadership/org change
- regulatory/deadline pressure
- pain/friction evidence
- event/market presence

Each family needs default source channels, evidence requirements, blocker names, and source channel capabilities.

## Tool Boundary

Allowed for autonomous Beaver sourcing:
- public web search and public website extraction
- LinkedIn-style public search results and public company/profile pages where accessible
- company websites: careers, contact, about, team, blog, press, case studies
- public ad transparency surfaces
- Hunter after candidate company/person exists
- MillionVerifier after candidate email or pattern exists
- owned DB, replies, follow-up pool, trusted manual/client CSV imports

Rejected paths:
- VP/Explorium autonomous Beaver top-up
- generic fallback after signal source returns zero
- Hunter or MillionVerifier before raw candidates exist
- repeated identical zero-output query sets for the same client/day
- competitor-offer leads drafted as normal Beaver ICP

## Tenant Config Shape

Phase 2 adds tenant `buying_signals` with:

- `id`
- `family`
- `enabled`
- `priority`
- `source_channels`
- `query_terms`
- `geo_lock`
- `evidence_required`
- `decision_maker_strategy`
- `stop_rules`
- `reject_rules`

Activation requires at least one enabled signal. Each enabled signal needs source channels, evidence requirements, and stop rules.

## Signal Package Contract

Every saved lead should eventually carry:

- `signal_id`
- `signal_family`
- `source_channel`
- `source_url`
- `evidence`
- `company_icp_fit`
- `decision_maker`
- `contact`
- `why_now`
- `sales_angle`

Phase 2 creates the config and planner foundation. Later phases wire package persistence, Sales refusal, Enforcer routing, and Captain orchestration.

## Beaver Responsibilities

Research:
- run one selected signal playbook at a time
- log raw counts
- stop on zero raw candidates
- enrich only after candidate evidence exists
- save exact blocker reason

Sales:
- require usable signal package
- return `needs_more_research` when evidence is thin
- use signal-specific writing logic

Enforcer:
- grade evidence and copy separately
- route Research repair vs Sales repair
- disqualify competitor-offer prospects

Captain:
- choose signal playbooks
- track yield by signal/source
- stop dry signals
- block repeated zero-output spend
- degrade health when truth systems fail

## Tin City Implication

Tin City is not activated in Phase 2. The same tenant-agnostic signal engine will later support Tin City by swapping ICP, buying signals, source channels, evidence rules, reject rules, and decision-maker strategy.

## Phase 2 Implementation Boundary

Phase 2 implements:
- `server/config/buyingSignals.js`
- tenant profile `buying_signals` schema
- normalized tenant signal context
- `server/services/signalPlanner.js`
- focused tests for buying-signal config and planner behavior

Phase 2 does not:
- call providers
- re-arm scheduled autonomy
- run paid proof
- activate Tin City
- build Marketing Beaver
- build Premium LinkedIn automation
