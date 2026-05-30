# BeavrDam Security Data Map

Last updated: 2026-05-31

## Data categories

- Account data: users, clients, roles, plan, trial, billing status, access codes, authorised devices, signup tokens.
- Sales workflow data: leads, messages, approvals, send queue, replies, calendar events, pipeline traces, imported lead files.
- Agent memory and learning data: agent memory, weekly learnings, directives, introspection, outcomes, research misses, mistake memory.
- Operational data: logs, LLM usage, budget/spend data, job health, admin API diagnostic traces.
- Integration data: encrypted provider credentials and connected-account status for Gmail, Google Calendar, Apollo, Hunter, AgentMail, Calendly, and Telegram where configured.

## Storage locations

- Production app database: tenant-scoped application tables in Postgres.
- Encrypted secrets: `agent_memory` rows where `memory_type = 'secret'`; values are encrypted server-side before persistence.
- Browser storage: non-secret user/profile and interface state only. Authentication uses the `dam_token` httpOnly cookie.
- Server environment: platform secrets such as JWT, encryption key, database URL, and provider API keys.

## Security boundaries

- Application routes require authentication except public login, join, privacy, and access-code flows.
- Tenant data is keyed by `client_id`; row-level security policies are present on tenant-scoped public tables.
- Super-admin operations use the canonical Beaver Solutions admin identity and are isolated under `/api/admin`.
- Provider API keys and refresh tokens must never be sent to frontend code. Admin screens may show configured status only.

## Known high-risk surfaces

- Temporary passwords, access codes, and signup links are intentionally returned only to super-admin workflows for onboarding.
- `/api/admin/sql` is disabled unless `ADMIN_SQL_ENABLED=true` is explicitly set for emergency diagnostics.
- Admin diagnostic rows in `admin_api_errors` are sanitized and protected by RLS.
