import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsSource = readFileSync(resolve(__dirname, '../../services/agents.js'), 'utf-8');
const captainSource = readFileSync(resolve(__dirname, '../../services/captainBeaver.js'), 'utf-8');

describe('director DB-first eligibility', () => {
  const dbFirstStart = agentsSource.indexOf('Step 0: DB-first');
  const dbFirstEnd = agentsSource.indexOf('if (uncontactedLeads.length > 0)', dbFirstStart);
  const dbFirstSql = agentsSource.slice(dbFirstStart, dbFirstEnd);

  it('blocks only active outreach states, not old rejected or deleted drafts', () => {
    expect(dbFirstSql).toContain('m.status IN (');
    expect(dbFirstSql).toContain("'pending_ranger'");
    expect(dbFirstSql).toContain("'pending_approval'");
    expect(dbFirstSql).toContain("'approved'");
    expect(dbFirstSql).toContain("'pending_send'");
    expect(dbFirstSql).toContain("'sending'");
    expect(dbFirstSql).toContain("'sent'");
    expect(dbFirstSql).toContain("'delivered'");
    expect(dbFirstSql).toContain("'linkedin_requested'");
    expect(dbFirstSql).toContain("'awaiting_accept'");
    expect(dbFirstSql).not.toContain("m.status <> 'deleted'");
    expect(dbFirstSql).not.toContain("'ranger_rejected'");
    expect(dbFirstSql).not.toContain("'blocked_no_email'");
  });

  it('still prevents same-day re-enrolment through pipeline traces', () => {
    expect(dbFirstSql).toContain('pipeline_traces pt');
    expect(dbFirstSql).toContain("pt.stage = 'enrolled'");
    expect(dbFirstSql).toContain("Asia/Kuala_Lumpur");
  });
});

describe('Captain campaign preflight eligibility', () => {
  const preflightStart = captainSource.indexOf('async function getRunCampaignPreflight');
  const preflightEnd = captainSource.indexOf('const { CAPS }', preflightStart);
  const preflightSql = captainSource.slice(preflightStart, preflightEnd);

  it('uses the same active outreach dedupe as Director DB-first', () => {
    expect(preflightSql).toContain('m.status IN (');
    expect(preflightSql).toContain("'pending_ranger'");
    expect(preflightSql).toContain("'pending_approval'");
    expect(preflightSql).toContain("'approved'");
    expect(preflightSql).toContain("'pending_send'");
    expect(preflightSql).toContain("'sending'");
    expect(preflightSql).toContain("'sent'");
    expect(preflightSql).toContain("'delivered'");
    expect(preflightSql).toContain("'linkedin_requested'");
    expect(preflightSql).toContain("'awaiting_accept'");
    expect(preflightSql).not.toContain("m.status <> 'deleted'");
    expect(preflightSql).not.toContain("'ranger_rejected'");
  });
});
