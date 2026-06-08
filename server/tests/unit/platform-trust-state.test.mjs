import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  strategyKeyForPlan,
  updateStrategyStateFromPlan,
} = require('../../services/platformYield');
const pool = require('../../db/pool');

const originalQuery = pool.query;

afterEach(() => {
  pool.query = originalQuery;
});

describe('platform trust strategy keys', () => {
  it('keys trust by signal, geo, and ordered platforms', () => {
    const key = strategyKeyForPlan({
      platform_sequence: [
        { platform: 'jobstreet_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
        { platform: 'hiredly_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
      ],
    });

    expect(key).toBe('hiring_sales_roles|MY|jobstreet_my,hiredly_my');
  });

  it('preserves platform order because strategy evidence is sequence-specific', () => {
    const first = strategyKeyForPlan({
      platform_sequence: [
        { platform: 'jobstreet_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
        { platform: 'hiredly_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
      ],
    });
    const reversed = strategyKeyForPlan({
      platform_sequence: [
        { platform: 'hiredly_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
        { platform: 'jobstreet_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
      ],
    });

    expect(first).not.toBe(reversed);
  });

  it('upserts trusted strategy state when yield clears the threshold', async () => {
    let sql = '';
    let params = [];
    pool.query = async (query, values) => {
      sql = query;
      params = values;
      return {
        rows: [{
          strategy_key: values[1],
          status: values[2],
          last_yield_pct: values[8],
        }],
      };
    };

    const row = await updateStrategyStateFromPlan('client-1', {
      id: 'plan-1',
      plan_hash: 'planhash',
      requested_count: 5,
      platform_sequence: [
        { platform: 'jobstreet_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
        { platform: 'hiredly_my', signal_id: 'hiring_sales_roles', geo: 'MY' },
      ],
    }, {
      approval_ready: 2,
      trusted_by: 'captain',
    });

    expect(sql).toContain('INSERT INTO platform_strategy_state');
    expect(sql).toContain('ON CONFLICT (client_id, strategy_key)');
    expect(params[1]).toBe('hiring_sales_roles|MY|jobstreet_my,hiredly_my');
    expect(params[2]).toBe('trusted');
    expect(params[8]).toBe(40);
    expect(params[10]).toBe(2);
    expect(params[11]).toBe('yield_above_threshold');
    expect(params[12]).toBe('captain');
    expect(row.status).toBe('trusted');
  });
});
