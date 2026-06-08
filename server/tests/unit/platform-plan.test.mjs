import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const platformPlan = require('../../services/platformPlan');
const pool = require('../../db/pool');

const originalQuery = pool.query;

afterEach(() => {
  pool.query = originalQuery;
});

const tenantIcp = {
  profile_version: 6,
  icp: {
    active_industries: ['B2B corporate training'],
    geographies: ['MY'],
    buying_signals: [
      { id: 'hiring_sales_roles', family: 'hiring_capability_build', enabled: true, priority: 1 },
    ],
  },
};

const verticalFirstIcp = {
  profile_version: 6,
  icp: {
    active_industries: ['marketing agency', 'B2B corporate training'],
    geographies: ['MY'],
    buying_signals: [],
  },
};

describe('platform plan builder', () => {
  it('creates separate no-spend platform calls for MY hiring instead of one crammed query', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      objective: 'find 5 in-ICP approval-ready leads',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'proof',
    });

    expect(plan.mode).toBe('proof');
    expect(plan.approval_required).toBe(true);
    expect(plan.platform_sequence.map(p => p.platform)).toEqual(
      expect.arrayContaining(['jobstreet_my', 'hiredly_my', 'linkedin_jobs'])
    );
    expect(plan.platform_sequence.every(p => p.query_validation.valid)).toBe(true);
    expect(plan.platform_sequence.every(p => p.query_validation.chars <= 400)).toBe(true);
    expect(plan.platform_sequence.every(p => p.query_validation.words <= 50)).toBe(true);
    expect(plan.platform_sequence[0].query).not.toContain(' OR site:hiredly.com');
  });

  it('plans hiring reach queries by role and geo without quoted tenant vertical', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      objective: 'find 5 in-ICP approval-ready leads',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'proof',
    });
    const hiringReachQueries = plan.platform_sequence.filter(item => (
      ['jobstreet_my', 'hiredly_my', 'linkedin_jobs', 'company_careers'].includes(item.platform)
    ));

    expect(hiringReachQueries.length).toBeGreaterThanOrEqual(3);
    hiringReachQueries.forEach(item => {
      expect(item.query).not.toContain('"B2B corporate training"');
      expect(item.query).toContain('"sales executive"');
      expect(item.query).toContain('Malaysia');
      expect(item.query_validation.valid).toBe(true);
      expect(item.query_validation.chars).toBeLessThanOrEqual(400);
      expect(item.query_validation.words).toBeLessThanOrEqual(50);
    });
    expect(hiringReachQueries.find(item => item.platform === 'linkedin_jobs')?.query)
      .toContain('site:linkedin.com/jobs/view');
  });

  it('builds vertical-first discovery plans from active industries and geo without hiring terms', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: verticalFirstIcp,
      objective: 'discover in-ICP companies first',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'vertical_first',
    });
    const queries = plan.platform_sequence.map(item => item.query);
    const queryText = queries.join('\n').toLowerCase();

    expect(plan.mode).toBe('proof');
    expect(plan.requested_mode).toBe('vertical_first');
    expect(plan.discovery_mode).toBe('vertical_first');
    expect(plan.platform_sequence.map(item => item.platform)).toEqual(
      expect.arrayContaining(['agency_directory', 'training_directory', 'vertical_web'])
    );
    expect(queryText).toContain('marketing agency');
    expect(queryText).toContain('corporate training');
    expect(queryText).toContain('malaysia');
    expect(queryText).not.toMatch(/sales executive|business development|account manager|linkedin\.com\/jobs|jobstreet|hiredly/i);
    expect(plan.platform_sequence.every(item => item.discovery_mode === 'vertical_first')).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.valid)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.chars <= 400)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.words <= 50)).toBe(true);
    expect(plan.excluded_platforms).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'jobstreet_my' }),
      expect.objectContaining({ platform: 'linkedin_jobs' }),
    ]));
    expect(platformPlan.verifyPlatformPlanHash(plan)).toBe(true);
  });

  it('excludes press/news from first MY hiring proof when stronger job platforms exist', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      requestedCount: 5,
      maxPaidQueries: 3,
      mode: 'proof',
    });

    expect(plan.excluded_platforms).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'press_news',
        reason: expect.stringMatching(/lower precision/i),
      }),
    ]));
  });

  it('hashes the exact plan so paid execution can verify confirmation', () => {
    const first = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      requestedCount: 5,
      maxPaidQueries: 3,
      mode: 'proof',
    });
    const second = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      requestedCount: 5,
      maxPaidQueries: 3,
      mode: 'proof',
    });

    expect(first.plan_hash).toMatch(/^[a-f0-9]{16}$/);
    expect(first.plan_hash).toBe(second.plan_hash);
    expect(first.required_confirmation).toContain(first.plan_hash);
    expect(platformPlan.verifyPlatformPlanHash(first)).toBe(true);

    const tampered = {
      ...first,
      platform_sequence: first.platform_sequence.map(item => (
        item.platform === 'linkedin_jobs'
          ? { ...item, query: `${item.query} extra` }
          : item
      )),
    };
    expect(platformPlan.verifyPlatformPlanHash(tampered)).toBe(false);
  });

  it('normalizes invalid requested and paid query counts without leaking NaN', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      requestedCount: 'nope',
      maxPaidQueries: 'also-nope',
      mode: 'proof',
    });

    expect(plan.requested_count).toBe(5);
    expect(plan.max_paid_queries).toBe(5);
    expect(plan.platform_sequence).toHaveLength(5);
    expect(JSON.stringify(plan)).not.toContain('NaN');
  });

  it('loads approved unexpired platform plans and normalizes stored json', async () => {
    let sql = '';
    let params = [];
    pool.query = async (query, values) => {
      sql = query;
      params = values;
      return {
        rows: [{
          id: 'plan-1',
          client_id: 'client-1',
          status: 'approved',
          mode: 'proof',
          objective: 'find leads',
          requested_count: 5,
          max_paid_queries: 3,
          budget_cap_usd: null,
          platform_sequence: '[{"platform":"jobstreet_my","query":"site:my.jobstreet.com sales"}]',
          excluded_platforms: '[]',
          stop_rule: '{"stop_on_invalid_query":true}',
          query_set_hash: 'queryhash',
          plan_hash: 'planhash',
          approved_by: 'mj',
          approved_at: '2026-06-08T00:00:00.000Z',
          expires_at: '2026-06-09T00:00:00.000Z',
        }],
      };
    };

    const loaded = await platformPlan.loadApprovedPlatformPlan('client-1', 'plan-1', 'planhash');

    expect(sql).toContain("AND status = 'approved'");
    expect(sql).toContain('AND expires_at > NOW()');
    expect(params).toEqual(['client-1', 'plan-1', 'planhash']);
    expect(loaded.platform_sequence).toEqual([
      expect.objectContaining({ platform: 'jobstreet_my' }),
    ]);
    expect(loaded.excluded_platforms).toEqual([]);
    expect(loaded.stop_rule.stop_on_invalid_query).toBe(true);
  });

  it('throws platform_plan_required when an approved plan cannot be loaded', async () => {
    pool.query = async () => ({ rows: [] });

    await expect(
      platformPlan.loadApprovedPlatformPlan('client-1', 'missing-plan', 'planhash')
    ).rejects.toMatchObject({ code: 'platform_plan_required' });
  });
});
