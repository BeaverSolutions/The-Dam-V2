import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  BILLING_PLAN_OPTIONS,
  calculateBillingIntent,
  calculateTrialWindow,
} = require('../../services/billing.js');

describe('billing plan and trial helpers', () => {
  it('exposes 14-day and 30-day trial windows', () => {
    const start = new Date('2026-06-03T00:00:00.000Z');

    expect(calculateTrialWindow(14, start)).toEqual({
      trial_length_days: 14,
      trial_started_at: '2026-06-03T00:00:00.000Z',
      trial_ends_at: '2026-06-17T00:00:00.000Z',
    });

    expect(calculateTrialWindow(30, start).trial_ends_at).toBe('2026-07-03T00:00:00.000Z');
  });

  it('calculates manual-invoice terms from the sales-deck pricing', () => {
    expect(BILLING_PLAN_OPTIONS.map(option => option.term)).toEqual(['monthly', 'six_months', 'annual']);

    expect(calculateBillingIntent({ plan: 'growth', term: 'monthly' })).toMatchObject({
      plan: 'growth',
      term: 'monthly',
      currency: 'MYR',
      monthly_amount_rm: 2500,
      months: 1,
      total_amount_rm: 2500,
    });

    expect(calculateBillingIntent({ plan: 'growth', term: 'six_months' })).toMatchObject({
      monthly_amount_rm: 2250,
      months: 6,
      total_amount_rm: 13500,
    });

    expect(calculateBillingIntent({ plan: 'growth', term: 'annual' })).toMatchObject({
      monthly_amount_rm: 1500,
      months: 12,
      total_amount_rm: 18000,
    });
  });

  it('rejects unsupported trial lengths and invoice terms', () => {
    expect(() => calculateTrialWindow(7, new Date('2026-06-03T00:00:00.000Z'))).toThrow('Unsupported trial length');
    expect(() => calculateBillingIntent({ plan: 'growth', term: 'quarterly' })).toThrow('Unsupported billing term');
  });
});
