'use strict';

const crypto = require('crypto');
const {
  normalizeBuyingSignalsForTenant,
} = require('../config/buyingSignals');

function list(value) {
  return Array.isArray(value) ? value.map(v => String(v).trim()).filter(Boolean) : [];
}

function countryName(value) {
  const s = String(value || '').trim().toUpperCase();
  if (s === 'MY' || /malaysia/i.test(value)) return 'Malaysia';
  if (s === 'SG' || /singapore/i.test(value)) return 'Singapore';
  if (s === 'US' || /united states|usa/i.test(value)) return 'United States';
  if (s === 'CA' || /canada/i.test(value)) return 'Canada';
  return String(value || '').trim();
}

function compact(parts) {
  return parts.map(v => String(v || '').trim()).filter(Boolean).join(' ');
}

function firstSourceChannel(signal, preferred) {
  const channels = list(signal.source_channels);
  if (preferred && channels.includes(preferred)) return preferred;
  return channels[0] || 'web_search';
}

function sourceChannelsForPlan(signal, preferred) {
  const channels = list(signal.source_channels);
  if (preferred && channels.includes(preferred)) return [preferred];
  return channels.length > 0 ? channels : ['web_search'];
}

function serviceBusinessHiringSignal(signal = {}, industry = '') {
  const family = String(signal.family || '').toLowerCase();
  const id = String(signal.id || '').toLowerCase();
  const terms = [
    industry,
    id,
    ...list(signal.query_terms),
  ].join(' ');
  return (family === 'hiring_capability_build' || /hiring|job|sales_ops/.test(id))
    && /roof|roofing|roofer|contractor|plumbing|hvac|landscap|remodel|construction/i.test(terms);
}

function sourceChannelsForSignalPlan(signal, preferred, industry) {
  const channels = sourceChannelsForPlan(signal, preferred);
  if (!serviceBusinessHiringSignal(signal, industry)) return channels;
  return ['job_boards', ...channels.filter(channel => channel !== 'job_boards')];
}

function queryPrefixForSource(sourceChannel) {
  if (sourceChannel === 'linkedin_jobs') return 'site:linkedin.com/jobs/view';
  if (sourceChannel === 'company_careers') return '("careers" OR "jobs" OR "join our team")';
  if (sourceChannel === 'meta_ad_library') return 'site:facebook.com/ads/library';
  if (sourceChannel === 'google_ads_transparency') return 'site:adstransparency.google.com';
  if (sourceChannel === 'job_descriptions') return '("job description" OR requirements OR responsibilities)';
  if (sourceChannel === 'website_integrations') return '("integrations" OR "powered by" OR "uses")';
  if (sourceChannel === 'docs') return '(docs OR documentation)';
  if (sourceChannel === 'public_posts' || sourceChannel === 'founder_posts' || sourceChannel === 'social_posts') return '(site:linkedin.com/posts OR site:linkedin.com/feed/update)';
  if (sourceChannel === 'government_pages') return '(site:gov.my OR site:gov.sg OR site:gov)';
  if (sourceChannel === 'industry_bodies') return '("association" OR "council" OR "industry body")';
  if (sourceChannel === 'reviews' || sourceChannel === 'review_sites') return '(review OR compare OR alternative)';
  if (sourceChannel === 'event_pages' || sourceChannel === 'sponsor_lists' || sourceChannel === 'webinars' || sourceChannel === 'conference_sites') return '(event OR sponsor OR exhibitor OR speaker OR webinar OR conference)';
  return '';
}

function hiringLocationQuery(geoName) {
  if (/malaysia/i.test(geoName)) return '("Kuala Lumpur" OR "Greater Kuala Lumpur" OR "Malaysia")';
  if (/singapore/i.test(geoName)) return '("Singapore")';
  return `"${geoName}"`;
}

function hiringRoleQuery(term) {
  const cleanTerm = String(term || '').trim() || 'sales';
  if (/roof|roofing|roofer/i.test(cleanTerm)) {
    return '("roofing sales representative" OR "roofing project manager" OR "roofing estimator" OR "roofing sales manager")';
  }
  return `("${cleanTerm}" OR "Sales Executive" OR "Account Executive" OR "Business Development Manager" OR "Sales Manager")`;
}

function localJobBoardPrefix(geoName) {
  const domains = localJobBoardDomains(geoName);
  return domains.length > 0 ? `(${domains.join(' OR ')})` : '';
}

function localJobBoardDomains(geoName) {
  if (/malaysia/i.test(geoName)) return ['site:my.jobstreet.com', 'site:jobstreet.com.my', 'site:hiredly.com'];
  if (/united states|usa/i.test(geoName)) return ['site:indeed.com'];
  if (/canada/i.test(geoName)) return ['site:ca.indeed.com'];
  return [];
}

function hiringSourcePrefix(sourceChannel, geoName) {
  if (sourceChannel === 'linkedin_jobs') return 'site:linkedin.com/jobs/view';
  if (sourceChannel === 'job_boards') return localJobBoardPrefix(geoName);
  return queryPrefixForSource(sourceChannel);
}

function industryDiscoveryHint(industry) {
  const s = String(industry || '').toLowerCase();
  if (!s) return '';
  if (/\b(training|learning|l&d|coaching|skills development)\b/i.test(s)) {
    return '("corporate training" OR "leadership training" OR "sales training" OR "learning and development" OR "L&D" OR "executive coaching")';
  }
  if (/\b(agency|marketing|creative|digital|pr|communications|advertising|media|content studio)\b/i.test(s)) {
    return '(marketing OR creative OR digital OR PR OR communications OR advertising OR "content studio") (agency OR firm OR studio)';
  }
  return '';
}

function quotedTerm(term) {
  const cleanTerm = String(term || '').replace(/"/g, '').trim();
  return cleanTerm ? `"${cleanTerm}"` : '';
}

function evidenceQueryForFamily(family) {
  if (family === 'capital_budget_event') return '(funding OR grant OR investment OR acquired)';
  if (family === 'expansion_growth') return '(expanding OR launched OR "new office" OR growth)';
  if (family === 'hiring_capability_build') return '(hiring OR vacancy OR careers)';
  if (family === 'category_vendor_research') return '(review OR compare OR alternative OR "buyer intent")';
  if (family === 'technology_stack_change') return '(implementation OR migration OR integration OR RevOps OR CRM)';
  if (family === 'leadership_org_change') return '(appointed OR joined OR "new CEO" OR "new CRO" OR "head of sales")';
  if (family === 'regulatory_deadline_pressure') return '(deadline OR compliance OR permit OR audit OR regulation)';
  if (family === 'pain_friction_evidence') return '("struggling with" OR bottleneck OR "manual process" OR delayed OR "hard to scale")';
  if (family === 'event_market_presence') return '(sponsor OR exhibitor OR speaker OR webinar OR conference)';
  if (family === 'active_gtm_spend') return '(demo OR "book a call" OR consultation OR "case study")';
  return '';
}

function buildQueryForSignal({ signal, term, geo, industry, sourceChannel }) {
  const geoName = countryName(geo);
  const sourcePrefix = queryPrefixForSource(sourceChannel);
  const industryHint = industryDiscoveryHint(industry);
  const family = signal.family;

  if (family === 'hiring_capability_build' && sourceChannel === 'linkedin_jobs') {
    return compact([
      hiringSourcePrefix(sourceChannel, geoName),
      industryHint,
      hiringLocationQuery(geoName),
      hiringRoleQuery(term),
      '-India -Delhi -NCR -Jaipur -Siliguri',
    ]);
  }

  if (family === 'hiring_capability_build' && sourceChannel === 'job_boards') {
    return compact([
      hiringSourcePrefix(sourceChannel, geoName),
      industryHint,
      hiringLocationQuery(geoName),
      hiringRoleQuery(term),
      /malaysia/i.test(geoName) ? '-India -Delhi -NCR -Jaipur -Siliguri' : '',
    ]);
  }

  return compact([
    sourcePrefix,
    hiringLocationQuery(geoName),
    industryHint,
    quotedTerm(term),
    evidenceQueryForFamily(family),
  ]);
}

function stripCompetitorTerms(query, competitorOffers = []) {
  let result = String(query || '');
  for (const term of competitorOffers) {
    const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`"?${escaped}"?`, 'ig'), '').replace(/\s{2,}/g, ' ').trim();
  }
  return result;
}

function buildSignalPlan({
  tenant,
  signalId,
  geo,
  sourceChannel,
  maxQueries,
} = {}) {
  if (!tenant) throw new Error('buildSignalPlan requires tenant');
  const signals = normalizeBuyingSignalsForTenant(tenant);
  const signal = signalId
    ? signals.find(item => item.id === signalId)
    : signals.find(item => item.enabled !== false);
  if (!signal) throw new Error(`signal_not_found:${signalId || 'default'}`);

  const icp = tenant.icp || {};
  const geos = list(geo).length > 0 ? list(geo) : list(icp.geo);
  const finalGeos = geos.length > 0 ? geos : ['MY'];
  const industries = list(icp.active_industries);
  const finalIndustries = industries.length > 0 ? industries : [null];
  const terms = list(signal.query_terms).length > 0 ? list(signal.query_terms) : [signal.family];
  const selectedSource = firstSourceChannel(signal, sourceChannel);
  const sourceChannels = sourceChannelsForSignalPlan(signal, sourceChannel, finalIndustries[0]);
  const stopRules = signal.stop_rules || {};
  const cap = Math.max(1, Number(maxQueries || stopRules.max_paid_searches_per_day || 6));
  const competitorOffers = list(signal.reject_rules?.competitor_offers || icp.competitor_offers);
  const queries = [];
  const seenQueries = new Set();

  const totalCombinations = finalIndustries.length * finalGeos.length * terms.length * sourceChannels.length;
  for (let i = 0; queries.length < cap && i < totalCombinations; i++) {
    const industry = finalIndustries[i % finalIndustries.length];
    const geoValue = finalGeos[Math.floor(i / finalIndustries.length) % finalGeos.length];
    const term = terms[i % terms.length];
    const querySourceChannel = sourceChannels[i % sourceChannels.length] || selectedSource;
    const rawQuery = buildQueryForSignal({
      signal,
      term,
      geo: geoValue,
      industry,
      sourceChannel: querySourceChannel,
    });
    const query = stripCompetitorTerms(rawQuery, competitorOffers);
    const key = query.toLowerCase();
    if (seenQueries.has(key)) continue;
    seenQueries.add(key);
    queries.push({
      sourceChannel: querySourceChannel,
      query,
      costClass: 'paid_search',
      expectedEvidence: list(signal.evidence_required),
      industry,
      geo: geoValue,
      term,
    });
  }

  return {
    signalId: signal.id,
    signalFamily: signal.family,
    sourceChannels: list(signal.source_channels),
    queries,
    stopRules,
    rejectRules: {
      ...(signal.reject_rules || {}),
      competitor_offers: competitorOffers,
    },
    filterLater: industries.length > 0 ? ['industry'] : [],
  };
}

function querySetHash(queries = []) {
  const normalized = list(queries.map(q => q.query || q)).sort().join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function assertNotRepeatedZeroQuerySet({ querySetHash: hash, previousZeroQuerySetHashes = [] } = {}) {
  if (hash && previousZeroQuerySetHashes.includes(hash)) {
    const err = new Error('repeated_zero_output_query_set');
    err.code = 'repeated_zero_output_query_set';
    throw err;
  }
  return true;
}

module.exports = {
  buildSignalPlan,
  querySetHash,
  assertNotRepeatedZeroQuerySet,
};
