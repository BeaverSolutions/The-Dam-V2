import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let signalPlanner = null;
let research = null;
try {
  signalPlanner = require('../../services/signalPlanner.js');
  research = require('../../services/research.js');
} catch (err) {
  signalPlanner = null;
  research = null;
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
  it('does not reintroduce agency as a Beaver fallback/default target', () => {
    const tenantConfigSource = readFileSync(resolve(__dirname, '../../services/tenantConfig.js'), 'utf-8');
    const signalHuntSource = readFileSync(resolve(__dirname, '../../services/signalHunt.js'), 'utf-8');
    const agentsConfigSource = readFileSync(resolve(__dirname, '../../config/agents.js'), 'utf-8');
    const researchSource = readFileSync(resolve(__dirname, '../../services/research.js'), 'utf-8');
    const marketSensingSource = readFileSync(resolve(__dirname, '../../services/marketSensing.js'), 'utf-8');
    const researchEnrichmentSource = readFileSync(resolve(__dirname, '../../services/researchEnrichment.js'), 'utf-8');

    expect(tenantConfigSource).not.toContain("verticals: ['digital_marketing', 'digital_agency', 'marketing_services', 'advertising']");
    expect(signalHuntSource).not.toContain("['B2B corporate training', 'digital agency']");
    expect(agentsConfigSource).not.toContain('B2B agencies, consultancies');
    expect(agentsConfigSource).not.toContain('Boutique / independent / specialist marketing or digital agencies');
    expect(agentsConfigSource).not.toContain('Lead generation agencies');
    expect(agentsConfigSource).not.toContain('Recruitment agencies / talent acquisition firms');
    expect(agentsConfigSource).not.toContain('agency_expansion');
    expect(agentsConfigSource).not.toContain('boutique_agency');
    expect(agentsConfigSource).toContain('Agencies are not a default priority');
    expect(marketSensingSource).not.toContain('agency_expansion');
    expect(marketSensingSource).not.toContain('boutique_agency');
    expect(marketSensingSource).not.toContain('Agency-vertical');
    expect(marketSensingSource).not.toContain('"new agency"');
    expect(researchEnrichmentSource).not.toContain('agency_expansion');
    expect(researchSource).not.toContain("'consulting', 'agency', 'SaaS', 'training'");
    expect(researchSource).not.toContain("widened.industries = 'consulting, agency");
    expect(researchSource).not.toContain('Malaysia CEO agency "scaling"');
    expect(researchSource).not.toContain('Singapore CEO agency "scaling"');
    expect(researchSource).toContain("'corporate training', 'professional services'");
  });

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
    const linkedInJobsQuery = plan.queries.find(q => q.sourceChannel === 'linkedin_jobs')?.query || '';
    expect(linkedInJobsQuery).toMatch(/Kuala Lumpur|Greater Kuala Lumpur|Malaysia/i);
    expect(linkedInJobsQuery).toMatch(/Sales Executive|Account Executive|Business Development Manager|Sales Manager/i);
    expect(linkedInJobsQuery).not.toMatch(/B2B agency/i);
    expect(linkedInJobsQuery).toMatch(/-India -Delhi -NCR -Jaipur -Siliguri/i);
    expect(plan.queries[0].expectedEvidence).toEqual(['company', 'role', 'source_url']);
  });

  it('diversifies small paid query windows across ICP verticals and source channels', () => {
    const verticals = [
      'B2B corporate training',
      'professional training',
      'L&D providers',
      'digital agencies',
      'PR firms',
      'creative studios',
    ];
    const plan = signalPlanner.buildSignalPlan({
      tenant: {
        ...tenantContext,
        icp: {
          ...tenantContext.icp,
          verticals,
          geo: ['MY'],
        },
      },
      signalId: 'hiring_sales_roles',
      geo: ['MY'],
      maxQueries: 5,
    });

    const queryText = plan.queries.map(q => q.query).join('\n');
    const coveredVerticals = verticals.filter(vertical => queryText.includes(`"${vertical}"`));
    const coveredChannels = new Set(plan.queries.map(q => q.sourceChannel));

    expect(plan.queries).toHaveLength(5);
    expect(plan.queries[0]).toMatchObject({ industry: 'B2B corporate training', geo: 'MY', term: 'sales' });
    expect(coveredVerticals.length).toBeGreaterThanOrEqual(3);
    expect(coveredChannels.size).toBeGreaterThanOrEqual(2);
    expect(plan.queries.every(q => /Malaysia|MY/i.test(q.query))).toBe(true);
    expect(queryText).not.toContain('site:*');
  });

  it('preserves planner vertical metadata when Research builds the signal query pool', () => {
    expect(research).toBeTruthy();
    const verticals = [
      'B2B corporate training',
      'professional training',
      'L&D providers',
      'digital agencies',
      'PR firms',
    ];
    const pool = research.buildQueryPool({
      industries: verticals.join(', '),
      job_titles: 'Founder, CEO, Managing Director',
      geographies: 'MY',
      buying_signals: [{
        ...tenantContext.buying_signals[0],
        stop_rules: { ...tenantContext.buying_signals[0].stop_rules, max_paid_searches_per_day: 5 },
      }],
    });
    const firstFive = pool.slice(0, 5);

    expect(firstFive.map(q => q.industry)).toEqual(verticals);
    expect(firstFive.some(q => q.industry === 'hiring_capability_build')).toBe(false);
    expect(new Set(firstFive.map(q => q.source_channel)).size).toBeGreaterThanOrEqual(2);
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

  it('builds remaining universal signal families with source-specific evidence terms', () => {
    const tenant = {
      ...tenantContext,
      buying_signals: [
        ...tenantContext.buying_signals,
        {
          id: 'vendor_research',
          family: 'category_vendor_research',
          enabled: true,
          priority: 5,
          source_channels: ['review_sites', 'web_search'],
          query_terms: ['sales automation'],
          evidence_required: ['company', 'intent_topic', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'stack_change',
          family: 'technology_stack_change',
          enabled: true,
          priority: 6,
          source_channels: ['job_descriptions', 'company_careers', 'website_integrations'],
          query_terms: ['CRM'],
          evidence_required: ['company', 'tool', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'leadership_change',
          family: 'leadership_org_change',
          enabled: true,
          priority: 7,
          source_channels: ['public_posts', 'company_news', 'press'],
          query_terms: ['new CEO'],
          evidence_required: ['company', 'person', 'role', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'regulatory_pressure',
          family: 'regulatory_deadline_pressure',
          enabled: true,
          priority: 8,
          source_channels: ['government_pages', 'industry_bodies'],
          query_terms: ['compliance'],
          evidence_required: ['deadline', 'industry', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'pain_signal',
          family: 'pain_friction_evidence',
          enabled: true,
          priority: 9,
          source_channels: ['social_posts', 'reviews', 'founder_posts'],
          query_terms: ['manual process'],
          evidence_required: ['company', 'pain', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
        {
          id: 'event_presence',
          family: 'event_market_presence',
          enabled: true,
          priority: 10,
          source_channels: ['event_pages', 'sponsor_lists', 'webinars'],
          query_terms: ['sponsor'],
          evidence_required: ['company', 'event', 'source_url'],
          stop_rules: { max_paid_searches_per_day: 2 },
        },
      ],
    };

    const vendor = signalPlanner.buildSignalPlan({ tenant, signalId: 'vendor_research', geo: ['MY'] });
    const stack = signalPlanner.buildSignalPlan({ tenant, signalId: 'stack_change', geo: ['MY'] });
    const leadership = signalPlanner.buildSignalPlan({ tenant, signalId: 'leadership_change', geo: ['MY'] });
    const regulatory = signalPlanner.buildSignalPlan({ tenant, signalId: 'regulatory_pressure', geo: ['MY'] });
    const pain = signalPlanner.buildSignalPlan({ tenant, signalId: 'pain_signal', geo: ['MY'] });
    const event = signalPlanner.buildSignalPlan({ tenant, signalId: 'event_presence', geo: ['MY'] });

    expect(vendor.queries.some(q => /review|compare|alternative|buyer intent/i.test(q.query))).toBe(true);
    expect(stack.queries.some(q => /job description|requirements|responsibilities|implementation|migration|integration/i.test(q.query))).toBe(true);
    expect(leadership.queries.some(q => /linkedin\.com\/posts|appointed|joined|new CEO|head of sales/i.test(q.query))).toBe(true);
    expect(regulatory.queries.some(q => /gov|deadline|compliance|permit|audit|regulation/i.test(q.query))).toBe(true);
    expect(pain.queries.some(q => /linkedin\.com\/posts|review|struggling|bottleneck|manual process|hard to scale/i.test(q.query))).toBe(true);
    expect(event.queries.some(q => /event|sponsor|exhibitor|speaker|webinar|conference/i.test(q.query))).toBe(true);
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
