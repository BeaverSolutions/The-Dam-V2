import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const { buildSignalScorecard } = require('../../services/beaverScorecard');
const captain = require('../../services/captainOrchestrator');
const directiveBus = require('../../services/directives');
const jobHealth = require('../../services/jobHealth');
const captainSource = readFileSync(resolve(__dirname, '../../services/captainOrchestrator.js'), 'utf-8');

const tenant = {
  icp: {
    verticals: ['B2B agency'],
    personas: ['Founder', 'CEO', 'Head of Sales'],
    geo: ['MY'],
    competitor_offers: ['lead generation', 'AI outbound'],
  },
  buying_signals: [
    {
      id: 'hiring_sales_roles',
      family: 'hiring_capability_build',
      enabled: true,
      priority: 1,
      source_channels: ['linkedin_jobs', 'company_careers'],
      query_terms: ['sales', 'business development'],
      evidence_required: ['company', 'role', 'source_url'],
      stop_rules: { max_paid_searches_per_day: 3, stop_if_raw_candidates_zero: true },
    },
    {
      id: 'expansion_markets',
      family: 'expansion_growth',
      enabled: true,
      priority: 2,
      source_channels: ['company_news', 'web_search'],
      query_terms: ['expanding', 'new office'],
      evidence_required: ['company', 'expansion_fact', 'source_url'],
      stop_rules: { max_paid_searches_per_day: 2, stop_if_raw_candidates_zero: true },
    },
  ],
};

const verticalOnlyTenant = {
  source: 'tenant_profiles',
  tenant_profile_content_version: 9,
  icp: {
    verticals: ['marketing agency', 'B2B corporate training'],
    active_industries: ['marketing agency', 'B2B corporate training'],
    geo: ['MY'],
    personas: ['Founder', 'CEO', 'Managing Director'],
  },
  buying_signals: [],
};

describe('Captain signal orchestration (V2.1 Phase 5)', () => {
  it('builds a per-signal scorecard from Research, Sales, Enforcer, and send events', () => {
    const scorecard = buildSignalScorecard([
      {
        signal_id: 'hiring_sales_roles',
        signal_family: 'hiring_capability_build',
        source_channel: 'linkedin_jobs',
        attempted: 1,
        raw_candidates: 10,
        icp_pass: 6,
        decision_maker_found: 4,
        contact_found: 3,
        saved_leads: 3,
        drafted: 2,
        approved: 1,
        sent: 1,
        cost_spend: 0.42,
      },
      {
        signal_id: 'hiring_sales_roles',
        source_channel: 'linkedin_jobs',
        blocker_reason: 'generic_message',
      },
    ]);

    expect(scorecard.hiring_sales_roles).toMatchObject({
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      attempted: 2,
      raw_candidates: 10,
      icp_pass: 6,
      decision_maker_found: 4,
      contact_found: 3,
      saved_leads: 3,
      drafted: 2,
      approved: 1,
      sent: 1,
    });
    expect(scorecard.hiring_sales_roles.source_channels).toEqual(['linkedin_jobs']);
    expect(scorecard.hiring_sales_roles.cost_spend).toBeCloseTo(0.42);
    expect(scorecard.hiring_sales_roles.blocker_reasons.generic_message).toBe(1);
  });

  it('builds scorecard rows from Signal Hunt completion and save-stage metrics', () => {
    const scorecard = buildSignalScorecard([
      {
        signal_id: 'hiring_sales_roles',
        signal_family: 'hiring_capability_build',
        source_channel: 'linkedin_jobs',
        attempted: 1,
        raw_candidates_total: 9,
        companies_extracted: 7,
        icp_passed: 5,
        decision_makers_found: 4,
        contacts_found: 3,
        saved: 2,
        blocker: 'contact_zero',
      },
    ]);

    expect(scorecard.hiring_sales_roles).toMatchObject({
      attempted: 1,
      raw_candidates: 9,
      icp_pass: 5,
      decision_maker_found: 4,
      contact_found: 3,
      saved_leads: 2,
    });
    expect(scorecard.hiring_sales_roles.blocker_reasons.contact_zero).toBe(1);
  });

  it('collects Signal Hunt complete/save logs for Captain per-signal yield', () => {
    expect(captainSource).toContain('signal_hunt_complete');
    expect(captainSource).toContain('signal_hunt_save_complete');
    expect(captainSource).toContain("metadata->>'icp_passed'");
    expect(captainSource).toContain("metadata->>'decision_makers_found'");
    expect(captainSource).toContain("metadata->>'contacts_found'");
    expect(captainSource).toContain("metadata->>'saved'");
  });

  it('stops a zero-yield signal for the day and selects another enabled signal', () => {
    const signalScorecard = buildSignalScorecard([
      {
        signal_id: 'hiring_sales_roles',
        signal_family: 'hiring_capability_build',
        source_channel: 'linkedin_jobs',
        attempted: 3,
        raw_candidates: 0,
        blocker_reason: 'raw_candidates_zero',
      },
    ]);

    const decision = captain._test.buildCaptainSignalOrchestration({
      tenant,
      currentSignalId: 'hiring_sales_roles',
      signalScorecard,
      spend: { provider_cap_closed: false, daily_budget_remaining_usd: 5 },
      queue: { pending_approvals: 3, capacity: 20 },
      channelReadiness: { email: true, linkedin: true },
    });

    expect(decision.stop_current_signal).toMatchObject({
      signal_id: 'hiring_sales_roles',
      stop_for_today: true,
    });
    expect(decision.stop_current_signal.reasons).toContain('raw_candidates_zero_after_approved_cap');
    expect(decision.next_playbook).toMatchObject({
      signal_id: 'expansion_markets',
      signal_family: 'expansion_growth',
      source_channel: 'company_news',
      cap: 2,
    });
  });

  it('can issue the first Research playbook before signal scorecard rows exist', () => {
    const decision = captain._test.buildCaptainSignalOrchestration({
      tenant,
      currentSignalId: null,
      signalScorecard: {},
      spend: { provider_cap_closed: false, daily_budget_remaining_usd: 5 },
      queue: { pending_approvals: 0, capacity: 20 },
      channelReadiness: { email: true, linkedin: true },
    });
    const sweepStart = captainSource.indexOf('async function runDirectiveSweep');
    const emptyScorecardGuard = captainSource.indexOf('signalIds.length === 0', sweepStart);
    const writeDirectives = captainSource.indexOf('writeSignalOrchestrationDirectives(clientId, signalOrchestration)', sweepStart);

    expect(decision.next_playbook).toMatchObject({
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'linkedin_jobs',
    });
    expect(emptyScorecardGuard).toBeGreaterThan(sweepStart);
    expect(writeDirectives).toBeGreaterThan(emptyScorecardGuard);
  });

  it('defaults empty-signals vertical tenants to Captain vertical-first primary lane', () => {
    const decision = captain._test.buildCaptainSignalOrchestration({
      tenant: verticalOnlyTenant,
      currentSignalId: null,
      signalScorecard: {},
      spend: { provider_cap_closed: false, daily_budget_remaining_usd: 5 },
      queue: { pending_approvals: 0, capacity: 20 },
      channelReadiness: { email: true, linkedin: true },
    });

    expect(decision.next_playbook).toMatchObject({
      signal_id: 'vertical_first_discovery',
      signal_family: 'vertical_first_discovery',
      source_channel: 'vertical_first',
      mode: 'vertical_first',
      discovery_mode: 'vertical_first',
      platform_plan_required: true,
      sourcing_lane_defaulted: {
        reason: 'tenant_buying_signals_empty_vertical_icp',
      },
    });
    expect(decision.next_playbook.queries).toEqual([]);
    expect(directiveBus.buildRunSignalPlaybookDirective(decision.next_playbook).payload).toMatchObject({
      signal_id: 'vertical_first_discovery',
      source_channel: 'vertical_first',
      mode: 'vertical_first',
      discovery_mode: 'vertical_first',
      platform_plan_required: true,
    });
    expect(captainSource).toContain('buildVerticalFirstPlaybookForTenant');
    expect(captainSource).toContain('sourcing_lane_defaulted');
  });

  it('defaults vertical tenants with generic signals (no vertical_first source_channel) to vertical-first primary lane', () => {
    // This is the Beaver Solutions production scenario:
    // active_industries configured + buying_signals exist but are all generic job-board/news signals.
    // The generic signals become why-now hooks, not discovery primitives.
    const beaverLikeTenant = {
      source: 'tenant_profiles',
      icp: {
        active_industries: ['marketing agency', 'B2B corporate training'],
        verticals: ['marketing agency', 'B2B corporate training'],
        geo: ['MY'],
        personas: ['Founder', 'CEO', 'Managing Director'],
      },
      buying_signals: [
        {
          id: 'hiring_sales_roles',
          family: 'hiring_capability_build',
          enabled: true,
          priority: 1,
          source_channels: ['linkedin_jobs', 'company_careers', 'job_boards', 'web_search'],
          query_terms: ['sales', 'business development'],
          evidence_required: ['company', 'role', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 6 },
        },
        {
          id: 'expansion_markets',
          family: 'expansion_growth',
          enabled: true,
          priority: 2,
          source_channels: ['company_news', 'press', 'web_search'],
          query_terms: ['expanding', 'new office'],
          evidence_required: ['company', 'expansion_fact', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 6 },
        },
      ],
    };

    const decision = captain._test.buildCaptainSignalOrchestration({
      tenant: beaverLikeTenant,
      currentSignalId: null,
      signalScorecard: {},
      spend: { provider_cap_closed: false, daily_budget_remaining_usd: 5 },
      queue: { pending_approvals: 0, capacity: 20 },
      channelReadiness: { email: true, linkedin: true },
    });

    expect(decision.next_playbook).toMatchObject({
      signal_id: 'vertical_first_discovery',
      signal_family: 'vertical_first_discovery',
      source_channel: 'vertical_first',
      mode: 'vertical_first',
      discovery_mode: 'vertical_first',
      platform_plan_required: true,
      sourcing_lane_defaulted: {
        reason: 'tenant_buying_signals_empty_vertical_icp',
        active_industries: expect.arrayContaining(['marketing agency', 'B2B corporate training']),
      },
    });
  });

  it('keeps signal-first for broad-ICP tenants (no active_industries, has buying signals)', () => {
    // tenant fixture has icp.verticals but no active_industries — stays signal-first
    const decision = captain._test.buildCaptainSignalOrchestration({
      tenant,
      currentSignalId: null,
      signalScorecard: {},
      spend: { provider_cap_closed: false, daily_budget_remaining_usd: 5 },
      queue: { pending_approvals: 0, capacity: 20 },
      channelReadiness: { email: true, linkedin: true },
    });
    expect(decision.next_playbook).toMatchObject({
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
    });
  });

  it('treats provider caps, repeated zero query sets, full queues, and channel readiness as dry-spend stops', () => {
    const stop = captain._test.evaluateSignalDryStop({
      signal: tenant.buying_signals[0],
      scorecard: {
        signal_id: 'hiring_sales_roles',
        attempted: 1,
        raw_candidates: 8,
        blocker_reasons: { repeated_zero_output_query_set: 1 },
      },
      spend: { provider_cap_closed: true },
      queue: { pending_approvals: 20, capacity: 20 },
      channelReadiness: { email: true, linkedin: false },
    });

    expect(stop.stop_for_today).toBe(true);
    expect(stop.reasons).toEqual(expect.arrayContaining([
      'same_query_set_already_failed',
      'provider_cap_closed',
      'downstream_queue_full',
      'send_channel_not_ready',
    ]));
  });

  it('builds Research and Sales directives with the planned Phase 5 payloads', () => {
    const researchDirective = directiveBus.buildRunSignalPlaybookDirective({
      signal_id: 'hiring_sales_roles',
      source_channel: 'linkedin_jobs',
      geo: ['MY'],
      cap: 6,
    });
    const salesDirective = directiveBus.buildFixSignalCopyDirective({
      signal_family: 'hiring_capability_build',
      reject_reason: 'generic_message',
    });

    expect(researchDirective).toEqual({
      directive_type: 'run_signal_playbook',
      target_agent: 'research_beaver',
      payload: {
        signal_id: 'hiring_sales_roles',
        source_channel: 'linkedin_jobs',
        geo: ['MY'],
        cap: 6,
      },
    });
    expect(salesDirective).toEqual({
      directive_type: 'fix_signal_copy',
      target_agent: 'sales_beaver',
      payload: {
        signal_family: 'hiring_capability_build',
        reject_reason: 'generic_message',
        instruction: 'lead with role hiring implication, not generic company observation',
      },
    });
  });

  it('builds one-shot Research repair directives with no-repeat memory', () => {
    const repairDirective = directiveBus.buildRepairSignalPackageDirective({
      leadId: 'lead-1',
      messageId: 'message-1',
      kickoffId: 'plan-1',
      channel: 'email',
      pipelinePath: 'signal_pipeline',
      failedRule: 'thin_evidence',
      missingFields: ['source_url', 'decision_maker'],
      signalPackage: {
        signal_id: 'hiring_sales_roles',
        evidence: ['Hiring BDR'],
        why_now: 'Outbound capacity build',
      },
    });

    expect(repairDirective.directive_type).toBe('repair_signal_package');
    expect(repairDirective.target_agent).toBe('research_beaver');
    expect(repairDirective.payload).toMatchObject({
      lead_id: 'lead-1',
      message_id: 'message-1',
      kickoff_id: 'plan-1',
      channel: 'email',
      pipeline_path: 'signal_pipeline',
      repair_route: 'needs_research_repair',
      failed_rule: 'thin_evidence',
      missing_fields: ['source_url', 'decision_maker'],
      repair_attempt: 1,
      max_repair_attempts: 1,
    });
    expect(repairDirective.payload.do_not_repeat.signal_package_hash).toBe(repairDirective.payload.original_signal_package_hash);
  });

  it('marks Captain health degraded when snapshot or directive truth layers fail', () => {
    jobHealth.markDegraded('captain_directive_sweep', 'dam_kpi_snapshot_failed', { client_id: 'client-1' });
    const status = jobHealth.getStatus();

    expect(status.captain_directive_sweep.status).toBe('degraded');
    expect(status.captain_directive_sweep.lastDegradedReason).toBe('dam_kpi_snapshot_failed');
    expect(status.captain_directive_sweep.lastMeta).toMatchObject({ client_id: 'client-1' });
  });
});
