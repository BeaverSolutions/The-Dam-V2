'use strict';

const crypto = require('crypto');

const BRAVE_LIMITS = Object.freeze({ maxChars: 400, maxWords: 50 });

const PLATFORM_DEFINITIONS = Object.freeze([
  {
    id: 'jobstreet_my',
    label: 'JobStreet MY',
    provider: 'brave',
    source_channel: 'job_boards',
    supportedGeos: ['MY'],
    signalFamilies: ['hiring_capability_build'],
    priority: 10,
    queryLimits: BRAVE_LIMITS,
    parser: 'hiring_job_board',
    evidenceRequired: ['company', 'role', 'source_url'],
    knownFailureModes: ['job_board_directory', 'salary_page', 'no_company_in_result'],
  },
  {
    id: 'hiredly_my',
    label: 'Hiredly MY',
    provider: 'brave',
    source_channel: 'job_boards',
    supportedGeos: ['MY'],
    signalFamilies: ['hiring_capability_build'],
    priority: 20,
    queryLimits: BRAVE_LIMITS,
    parser: 'hiring_job_board',
    evidenceRequired: ['company', 'role', 'source_url'],
    knownFailureModes: ['job_board_directory', 'no_company_in_result'],
  },
  {
    id: 'linkedin_jobs',
    label: 'LinkedIn Jobs',
    provider: 'brave',
    source_channel: 'linkedin_jobs',
    supportedGeos: ['MY', 'SG', 'US', 'AU', 'UK'],
    signalFamilies: ['hiring_capability_build'],
    priority: 30,
    queryLimits: BRAVE_LIMITS,
    parser: 'linkedin_job_detail',
    evidenceRequired: ['company', 'role', 'source_url'],
    knownFailureModes: ['directory_page', 'location_page', 'job_board_no_company'],
  },
  {
    id: 'company_careers',
    label: 'Company Careers',
    provider: 'brave',
    source_channel: 'company_careers',
    supportedGeos: ['MY', 'SG', 'US', 'AU', 'UK'],
    signalFamilies: ['hiring_capability_build'],
    priority: 40,
    queryLimits: BRAVE_LIMITS,
    parser: 'company_careers',
    evidenceRequired: ['company', 'role', 'source_url'],
    knownFailureModes: ['company_unknown_before_search'],
  },
  {
    id: 'press_news',
    label: 'Press / News',
    provider: 'brave',
    source_channel: 'press',
    supportedGeos: ['MY', 'SG', 'US', 'AU', 'UK'],
    signalFamilies: [
      'hiring_capability_build',
      'expansion_growth',
      'leadership_org_change',
      'capital_budget_event',
    ],
    priority: 80,
    queryLimits: BRAVE_LIMITS,
    parser: 'market_sensor',
    evidenceRequired: ['company', 'event', 'source_url'],
    knownFailureModes: ['directory_page', 'stale_news', 'publisher_as_company'],
  },
  {
    id: 'public_web',
    label: 'Public Web',
    provider: 'brave',
    source_channel: 'web_search',
    supportedGeos: ['MY', 'SG', 'US', 'AU', 'UK'],
    signalFamilies: ['category_vendor_research', 'active_gtm_spend', 'pain_friction_evidence'],
    priority: 90,
    queryLimits: BRAVE_LIMITS,
    parser: 'research_beaver',
    evidenceRequired: ['company', 'signal_summary', 'source_url'],
    knownFailureModes: ['generic_directory', 'thin_evidence'],
  },
]);

function wordCount(query) {
  return String(query || '').trim().split(/\s+/).filter(Boolean).length;
}

function hashQuery(query) {
  return crypto.createHash('sha256').update(String(query || '')).digest('hex').slice(0, 16);
}

function platformById(id) {
  return PLATFORM_DEFINITIONS.find(platform => platform.id === id) || null;
}

function platformsFor({ signalFamily, geo } = {}) {
  const geoCode = String(geo || '').trim().toUpperCase();
  return PLATFORM_DEFINITIONS
    .filter(platform => !signalFamily || platform.signalFamilies.includes(signalFamily))
    .filter(platform => !geoCode || platform.supportedGeos.includes(geoCode))
    .sort((a, b) => a.priority - b.priority);
}

function validateQuery(query, provider = 'brave') {
  const text = String(query || '');
  const chars = text.length;
  const words = wordCount(text);
  const limits = provider === 'brave' ? BRAVE_LIMITS : null;

  if (limits && (chars > limits.maxChars || words > limits.maxWords)) {
    return {
      valid: false,
      chars,
      words,
      query_hash: hashQuery(text),
      blocker: 'provider_query_limit_exceeded',
      limits,
    };
  }

  return {
    valid: true,
    chars,
    words,
    query_hash: hashQuery(text),
    blocker: null,
    limits,
  };
}

module.exports = {
  BRAVE_LIMITS,
  PLATFORM_DEFINITIONS,
  platformById,
  platformsFor,
  validateQuery,
  hashQuery,
  wordCount,
};
