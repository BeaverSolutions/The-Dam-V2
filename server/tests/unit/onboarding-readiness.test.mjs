import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const route = name => readFileSync(resolve(__dirname, `../../routes/${name}`), 'utf-8');
const service = name => readFileSync(resolve(__dirname, `../../services/${name}`), 'utf-8');
const clientPage = name => readFileSync(resolve(__dirname, `../../../client/src/pages/${name}`), 'utf-8');

describe('onboarding readiness contracts', () => {
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
    expect(superAdminSource).toContain("row.slug === 'beaver-solutions'");
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
