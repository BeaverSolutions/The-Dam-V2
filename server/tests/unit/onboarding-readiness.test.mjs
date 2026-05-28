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
    expect(recoverySource).toContain('m.ranger_score >= c.auto_approve_threshold');
    expect(recoverySource).toContain("COALESCE(la.decision, 'manual_pending') = 'manual_pending'");
    expect(recoverySource).toContain("COALESCE(la.reasons->>'borderline', 'false') <> 'true'");
    expect(recoverySource).toContain("l.status = 'new'");
    expect(recoverySource).toContain("l.pipeline_stage = 'prospecting'");
    expect(recoverySource).toContain('l.first_contacted_at IS NULL');
    expect(recoverySource).toContain("AUTO_APPROVE_ENABLED === 'false'");
    expect(recoverySource).toContain("prior.status = 'sent'");
    expect(recoverySource).toContain('enqueueMessage(clientId, row.message_id)');
    expect(indexSource).toContain("jobHealth.markRun('auto_approval_recovery'");
    expect(indexSource).toContain("jobHealth.markError('auto_approval_recovery'");
    expect(indexSource).toContain('recoverMissedAutoApprovals');
  });
});
