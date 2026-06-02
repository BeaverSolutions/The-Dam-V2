import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let signalPlanner = null;
try {
  signalPlanner = require('../../services/signalPlanner.js');
} catch (err) {
  signalPlanner = null;
}

const tenantContext = {
  icp: {
    verticals: ['B2B agency'],
    personas: ['Founder', 'CEO', 'Head of Sales'],
    geo: ['MY', 'SG'],
    exclusions: ['enterprise'],
    competitor_offers: ['lead generation', 'cold email', 'sales automation', 'AI outbound', 'SDR-as-a-service'],
  },
  buying_signals: [
    {
      id: 'hiring_sales_roles',
      family: 'hiring_capability_build',
      enabled: true,
      priority: 1,
      source_channels: ['linkedin_jobs', 'company_careers', 'job_boards', 'web_search'],
      query_terms: ['sales', 'business development', 'SDR'],
      geo_lock: true,
      evidence_required: ['company', 'role', 'source_url'],
      decision_maker_strategy: ['founder', 'ceo', 'head_of_sales'],
      stop_rules: { max_paid_searches_per_day: 3, stop_if_raw_candidates_zero: true },
      reject_rules: { competitor_offers: ['lead generation', 'AI outbound'] },
    },
    {
      id: 'expansion_markets',
      family: 'expansion_growth',
      enabled: true,
      priority: 2,
      source_channels: ['company_news', 'press', 'company_careers', 'web_search'],
      query_terms: ['expanding', 'new office', 'launched'],
      geo_lock: true,
      evidence_required: ['company', 'expansion_fact', 'source_url'],
      decision_maker_strategy: ['founder', 'ceo', 'head_of_sales'],
      stop_rules: { max_paid_searches_per_day: 2, stop_if_raw_candidates_zero: true },
    },
    {
      id: 'fresh_capital',
      family: 'capital_budget_event',
      enabled: true,
      priority: 3,
      source_channels: ['news', 'press', 'investor_pages', 'web_search'],
      query_terms: ['funding', 'grant', 'investment', 'acquired'],
      geo_lock: true,
      evidence_required: ['company', 'event', 'source_url'],
      decision_maker_strategy: ['founder', 'ceo'],
      stop_rules: { max_paid_searches_per_day: 2, stop_if_raw_candidates_zero: true },
    },
    {
      id: 'active_ads',
      family: 'active_gtm_spend',
      enabled: true,
      priority: 4,
      source_channels: ['meta_ad_library', 'google_ads_transparency', 'landing_pages'],
      query_terms: ['demo', 'book a call', 'free consultation'],
      geo_lock: true,
      evidence_required: ['company', 'ad_url', 'offer'],
      decision_maker_strategy: ['founder', 'ceo', 'head_of_sales'],
      stop_rules: { max_paid_searches_per_day: 2, stop_if_raw_candidates_zero: true },
    },
  ],
};

describe('signal planner', () => {
  it('is consumed by Research query planning when buying signals exist', () => {
    const research = readFileSync(resolve(__dirname, '../../services/research.js'), 'utf-8');
    const tenantContext = readFileSync(resolve(__dirname, '../../services/tenantContext.js'), 'utf-8');

    expect(research).toContain("require('./signalPlanner')");
    expect(research).toContain('buildQueryPoolFromSignalPlanner');
    expect(research).toContain('signal_id');
    expect(tenantContext).toContain('buying_signals: normalizeBuyingSignalsForTenant');
  });

  it('builds hiring plans with role, geography, optional industry, and source channel evidence', () => {
    expect(signalPlanner).toBeTruthy();

    const plan = signalPlanner.buildSignalPlan({
      tenant: tenantContext,
      signalId: 'hiring_sales_roles',
      geo: ['MY'],
    });

    expect(plan.signalId).toBe('hiring_sales_roles');
    expect(plan.signalFamily).toBe('hiring_capability_build');
    expect(plan.sourceChannels).toContain('linkedin_jobs');
    expect(plan.stopRules.max_paid_searches_per_day).toBe(3);
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(plan.queries.some(q => /sales|business development|SDR/i.test(q.query))).toBe(true);
    expect(plan.queries.every(q => /Malaysia|MY/i.test(q.query))).toBe(true);
    expect(plan.queries.some(q => /B2B agency/i.test(q.query))).toBe(true);
    expect(plan.queries[0].expectedEvidence).toEqual(['company', 'role', 'source_url']);
  });

  it('keeps hiring viable with role plus geo when industry is missing', () => {
    const plan = signalPlanner.buildSignalPlan({
      tenant: {
        ...tenantContext,
        icp: { ...tenantContext.icp, verticals: [] },
      },
      signalId: 'hiring_sales_roles',
      geo: ['SG'],
    });

    expect(plan.queries.length).toBeGreaterThan(0);
    expect(plan.queries.every(q => /Singapore|SG/i.test(q.query))).toBe(true);
    expect(plan.queries.some(q => /sales|business development|SDR/i.test(q.query))).toBe(true);
    expect(plan.filterLater).toContain('industry');
  });

  it('builds expansion, funding, and active ads plans against the correct source surfaces', () => {
    const expansion = signalPlanner.buildSignalPlan({ tenant: tenantContext, signalId: 'expansion_markets', geo: ['MY'] });
    const capital = signalPlanner.buildSignalPlan({ tenant: tenantContext, signalId: 'fresh_capital', geo: ['MY'] });
    const ads = signalPlanner.buildSignalPlan({ tenant: tenantContext, signalId: 'active_ads', geo: ['MY'] });

    expect(expansion.queries.some(q => /expanding|new office|launched/i.test(q.query))).toBe(true);
    expect(expansion.sourceChannels).toContain('company_news');
    expect(capital.queries.some(q => /funding|grant|investment|acquired/i.test(q.query))).toBe(true);
    expect(capital.sourceChannels).toContain('news');
    expect(ads.sourceChannels).toEqual(expect.arrayContaining(['meta_ad_library', 'google_ads_transparency']));
    expect(ads.queries.some(q => /facebook.com\/ads\/library|adstransparency.google.com/i.test(q.query))).toBe(true);
  });

  it('excludes Beaver competitor-offer terms and enforces query cap before paid search', () => {
    const plan = signalPlanner.buildSignalPlan({
      tenant: tenantContext,
      signalId: 'hiring_sales_roles',
      geo: ['MY', 'SG'],
      maxQueries: 2,
    });

    expect(plan.queries).toHaveLength(2);
    expect(plan.rejectRules.competitor_offers).toContain('lead generation');
    expect(plan.queries.every(q => !/lead generation|AI outbound|cold email/i.test(q.query))).toBe(true);
  });

  it('rejects same-day repeated zero-output query sets', () => {
    const plan = signalPlanner.buildSignalPlan({
      tenant: tenantContext,
      signalId: 'hiring_sales_roles',
      geo: ['MY'],
    });
    const hash = signalPlanner.querySetHash(plan.queries);

    expect(() => signalPlanner.assertNotRepeatedZeroQuerySet({
      querySetHash: hash,
      previousZeroQuerySetHashes: [hash],
    })).toThrow(/repeated_zero_output_query_set/);
  });
});
