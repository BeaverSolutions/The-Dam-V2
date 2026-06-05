import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let buyingSignals = null;
try {
  buyingSignals = require('../../config/buyingSignals.js');
} catch (err) {
  buyingSignals = null;
}

const {
  profileSchema,
  profileActivationSchema,
} = require('../../services/tenantProfileSchema.js');

function baseProfile(overrides = {}) {
  return {
    identity: {
      company: 'Beaver Solutions',
      founder: { name: 'MJ', role: 'Founder', linkedin_url: null },
      sender_persona: { name: 'Michael Jerry', title: 'Founder', email: 'mj@beaver.solutions' },
      brand_voice: 'direct and specific',
    },
    offer: {
      product: 'BeavrDam',
      services: ['AI outbound team'],
      pricing: { tiers: [] },
      positioning: 'Agentic outbound team for founder-led B2B companies',
    },
    icp: {
      verticals: ['B2B agencies', 'corporate training'],
      personas: ['Founder', 'CEO', 'Head of Sales'],
      geo: ['MY', 'SG'],
      exclusions: ['enterprise brands'],
      competitor_offers: ['lead generation', 'cold email', 'sales automation', 'AI outbound', 'SDR-as-a-service'],
    },
    proof: [],
    voice: {
      tone: ['plainspoken'],
      do: ['be specific'],
      dont: ['sound generic'],
      examples: {
        good: ['good one', 'good two', 'good three'],
        bad: ['bad one', 'bad two'],
      },
    },
    constraints: {
      word_cap_by_channel: { email: 90, linkedin_dm: 80, linkedin_invite: 280 },
      banned_phrases: [],
      signoff_by_channel: { email: 'Regards,\\nMichael Jerry', linkedin_dm: null, linkedin_invite: null },
      max_links: 1,
      allow_emoji: false,
    },
    documents: [],
    ...overrides,
  };
}

describe('buying signal config foundation', () => {
  it('exports all universal signal families and source channel defaults', () => {
    expect(buyingSignals).toBeTruthy();
    const families = buyingSignals.SIGNAL_FAMILIES;
    const library = buyingSignals.SIGNAL_LIBRARY;

    expect(families).toEqual([
      'hiring_capability_build',
      'expansion_growth',
      'capital_budget_event',
      'active_gtm_spend',
      'category_vendor_research',
      'technology_stack_change',
      'leadership_org_change',
      'regulatory_deadline_pressure',
      'pain_friction_evidence',
      'event_market_presence',
    ]);

    for (const family of families) {
      expect(library[family].source_channels.length).toBeGreaterThan(0);
      expect(library[family].evidence_required).toContain('company');
      expect(library[family].blockers.length).toBeGreaterThan(0);
    }
  });

  it('accepts enabled buying signals with required fields on draft save', () => {
    const parsed = profileSchema.parse(baseProfile({
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
          stop_rules: { max_paid_searches_per_day: 6, stop_if_raw_candidates_zero: true },
        },
      ],
    }));

    expect(parsed.buying_signals[0].family).toBe('hiring_capability_build');
    expect(parsed.buying_signals[0].source_channels).toContain('linkedin_jobs');
  });

  it('rejects active tenant profiles without at least one enabled signal', () => {
    const result = profileActivationSchema.safeParse(baseProfile({ buying_signals: [] }));

    expect(result.success).toBe(false);
    expect(result.error.issues.some(issue => issue.path.join('.') === 'buying_signals')).toBe(true);
  });

  it('rejects enabled signals missing required activation fields', () => {
    const result = profileActivationSchema.safeParse(baseProfile({
      buying_signals: [
        {
          id: 'bad_signal',
          family: 'hiring_capability_build',
          enabled: true,
          priority: 1,
          source_channels: [],
          query_terms: ['sales'],
          geo_lock: true,
          evidence_required: [],
          decision_maker_strategy: [],
          stop_rules: {},
        },
      ],
    }));

    expect(result.success).toBe(false);
    const paths = result.error.issues.map(issue => issue.path.join('.'));
    expect(paths).toContain('buying_signals.0.source_channels');
    expect(paths).toContain('buying_signals.0.evidence_required');
    expect(paths).toContain('buying_signals.0.stop_rules');
  });

  it('rejects unknown signal families unless added to the canonical library', () => {
    const result = profileSchema.safeParse(baseProfile({
      buying_signals: [
        {
          id: 'unknown',
          family: 'random_signal',
          enabled: true,
          priority: 1,
          source_channels: ['web_search'],
          query_terms: ['random'],
          geo_lock: false,
          evidence_required: ['company'],
          decision_maker_strategy: ['founder'],
          stop_rules: { max_paid_searches_per_day: 1 },
        },
      ],
    }));

    expect(result.success).toBe(false);
  });

  it('keeps Beaver competitor-offer exclusions in the normalized fallback signals', () => {
    const signals = buyingSignals.getDefaultBuyingSignalsForTenant({
      icp: baseProfile().icp,
    });

    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0].reject_rules.competitor_offers).toContain('lead generation');
    expect(signals[0].reject_rules.competitor_offers).toContain('AI outbound');
  });

  it('defaults legacy tenants to every universal signal family instead of hiring-only sourcing', () => {
    const signals = buyingSignals.getDefaultBuyingSignalsForTenant({
      icp: baseProfile().icp,
    });

    expect(signals.map(signal => signal.family)).toEqual(buyingSignals.SIGNAL_FAMILIES);
    expect(signals.map(signal => signal.id)).toEqual([
      'hiring_sales_roles',
      'expansion_markets',
      'fresh_capital',
      'active_ads',
      'vendor_research',
      'stack_change',
      'leadership_change',
      'regulatory_pressure',
      'pain_signal',
      'event_presence',
    ]);
    for (const signal of signals) {
      expect(signal.source_channels.length).toBeGreaterThan(0);
      expect(signal.query_terms.length).toBeGreaterThan(0);
      expect(signal.evidence_required.length).toBeGreaterThan(0);
      expect(signal.stop_rules.max_paid_searches_per_day).toBeGreaterThan(0);
      expect(signal.reject_rules.competitor_offers).toContain('lead generation');
      expect(signal.reject_rules.competitor_offers).toContain('AI outbound');
    }
  });
});
