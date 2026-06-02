import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const { buildSignalScorecard } = require('../../services/beaverScorecard');
const captain = require('../../services/captainOrchestrator');
const directiveBus = require('../../services/directives');
const jobHealth = require('../../services/jobHealth');

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

  it('marks Captain health degraded when snapshot or directive truth layers fail', () => {
    jobHealth.markDegraded('captain_directive_sweep', 'dam_kpi_snapshot_failed', { client_id: 'client-1' });
    const status = jobHealth.getStatus();

    expect(status.captain_directive_sweep.status).toBe('degraded');
    expect(status.captain_directive_sweep.lastDegradedReason).toBe('dam_kpi_snapshot_failed');
    expect(status.captain_directive_sweep.lastMeta).toMatchObject({ client_id: 'client-1' });
  });
});
