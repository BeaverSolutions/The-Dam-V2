import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { vi, describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

vi.mock('../../db/pool', () => ({ query: vi.fn() }));
vi.mock('../../services/logs', () => ({ createLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/pipelineTrace', () => ({ traceStage: vi.fn().mockResolvedValue(undefined) }));

const agents = require('../../services/agents.js');
const agentsSource = readFileSync(resolve(__dirname, '../../services/agents.js'), 'utf-8');
const configSource = readFileSync(resolve(__dirname, '../../config/agents.js'), 'utf-8');

const completeSignalPackage = {
  signal_id: 'hiring_sales_roles',
  signal_family: 'hiring_capability_build',
  source_channel: 'linkedin_jobs',
  source_url: 'https://www.linkedin.com/jobs/view/123',
  evidence: 'Acme Training is hiring a Business Development Manager in Kuala Lumpur',
  evidence_date: '2026-06-03',
  why_now: 'Acme Training is adding sales capacity now',
  company_icp_fit: { lead_class: 'icp_match', vertical_match: 'B2B services' },
  decision_maker: {
    name: 'Jane Tan',
    title: 'Founder',
    source_url: 'https://www.linkedin.com/in/janetan',
  },
};

function leadWithSignal(signalPackage = completeSignalPackage) {
  return {
    id: 'lead-123',
    name: 'Jane Tan',
    company: 'Acme Training',
    title: 'Founder',
    email: 'jane@acmetraining.com',
    metadata: {
      signal_package: signalPackage,
    },
  };
}

describe('Sales Beaver signal package preflight', () => {
  it('returns needs_more_research when signal_package.source_url is missing', () => {
    const pkg = { ...completeSignalPackage };
    delete pkg.source_url;

    const result = agents._test.salesSignalPreflight({
      lead: leadWithSignal(pkg),
      channel: 'email',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'needs_more_research',
      repair_route: 'needs_research_repair',
    });
    expect(result.missing_fields).toContain('source_url');
  });

  it('returns needs_more_research when why_now is missing', () => {
    const pkg = { ...completeSignalPackage };
    delete pkg.why_now;

    const result = agents._test.salesSignalPreflight({
      lead: leadWithSignal(pkg),
      channel: 'linkedin',
    });

    expect(result.status).toBe('needs_more_research');
    expect(result.missing_fields).toContain('why_now');
    expect(result.repair_route).toBe('needs_research_repair');
  });

  it('does not draft competitor-offer prospects', () => {
    const result = agents._test.salesSignalPreflight({
      lead: leadWithSignal({
        ...completeSignalPackage,
        company_icp_fit: { lead_class: 'competitor_offer' },
      }),
      channel: 'email',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'needs_more_research',
      reason: 'competitor_offer_disqualified',
      repair_route: 'competitor_offer_disqualified',
    });
  });

  it('builds hiring guidance from the signal instead of generic company praise', () => {
    const guidance = agents._test.signalDraftGuidance({
      ...completeSignalPackage,
      signal_family: 'hiring_capability_build',
    });

    expect(guidance).toContain('capacity pressure');
    expect(guidance).toContain('one pointed diagnostic question');
    expect(guidance.toLowerCase()).not.toContain('saw your company');
  });

  it('builds expansion guidance around market or team ramp pressure', () => {
    const guidance = agents._test.signalDraftGuidance({
      ...completeSignalPackage,
      signal_family: 'market_expansion',
    });

    expect(guidance).toContain('market/team ramp pressure');
    expect(guidance).toContain('one pointed diagnostic question');
  });

  it('builds active ads guidance around paid demand or campaign motion', () => {
    const guidance = agents._test.signalDraftGuidance({
      ...completeSignalPackage,
      signal_family: 'active_gtm_spend',
    });

    expect(guidance).toMatch(/paid demand|campaign motion/i);
    expect(guidance).toContain('one pointed diagnostic question');
  });

  it('adds channel-specific limits and source evidence to the Sales prompt context', () => {
    const context = agents._test.buildSalesSignalContext({
      lead: leadWithSignal(),
      channel: 'linkedin',
    });

    expect(context).toContain('SIGNAL PACKAGE');
    expect(context).toContain(completeSignalPackage.source_url);
    expect(context).toContain(completeSignalPackage.evidence);
    expect(context).toContain('observed signal -> commercial implication -> one pointed diagnostic question');
    expect(context).toContain('LinkedIn DM');
    expect(context).toContain('under 50 words');
  });

  it('keeps the deterministic preflight before the Sales LLM call', () => {
    const salesStart = agentsSource.indexOf('async function salesGenerate');
    const preflightIdx = agentsSource.indexOf('salesSignalPreflight', salesStart);
    const callAgentIdx = agentsSource.indexOf('await callAgent(', salesStart);

    expect(preflightIdx).toBeGreaterThan(salesStart);
    expect(callAgentIdx).toBeGreaterThan(preflightIdx);
  });

  it('consumes Captain fix_signal_copy directives before drafting', () => {
    const salesStart = agentsSource.indexOf('async function salesGenerate');
    const directivesRead = agentsSource.indexOf("readPendingDirectives(clientId, 'sales_beaver')", salesStart);
    const fixDirective = agentsSource.indexOf("directive_type === 'fix_signal_copy'", directivesRead);
    const promptContext = agentsSource.indexOf("CAPTAIN'S DIRECTIVE - signal copy repair", fixDirective);
    const consumed = agentsSource.indexOf('consumedDirectiveIds.push(fixSignalCopyDirective.id)', fixDirective);
    const callAgentIdx = agentsSource.indexOf('await callAgent(', salesStart);

    expect(directivesRead).toBeGreaterThan(salesStart);
    expect(fixDirective).toBeGreaterThan(directivesRead);
    expect(promptContext).toBeGreaterThan(fixDirective);
    expect(consumed).toBeGreaterThan(promptContext);
    expect(callAgentIdx).toBeGreaterThan(consumed);
  });

  it('updates the Sales Beaver system prompt contract for signal packages', () => {
    expect(configSource).toContain('signal_package');
    expect(configSource).toContain('needs_more_research');
    expect(configSource).toContain('observed signal');
    expect(configSource).toContain('commercial implication');
    expect(configSource).toContain('pointed diagnostic question');
    expect(configSource).toContain('No generic');
  });
});
