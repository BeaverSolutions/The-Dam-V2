import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const route = name => readFileSync(resolve(__dirname, `../../routes/${name}`), 'utf-8');
const service = name => readFileSync(resolve(__dirname, `../../services/${name}`), 'utf-8');
const middleware = name => readFileSync(resolve(__dirname, `../../middleware/${name}`), 'utf-8');
const clientPage = name => readFileSync(resolve(__dirname, `../../../client/src/pages/${name}`), 'utf-8');

describe('onboarding readiness contracts', () => {
  it('does not expose bearer JWTs in auth JSON responses', () => {
    const authSource = route('auth.js');

    expect(authSource).toContain('function setAuthCookie');
    expect(authSource).toContain('httpOnly: true');
    expect(authSource).toContain('res.json({ data: { user: result.user } })');
    expect(authSource).toContain('res.status(201).json({ data: { user: result.user } })');
    expect(authSource).toContain('res.json({ data: { user } })');
    expect(authSource).not.toContain('res.json({ data: { token, user } })');
    expect(authSource).not.toContain('res.status(201).json({ data: result })');
    expect(authSource).not.toContain('res.json({ data: { token:');
  });

  it('keeps raw admin SQL disabled unless explicitly enabled', () => {
    const adminSource = route('admin.js');

    expect(adminSource).toContain("process.env.ADMIN_SQL_ENABLED === 'true'");
    expect(adminSource).toContain('if (!ADMIN_SQL_ENABLED)');
    expect(adminSource).toContain("code: 'NOT_FOUND'");
  });

  it('renders weekly learning notes as text, not injected HTML', () => {
    const dashboardSource = clientPage('Dashboard.jsx');

    expect(dashboardSource).toContain('whiteSpace');
    expect(dashboardSource).not.toContain('dangerouslySetInnerHTML');
  });

  it('has a public privacy policy and internal data map', () => {
    const appSource = readFileSync(resolve(__dirname, '../../../client/src/App.jsx'), 'utf-8');
    const privacySource = clientPage('Privacy.jsx');
    const dataMap = readFileSync(resolve(__dirname, '../../../ops/security-data-map.md'), 'utf-8');

    expect(appSource).toContain("import Privacy from './pages/Privacy'");
    expect(appSource).toContain('path="/privacy"');
    expect(privacySource).toContain('Privacy Policy');
    expect(privacySource).toContain('Where Data Is Stored');
    expect(dataMap).toContain('Data categories');
    expect(dataMap).toContain('Storage locations');
  });

  it('closes Supabase advisor findings for admin errors and mutable trigger search paths', () => {
    const migration = readFileSync(resolve(__dirname, '../../db/migrations/080_security_prelaunch_hardening.sql'), 'utf-8');

    expect(migration).toContain('ALTER TABLE admin_api_errors ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY beaver_super_admin_read ON admin_api_errors');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.tenant_profiles_set_updated_at()');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.billing_intents_set_updated_at()');
    expect(migration).toContain('SET search_path = public');
    expect(migration).toContain('INSERT INTO schema_migrations (version) VALUES (80)');
  });

  it('admin credential status reads encrypted agent_memory secrets, not a missing credentials table', () => {
    const adminSource = route('admin.js');

    expect(adminSource).toContain('FROM agent_memory');
    expect(adminSource).toContain("memory_type = 'secret'");
    expect(adminSource).toContain("'gmail_tokens'");
    expect(adminSource).toContain("'gmail_refresh_token'");
    expect(adminSource).not.toContain('FROM credentials');
  });

  it('super admin access accepts only the canonical Beaver client identity', () => {
    const superAdminSource = readFileSync(resolve(__dirname, '../../middleware/superAdminOnly.js'), 'utf-8');

    expect(superAdminSource).toContain('BEAVER_SOLUTIONS_CLIENT_ID');
    expect(superAdminSource).toContain('ce2fc8e5-617e-42d5-91fe-4275ceaa0030');
    expect(superAdminSource).toContain("row?.slug === 'beaver-solutions'");
    expect(superAdminSource).toContain('pool.ownerQuery');
    expect(superAdminSource).not.toContain("name ILIKE '%beaver%'");
  });

  it('repairs the canonical Beaver client slug during migration', () => {
    const migration = readFileSync(resolve(__dirname, '../../db/migrations/076_fix_super_admin_beaver_slug.sql'), 'utf-8');

    expect(migration).toContain("slug = 'beaver-solutions'");
    expect(migration).toContain('ce2fc8e5-617e-42d5-91fe-4275ceaa0030');
    expect(migration).toContain('admin@beaversolutions.com');
  });

  it('creates admin-provisioned clients atomically with safe duplicate handling', () => {
    const adminSource = route('admin.js');

    expect(adminSource).toContain('Admin client list failed');
    expect(adminSource).toContain('async function uniqueClientSlug');
    expect(adminSource).toContain('SELECT id FROM clients WHERE slug = $1 LIMIT 1');
    expect(adminSource).toContain("SELECT 'user' AS kind, id FROM users WHERE email = $1");
    expect(adminSource).toContain("SELECT 'client' AS kind, id FROM clients WHERE email = $1");
    expect(adminSource).toContain("await dbClient.query('BEGIN')");
    expect(adminSource).toContain("await dbClient.query('COMMIT')");
    expect(adminSource).toContain("await dbClient.query('ROLLBACK')");
    expect(adminSource).toContain("err.code === '23505'");
    expect(adminSource).toContain("err.code === '22001'");
    expect(adminSource).toContain('FIELD_TOO_LONG');
    expect(adminSource).toContain('sendCreateClientUnknownError');
    expect(adminSource).toContain('Client provisioning failed');
    expect(adminSource).toContain('const adminQuery');
    expect(adminSource).toContain('pool.ownerQuery');
  });

  it('widens generated learning labels so provisioning is not blocked by varchar64 failures', () => {
    const migration = readFileSync(resolve(__dirname, '../../db/migrations/077_widen_learning_label_columns.sql'), 'utf-8');

    expect(migration).toContain('ALTER TABLE signup_tokens');
    expect(migration).toContain('ALTER COLUMN token TYPE TEXT');
    expect(migration).toContain('ALTER TABLE agent_outcomes');
    expect(migration).toContain('ALTER COLUMN source_strategy TYPE TEXT');
    expect(migration).toContain('ALTER COLUMN signal_type TYPE TEXT');
    expect(migration).toContain('ALTER COLUMN segment TYPE TEXT');
    expect(migration).toContain('ALTER TABLE agent_directives');
    expect(migration).toContain('ALTER COLUMN directive_type TYPE TEXT');
    expect(migration).toContain('ALTER TABLE research_misses');
    expect(migration).toContain('ALTER COLUMN miss_reason TYPE TEXT');
    expect(migration).toContain('INSERT INTO schema_migrations (version) VALUES (77)');
  });

  it('repairs calendar_events updated_at expected by Google Calendar sync', () => {
    const migration = readFileSync(resolve(__dirname, '../../db/migrations/078_calendar_events_updated_at.sql'), 'utf-8');

    expect(migration).toContain('ALTER TABLE calendar_events');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(migration).toContain('CREATE TRIGGER set_updated_at BEFORE UPDATE ON calendar_events');
    expect(migration).toContain('EXECUTE FUNCTION update_updated_at()');
    expect(migration).toContain('INSERT INTO schema_migrations (version) VALUES (78)');
  });

  it('Google Calendar sync uses the partial-index conflict target for google_event_id', () => {
    const calendarSource = service('googleCalendar.js');

    expect(calendarSource).toContain('ON CONFLICT (client_id, google_event_id) WHERE google_event_id IS NOT NULL DO UPDATE');
  });

  it('Captain directive sweep health fails when KPI snapshots fail to write', () => {
    const captainSource = service('captainOrchestrator.js');
    const indexSource = readFileSync(resolve(__dirname, '../../index.js'), 'utf-8');

    expect(captainSource).toContain('snapshot_written');
    expect(captainSource).toContain('snapshot_error');
    expect(captainSource).toContain("'dam_kpi_snapshot_failed'");
    expect(indexSource).toContain('captain_directive_sweep_snapshot_failed');
    expect(indexSource).toContain("jobHealth.markError('captain_directive_sweep'");
  });

  it('approval manual-send paths recount KPI after marking a message sent', () => {
    const approvalsSource = service('approvals.js');
    const sentUpdates = approvalsSource.match(/UPDATE messages SET status = 'sent'/g) || [];

    expect(sentUpdates.length).toBeGreaterThanOrEqual(2);
    expect(approvalsSource).toContain('function recountKpiAsync');
    expect(approvalsSource).toContain("recountKpiAsync(clientId, 'manual-send approval')");
    expect(approvalsSource).toContain("recountKpiAsync(clientId, 'linkedin accepted')");
  });

  it('direct integration email send recounts KPI after real sent state', () => {
    const integrationsSource = route('integrations.js');
    const sentIdx = integrationsSource.indexOf("SET status = 'sent', sent_at = NOW()");
    const recountIdx = integrationsSource.indexOf("require('../services/kpi').recountKpi(clientId)", sentIdx);

    expect(sentIdx).toBeGreaterThan(-1);
    expect(recountIdx).toBeGreaterThan(sentIdx);
  });

  it('surfaces and records sanitized admin API failures instead of generic production 500s', () => {
    const errorHandlerSource = middleware('errorHandler.js');
    const migration = readFileSync(resolve(__dirname, '../../db/migrations/079_admin_api_errors.sql'), 'utf-8');

    expect(errorHandlerSource).toContain("startsWith('/api/admin')");
    expect(errorHandlerSource).toContain('recordAdminApiError');
    expect(errorHandlerSource).toContain('Admin API failed');
    expect(errorHandlerSource).toContain('trace_id');
    expect(errorHandlerSource).toContain('admin_api_errors');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS admin_api_errors');
    expect(migration).toContain('trace_id    UUID NOT NULL');
    expect(migration).toContain('INSERT INTO schema_migrations (version) VALUES (79)');
  });

  it('Apollo CSV import is a trusted email source for Tier A imported leads', () => {
    const importSource = route('import.js');
    const importPage = clientPage('Import.jsx');

    expect(importSource).toContain("'apollo_csv'");
    expect(importSource).toContain('const isTrustedEmailCsv = isVibeCsv || isApolloCsv');
    expect(importSource).toContain('const emailVerified = isTrustedEmailCsv && !!email');
    expect(importSource).toContain('const emailSource = emailVerified ? importSource : null');
    expect(importSource).toContain("email ? 'A' : normalizedLinkedIn ? 'B' : null");
    expect(importPage).toContain("key: 'apollo_csv'");
    expect(importPage).toContain('Apollo CSV');
  });

  it('Captain Apollo preflight checks tenant-saved BYOK keys plus cap remaining', () => {
    const captainSource = service('captainBeaver.js');
    const agentsSource = service('agents.js');

    expect(captainSource).toContain("require('./apollo').getApiKey(clientId)");
    expect(captainSource).toContain("providerUsageToday('apollo', clientId)");
    expect(captainSource).toContain('apolloRemaining');
    expect(captainSource).toContain('providers.brave || providers.google_cse || providers.apollo');
    expect(agentsSource).toContain('apolloService.getApiKey(clientId)');
    expect(agentsSource).toContain('!!apolloKey && Number(process.env.APOLLO_DAILY_QUERY_CAP || 0) > 0');
  });

  it('V2.1 Basic exposes only approval, manual-safe LinkedIn, email send, reply, and follow-up surfaces', () => {
    const autonomousSource = route('autonomous.js');
    const leadsSource = route('leads.js');
    const sendQueueSource = service('sendQueueWorker.js');
    const replyDetectorSource = service('replyDetector.js');

    expect(autonomousSource).toContain('BASIC_OPERATING_SURFACE_V2_1');
    expect(autonomousSource).toContain('basic_operating_surface');
    expect(autonomousSource).toContain('approval_queue');
    expect(autonomousSource).toContain('manual_linkedin_queue');
    expect(autonomousSource).toContain('email_send_queue');
    expect(autonomousSource).toContain('reply_tracking');
    expect(autonomousSource).toContain('followup_visibility');

    expect(leadsSource).toContain('BASIC_LEAD_OPERATING_SURFACE');
    expect(leadsSource).toContain("router.get('/basic-operating-surface'");
    expect(leadsSource).toContain('manual_reply_registration');
    expect(leadsSource).toContain('manual_meeting_outcome');

    expect(sendQueueSource).toContain('BASIC_SEND_POLICY');
    expect(sendQueueSource).toContain("auto_send_channel: 'email'");
    expect(sendQueueSource).toContain('basic_manual_send_channel');

    expect(replyDetectorSource).toContain('BASIC_REPLY_TRACKING_POLICY');
    expect(replyDetectorSource).toContain('reply_tracking');
  });

  it('V2.1 Basic explicitly excludes Marketing Beaver, campaigns, and managed LinkedIn automation', () => {
    const autonomousSource = route('autonomous.js');

    expect(autonomousSource).toContain('premium_exclusions');
    expect(autonomousSource).toContain('marketing_beaver');
    expect(autonomousSource).toContain('email_campaign_system');
    expect(autonomousSource).toContain('managed_linkedin_automation');
    expect(autonomousSource).toContain('auto_connect');
    expect(autonomousSource).toContain('accepted_dm_automation');
  });

  it('Tin City and external tenants remain gated until onboarding and Basic proof are honest', () => {
    const autonomousSource = route('autonomous.js');

    expect(autonomousSource).toContain('external_tenant_activation_gate');
    expect(autonomousSource).toContain('v2_1_basic_path_honest');
    expect(autonomousSource).toContain('byok_access_plan_clear');
    expect(autonomousSource).toContain('sender_persona_confirmed');
    expect(autonomousSource).toContain('voice_examples_or_safe_starter_voice');
    expect(autonomousSource).toContain('geo_and_icp_clear');
    expect(autonomousSource).toContain('tenant_specific_signal_config');
    expect(autonomousSource).toContain('no_fresh_red_blocker');
    expect(autonomousSource).toContain('tin_city_status');
    expect(autonomousSource).toContain('inactive_until_gate_passes');
  });
});

describe('auto-approval recovery contracts', () => {
  it('recovers only high-score pending approvals through the same safety gates', () => {
    const recoverySource = service('autoApprovalRecovery.js');
    const indexSource = readFileSync(resolve(__dirname, '../../index.js'), 'utf-8');

    expect(recoverySource).toContain("m.status = 'pending_approval'");
    expect(recoverySource).toContain('m.ranger_score >= $4::int');
    expect(recoverySource).not.toContain('JOIN clients c');
    expect(indexSource).toContain('autoApproveThreshold: client.auto_approve_threshold');
    expect(indexSource).toContain('clientCreatedAt: client.created_at');
    expect(recoverySource).toContain("COALESCE(la.decision, 'manual_pending') = 'manual_pending'");
    expect(recoverySource).toContain("COALESCE(la.reasons->>'borderline', 'false') <> 'true'");
    expect(recoverySource).toContain("l.status = 'new'");
    expect(recoverySource).toContain("l.pipeline_stage = 'prospecting'");
    expect(recoverySource).toContain('l.first_contacted_at IS NULL');
    expect(recoverySource).toContain("AUTO_APPROVAL_RECOVERY_ENABLED === 'true'");
    expect(indexSource).toContain("AUTO_APPROVAL_RECOVERY_ENABLED !== 'true'");
    expect(recoverySource).toContain("prior.status = 'sent'");
    expect(recoverySource).toContain('enqueueMessage(clientId, row.message_id)');
    expect(indexSource).toContain("jobHealth.markRun('auto_approval_recovery'");
    expect(indexSource).toContain("jobHealth.markError('auto_approval_recovery'");
    expect(indexSource).toContain('recoverMissedAutoApprovals');
  });
});
