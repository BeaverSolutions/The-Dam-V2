import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const platformPlan = require('../../services/platformPlan');

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
});
