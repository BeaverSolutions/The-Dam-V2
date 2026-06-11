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

const hiringSignalIcp = {
  profile_version: 6,
  icp: {
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
      icp: hiringSignalIcp,
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
      icp: hiringSignalIcp,
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

  it('biases vertical-first MY queries with locality + global-brand negatives without breaking Brave limits', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      objective: 'SME-biased vertical-first discovery',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'vertical_first',
    });
    const queries = plan.platform_sequence.map(item => item.query);
    const queryText = queries.join('\n');

    // Locality expansion: bare "Malaysia" is now joined by KL / PJ / Selangor /
    // Penang / Johor so the SEO ranking widens past Kuala-Lumpur-only giants.
    expect(queryText).toMatch(/Kuala Lumpur/);
    expect(queryText).toMatch(/Petaling Jaya/);
    expect(queryText).toMatch(/Selangor/);
    expect(queryText).toMatch(/Penang/);

    // Global-brand negatives applied at query time.
    for (const q of queries) {
      expect(q).toMatch(/-"WPP"/);
      expect(q).toMatch(/-"Publicis"/);
      expect(q).toMatch(/-"Dentsu"/);
      expect(q).toMatch(/-"Omnicom"/);
      expect(q).toMatch(/-"Fortune 500"/);
      expect(q).toMatch(/-"global network"/);
    }

    // Brave limits respected and no hiring terms.
    expect(plan.platform_sequence.every(item => item.query_validation.valid)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.chars <= 400)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.words <= 50)).toBe(true);
    expect(queryText).not.toMatch(/sales executive|business development|account manager|hiring|careers|linkedin\.com\/jobs|jobstreet|hiredly/i);
  });

  it('expands SG vertical-first queries with locality + global-brand negatives', () => {
    const sgIcp = {
      active_industries: ['marketing agency', 'B2B corporate training'],
      verticals: ['marketing agency', 'B2B corporate training'],
      geo: ['SG'],
    };
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: sgIcp,
      objective: 'SG SME-biased vertical-first discovery',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'vertical_first',
    });
    const queryText = plan.platform_sequence.map(item => item.query).join('\n');
    expect(queryText).toMatch(/Singapore/);
    expect(queryText).toMatch(/-"WPP"/);
    expect(plan.platform_sequence.every(item => item.query_validation.valid)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.chars <= 400)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.words <= 50)).toBe(true);
  });

  it('normalizes tenant-profile comma-string geographies before platform selection', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'tin-city',
      icp: {
        active_industries: ['roofing'],
        verticals: 'roofing',
        geographies: 'United States, Canada',
        buying_signals: [
          { id: 'roofing_hiring_sales_ops', family: 'hiring_capability_build', enabled: true },
        ],
      },
      objective: 'Tin City vertical-first proof',
      requestedCount: 2,
      maxPaidQueries: 6,
      mode: 'vertical_first',
    });

    expect(plan.discovery_mode).toBe('vertical_first');
    expect(plan.platform_sequence.length).toBeGreaterThan(0);
    expect(plan.platform_sequence.every(item => item.geo === 'US')).toBe(true);
    expect(plan.platform_sequence.map(item => item.platform)).toEqual(
      expect.arrayContaining(['agency_directory', 'training_directory', 'vertical_web'])
    );
    expect(plan.platform_sequence.map(item => item.query).join('\n')).toContain('"Tampa"');
    expect(platformPlan.verifyPlatformPlanHash(plan)).toBe(true);
  });

  it('biases US roofing vertical-first queries toward local SMB operators', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'tin-city',
      icp: {
        active_industries: ['roofing'],
        verticals: ['roofing'],
        geo: ['United States'],
        buying_signals: [
          { id: 'roofing_hiring_sales_ops', family: 'hiring_capability_build', enabled: true },
        ],
      },
      objective: 'Tin City roofing proof',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'vertical_first',
    });
    const queryText = plan.platform_sequence.map(item => item.query).join('\n');

    expect(queryText).toContain('roofing contractor');
    expect(queryText).toMatch(/Tampa/);
    expect(queryText).toMatch(/Dallas/);
    expect(queryText).toMatch(/Phoenix/);
    expect(queryText).toMatch(/local roofing contractor/);
    expect(queryText).toMatch(/owner/);
    expect(queryText).toMatch(/president/);
    expect(queryText).toMatch(/owner OR president OR "about us" OR "meet the team"/);
    expect(queryText).toMatch(/-"ZoomInfo"/);
    expect(queryText).toMatch(/-"Yelp"/);
    expect(queryText).toMatch(/-"Angi"/);
    expect(queryText).toMatch(/-"HomeAdvisor"/);
    expect(queryText).toMatch(/-"Tecta"/);
    expect(queryText).toMatch(/-"Beacon"/);
    expect(queryText).toMatch(/-"QXO"/);
    expect(queryText).not.toMatch(/WPP|Publicis|Dentsu|Omnicom/);
    expect(plan.platform_sequence.every(item => item.geo === 'US')).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.valid)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.chars <= 400)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.words <= 50)).toBe(true);
  });

  it('keeps Tin City roofing hiring signals in job-board-first sourcing', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'tin-city',
      icp: {
        active_industries: ['roofing'],
        verticals: ['roofing'],
        geo: ['United States'],
        buying_signals: [
          {
            id: 'roofing_hiring_sales_ops',
            family: 'hiring_capability_build',
            enabled: true,
            source_channels: ['linkedin_jobs', 'web_search'],
            query_terms: ['roofing sales representative', 'roofing project manager'],
            evidence_required: ['company', 'role', 'source_url'],
            stop_rules: { max_paid_searches_per_day: 6 },
          },
        ],
      },
      objective: 'Tin City hiring-signal proof',
      requestedCount: 5,
      maxPaidQueries: 6,
      mode: 'proof',
    });
    const queryText = plan.platform_sequence.map(item => item.query).join('\n');

    expect(plan.discovery_mode).toBe('signal_first');
    expect(plan.sourcing_lane_defaulted).toBeNull();
    expect(plan.platform_sequence.map(item => item.platform)).toEqual(
      expect.arrayContaining(['indeed_us', 'linkedin_jobs', 'company_careers'])
    );
    expect(queryText).toMatch(/site:indeed\.com/);
    expect(queryText).toMatch(/roofing sales representative/);
    expect(queryText).toMatch(/roofing project manager/);
    expect(queryText).toMatch(/roofing estimator/);
    expect(queryText).toMatch(/United States/);
    expect(queryText).not.toMatch(/local roofing contractor|owner OR president/);
    expect(plan.platform_sequence.every(item => item.signal_id === 'roofing_hiring_sales_ops')).toBe(true);
    expect(plan.platform_sequence.every(item => item.signal_family === 'hiring_capability_build')).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.valid)).toBe(true);
  });

  it('biases Canada roofing vertical-first queries with Canadian localities', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'tin-city',
      icp: {
        active_industries: ['roofing contractor'],
        verticals: ['roofing contractor'],
        geo: ['Canada'],
      },
      objective: 'Tin City Canada roofing proof',
      requestedCount: 3,
      maxPaidQueries: 3,
      mode: 'vertical_first',
    });
    const queryText = plan.platform_sequence.map(item => item.query).join('\n');

    expect(queryText).toMatch(/Toronto/);
    expect(queryText).toMatch(/Vancouver/);
    expect(queryText).toMatch(/Calgary/);
    expect(plan.platform_sequence.every(item => item.geo === 'CA')).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.valid)).toBe(true);
    expect(plan.platform_sequence.every(item => item.query_validation.words <= 50)).toBe(true);
  });

  it('defaults empty-signals vertical ICPs to vertical-first instead of silent hiring fallback', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: verticalFirstIcp,
      objective: 'find 5 in-ICP approval-ready leads',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'proof',
    });
    const queryText = plan.platform_sequence.map(item => item.query).join('\n').toLowerCase();

    expect(plan.mode).toBe('proof');
    expect(plan.requested_mode).toBe('proof');
    expect(plan.discovery_mode).toBe('vertical_first');
    expect(plan.sourcing_lane_defaulted).toMatchObject({
      from: 'signal_first',
      to: 'vertical_first',
      reason: 'tenant_buying_signals_empty_vertical_icp',
    });
    expect(queryText).toContain('marketing agency');
    expect(queryText).toContain('corporate training');
    expect(queryText).not.toMatch(/sales executive|business development|account manager|linkedin\.com\/jobs|jobstreet|hiredly/i);
    expect(platformPlan.verifyPlatformPlanHash(plan)).toBe(true);
  });

  it('defaults Beaver-style vertical ICPs with generic signals to vertical-first', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: tenantIcp,
      objective: 'find 5 in-ICP approval-ready leads',
      requestedCount: 5,
      maxPaidQueries: 5,
      mode: 'proof',
    });
    const queryText = plan.platform_sequence.map(item => item.query).join('\n').toLowerCase();

    expect(plan.discovery_mode).toBe('vertical_first');
    expect(plan.sourcing_lane_defaulted).toMatchObject({
      from: 'signal_first',
      to: 'vertical_first',
      reason: 'tenant_vertical_icp_generic_signals',
    });
    expect(queryText).toContain('corporate training');
    expect(queryText).not.toMatch(/sales executive|business development|account manager|linkedin\.com\/jobs|jobstreet|hiredly/i);
    expect(platformPlan.verifyPlatformPlanHash(plan)).toBe(true);
  });

  it('excludes press/news from first MY hiring proof when stronger job platforms exist', () => {
    const plan = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: hiringSignalIcp,
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
      icp: hiringSignalIcp,
      requestedCount: 5,
      maxPaidQueries: 3,
      mode: 'proof',
    });
    const second = platformPlan.buildPlatformPlan({
      clientId: 'client-1',
      icp: hiringSignalIcp,
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
      icp: hiringSignalIcp,
      requestedCount: 'nope',
      maxPaidQueries: 'also-nope',
      mode: 'proof',
    });

    expect(plan.requested_count).toBe(5);
    expect(plan.max_paid_queries).toBe(5);
    expect(plan.platform_sequence.length).toBeGreaterThan(0);
    expect(plan.platform_sequence.length).toBeLessThanOrEqual(5);
    expect(plan.platform_sequence.map(item => item.platform)).not.toContain('press_news');
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

  it('loads the latest approved vertical-first plan for scheduled sourcing', async () => {
    let sql = '';
    let params = [];
    pool.query = async (query, values) => {
      sql = query;
      params = values;
      return {
        rows: [
          {
            id: 'signal-plan',
            client_id: 'client-1',
            status: 'approved',
            mode: 'proof',
            objective: 'hiring proof',
            requested_count: 5,
            max_paid_queries: 5,
            budget_cap_usd: null,
            platform_sequence: [{ platform: 'jobstreet_my', discovery_mode: 'signal_first' }],
            excluded_platforms: [],
            stop_rule: {},
            query_set_hash: 'signalhash',
            plan_hash: 'signalplanhash',
            approved_by: 'mj',
            approved_at: '2026-06-08T00:00:00.000Z',
            expires_at: '2026-06-09T00:00:00.000Z',
            created_at: '2026-06-08T00:00:00.000Z',
          },
          {
            id: 'vertical-plan',
            client_id: 'client-1',
            status: 'approved',
            mode: 'proof',
            objective: 'vertical proof',
            requested_count: 5,
            max_paid_queries: 12,
            budget_cap_usd: null,
            platform_sequence: [{ platform: 'training_directory', discovery_mode: 'vertical_first' }],
            excluded_platforms: [],
            stop_rule: {},
            query_set_hash: 'verticalhash',
            plan_hash: 'verticalplanhash',
            approved_by: 'mj',
            approved_at: '2026-06-08T00:00:00.000Z',
            expires_at: '2026-06-09T00:00:00.000Z',
            created_at: '2026-06-08T00:00:00.000Z',
          },
        ],
      };
    };

    const loaded = await platformPlan.loadLatestApprovedPlatformPlan('client-1', { discoveryMode: 'vertical_first' });

    expect(sql).toContain("AND status = 'approved'");
    expect(sql).toContain('ORDER BY approved_at DESC NULLS LAST, created_at DESC');
    expect(params).toEqual(['client-1']);
    expect(loaded.id).toBe('vertical-plan');
    expect(loaded.max_paid_queries).toBe(12);
  });

  it('throws platform_plan_required when an approved plan cannot be loaded', async () => {
    pool.query = async () => ({ rows: [] });

    await expect(
      platformPlan.loadApprovedPlatformPlan('client-1', 'missing-plan', 'planhash')
    ).rejects.toMatchObject({ code: 'platform_plan_required' });
  });
});
