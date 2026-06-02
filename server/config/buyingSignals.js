'use strict';

const SIGNAL_FAMILIES = [
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
];

const SOURCE_CHANNEL_CAPABILITIES = {
  linkedin_jobs: ['role', 'company', 'geo', 'source_url'],
  company_careers: ['role', 'company', 'geo', 'source_url'],
  job_boards: ['role', 'company', 'geo', 'source_url'],
  web_search: ['company', 'source_url', 'snippet'],
  company_news: ['company', 'event', 'source_url', 'date'],
  press: ['company', 'event', 'source_url', 'date'],
  company_pages: ['company', 'page_fact', 'source_url'],
  linkedin_company_posts: ['company', 'post_fact', 'source_url', 'date'],
  news: ['company', 'event', 'source_url', 'date'],
  investor_pages: ['company', 'event', 'source_url'],
  company_blog: ['company', 'event', 'source_url'],
  meta_ad_library: ['company', 'ad_url', 'offer'],
  google_ads_transparency: ['company', 'ad_url', 'offer'],
  landing_pages: ['company', 'offer', 'source_url'],
  intent_provider: ['company', 'intent_topic', 'provider', 'recency'],
  review_sites: ['company', 'category', 'source_url'],
  first_party_analytics: ['company', 'intent_topic', 'recency'],
  job_descriptions: ['company', 'tool', 'role', 'source_url'],
  website_integrations: ['company', 'tool', 'source_url'],
  docs: ['company', 'tool', 'source_url'],
  public_posts: ['person', 'role', 'company', 'source_url'],
  government_pages: ['deadline', 'industry', 'source_url'],
  industry_bodies: ['deadline', 'industry', 'source_url'],
  public_notices: ['deadline', 'company', 'source_url'],
  social_posts: ['company', 'pain', 'source_url'],
  forums: ['company', 'pain', 'source_url'],
  reviews: ['company', 'pain', 'source_url'],
  founder_posts: ['company', 'pain', 'source_url'],
  support_pages: ['company', 'pain', 'source_url'],
  event_pages: ['company', 'event', 'source_url'],
  sponsor_lists: ['company', 'event', 'source_url'],
  webinars: ['company', 'event', 'source_url'],
  conference_sites: ['company', 'event', 'source_url'],
};

const SIGNAL_LIBRARY = {
  hiring_capability_build: {
    source_channels: ['linkedin_jobs', 'company_careers', 'job_boards', 'web_search'],
    evidence_required: ['company', 'role', 'source_url'],
    query_terms: ['sales', 'business development', 'SDR', 'BDR', 'account executive'],
    blockers: ['raw_candidates_zero', 'icp_zero_after_company_extract', 'decision_maker_zero', 'contact_zero'],
  },
  expansion_growth: {
    source_channels: ['company_news', 'press', 'company_careers', 'web_search', 'linkedin_company_posts'],
    evidence_required: ['company', 'expansion_fact', 'source_url'],
    query_terms: ['expanding', 'new office', 'launched', 'growth', 'new market'],
    blockers: ['raw_candidates_zero', 'expansion_evidence_missing', 'icp_zero_after_company_extract'],
  },
  capital_budget_event: {
    source_channels: ['news', 'press', 'investor_pages', 'company_blog', 'web_search'],
    evidence_required: ['company', 'event', 'source_url'],
    query_terms: ['funding', 'grant', 'investment', 'acquired', 'major client win'],
    blockers: ['raw_candidates_zero', 'capital_event_missing', 'icp_zero_after_company_extract'],
  },
  active_gtm_spend: {
    source_channels: ['meta_ad_library', 'google_ads_transparency', 'landing_pages', 'web_search'],
    evidence_required: ['company', 'ad_url', 'offer'],
    query_terms: ['demo', 'book a call', 'free consultation', 'case study'],
    blockers: ['raw_candidates_zero', 'active_ad_missing', 'icp_zero_after_company_extract'],
  },
  category_vendor_research: {
    source_channels: ['intent_provider', 'review_sites', 'first_party_analytics', 'web_search'],
    evidence_required: ['company', 'intent_topic', 'source_url'],
    query_terms: ['reviewing', 'compare', 'alternative', 'buyer intent'],
    blockers: ['intent_source_unavailable', 'raw_candidates_zero', 'intent_topic_missing'],
  },
  technology_stack_change: {
    source_channels: ['job_descriptions', 'company_careers', 'website_integrations', 'docs', 'web_search'],
    evidence_required: ['company', 'tool', 'source_url'],
    query_terms: ['CRM', 'sales operations', 'RevOps', 'implementation', 'migration'],
    blockers: ['raw_candidates_zero', 'stack_evidence_missing', 'icp_zero_after_company_extract'],
  },
  leadership_org_change: {
    source_channels: ['public_posts', 'company_news', 'press', 'web_search'],
    evidence_required: ['company', 'person', 'role', 'source_url'],
    query_terms: ['appointed', 'joined as', 'new CEO', 'new CRO', 'head of sales'],
    blockers: ['raw_candidates_zero', 'leadership_evidence_missing', 'decision_maker_zero'],
  },
  regulatory_deadline_pressure: {
    source_channels: ['government_pages', 'industry_bodies', 'public_notices', 'web_search'],
    evidence_required: ['company', 'deadline', 'source_url'],
    query_terms: ['deadline', 'compliance', 'permit', 'audit', 'regulation'],
    blockers: ['raw_candidates_zero', 'deadline_evidence_missing', 'icp_zero_after_company_extract'],
  },
  pain_friction_evidence: {
    source_channels: ['social_posts', 'forums', 'reviews', 'founder_posts', 'support_pages', 'web_search'],
    evidence_required: ['company', 'pain', 'source_url'],
    query_terms: ['struggling with', 'manual process', 'bottleneck', 'delayed', 'hard to scale'],
    blockers: ['raw_candidates_zero', 'pain_evidence_missing', 'icp_zero_after_company_extract'],
  },
  event_market_presence: {
    source_channels: ['event_pages', 'sponsor_lists', 'webinars', 'conference_sites', 'web_search'],
    evidence_required: ['company', 'event', 'source_url'],
    query_terms: ['sponsor', 'exhibitor', 'speaker', 'webinar', 'conference'],
    blockers: ['raw_candidates_zero', 'event_evidence_missing', 'icp_zero_after_company_extract'],
  },
};

function list(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function defaultStopRules() {
  return {
    max_paid_searches_per_day: 6,
    stop_if_raw_candidates_zero: true,
    block_repeat_zero_query_set: true,
  };
}

function getDefaultBuyingSignalsForTenant(tenant = {}) {
  const icp = tenant.icp || {};
  return [
    {
      id: 'hiring_sales_roles',
      family: 'hiring_capability_build',
      enabled: true,
      priority: 1,
      source_channels: [...SIGNAL_LIBRARY.hiring_capability_build.source_channels],
      query_terms: [...SIGNAL_LIBRARY.hiring_capability_build.query_terms],
      geo_lock: true,
      evidence_required: [...SIGNAL_LIBRARY.hiring_capability_build.evidence_required],
      decision_maker_strategy: ['founder', 'ceo', 'managing_director', 'head_of_sales'],
      stop_rules: defaultStopRules(),
      reject_rules: {
        exclusions: list(icp.exclusions),
        competitor_offers: list(icp.competitor_offers),
      },
    },
  ];
}

function normalizeBuyingSignalsForTenant(tenant = {}) {
  const configured = list(tenant.buying_signals).filter(signal => signal && signal.enabled !== false);
  const signals = configured.length > 0 ? configured : getDefaultBuyingSignalsForTenant(tenant);
  const icp = tenant.icp || {};

  return signals.map((signal, idx) => {
    const familyDefaults = SIGNAL_LIBRARY[signal.family] || {};
    return {
      ...signal,
      enabled: signal.enabled !== false,
      priority: Number.isFinite(Number(signal.priority)) ? Number(signal.priority) : idx + 1,
      source_channels: list(signal.source_channels).length > 0 ? list(signal.source_channels) : list(familyDefaults.source_channels),
      query_terms: list(signal.query_terms).length > 0 ? list(signal.query_terms) : list(familyDefaults.query_terms),
      evidence_required: list(signal.evidence_required).length > 0 ? list(signal.evidence_required) : list(familyDefaults.evidence_required),
      stop_rules: {
        ...defaultStopRules(),
        ...(signal.stop_rules || {}),
      },
      reject_rules: {
        exclusions: list(icp.exclusions),
        competitor_offers: list(icp.competitor_offers),
        ...(signal.reject_rules || {}),
      },
    };
  }).sort((a, b) => a.priority - b.priority);
}

module.exports = {
  SIGNAL_FAMILIES,
  SIGNAL_LIBRARY,
  SOURCE_CHANNEL_CAPABILITIES,
  defaultStopRules,
  getDefaultBuyingSignalsForTenant,
  normalizeBuyingSignalsForTenant,
};
