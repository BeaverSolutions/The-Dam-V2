'use strict';

/**
 * Lead quality gate — rejects placeholder/freelance/generic-company leads
 * before they pollute the leads DB.
 *
 * Called from every external sourcing path:
 *   - services/dbBuilder.js  (continuous sourcing)
 *   - services/agents.js     (kickoff-time research)
 *   - services/signalHunt.js (signal-driven adds)
 *
 * NOT called from:
 *   - routes/import.js  (CSV upload — user explicitly chose)
 *   - db/seed.js        (controlled seed data)
 *
 * Background: enrichment run on 2026-04-25 found ~16% of sourced leads
 * had no resolvable corporate domain (placeholder company names like
 * "Agency KL", "Penang Agency", "Independent Consultant", or
 * lead.name === lead.company freelance setups). Those leads burn
 * Brave/Apollo enrichment budget for zero outreach value. This gate
 * stops them at the door.
 */

// Exact-match placeholder company names (case-insensitive).
const EXACT_PLACEHOLDERS = new Set([
  'independent',
  'independent consultant',
  'self-employed',
  'self employed',
  'startup',
  'stealth',
  'stealth mode',
  'stealth startup',
  'confidential',
  'n/a',
  'na',
  'tbd',
  'tba',
  'various',
  'multiple',
  'unknown company',
  'unknown',
  'private',
  'company',
  'agency',                    // bare "Agency" with no qualifier
  'enterprise technology',
  'ks global',
  // Geographic placeholder patterns (city + firm/agency)
  'kuala lumpur firm',
  'agency kl',
  'penang agency',
  'agency penang',
  'agency subang',
  'agency klang',
  'agency jb',
  'jb agency',
  'klang agency',
  'kl firm',
  'malaysia firm',
  'sg agency',
  'singapore firm',
  // AI-fabricated category names (no real company has this name)
  'ai startup',
  'ai tech startup',
  'ai/cloud startup',
  'ai research',
  'ai group enterprise',
  'b2b sales',
  'b2b technology marketing',
  'b2b saas consultancy',
  'b2b consultants',
  'b2b consulting',
  'b2b management consultants',
]);

// Prefix patterns — company name starts with these.
const PREFIX_PATTERNS = [
  /^freelance\b/i,
  /^freelancer\b/i,
  /^stealth\s+/i,
  /^various\b/i,
  /^multiple\b/i,
  /^agency\s+\w+$/i,           // "Agency Penang", "Agency Subang"
];

// Suffix patterns — company name ends with these (catches "X Agency" style placeholders).
// Note: real agencies have specific names like "Kingdom Digital" or "LOCUS-T", not just "X Agency".
const SUFFIX_PATTERNS = [
  /\s+agency$/i,           // "Penang Agency", "KL Agency", "Marketing Agency"
  /\s+marketing agency$/i,
];

/**
 * Returns { ok: boolean, reason?: string } for a lead.
 *
 * @param {object} lead — must include at least { name, company }
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function evaluateLeadQuality(lead) {
  if (!lead || typeof lead !== 'object') {
    return { ok: false, reason: 'lead_not_object' };
  }

  const company = (lead.company || '').trim();
  const name = (lead.name || '').trim();

  // Empty/null company — only allowed if there's a strong individual signal.
  // For automated sourcing we require a company. Manual import can override
  // by not calling this gate.
  if (!company) {
    return { ok: false, reason: 'no_company' };
  }

  const companyLower = company.toLowerCase();

  if (EXACT_PLACEHOLDERS.has(companyLower)) {
    return { ok: false, reason: 'placeholder_company' };
  }

  for (const re of PREFIX_PATTERNS) {
    if (re.test(company)) {
      return { ok: false, reason: 'placeholder_prefix' };
    }
  }

  // Slash-separated company strings ("Avion School / Independent",
  // "Apom / Lucideas") indicate the source couldn't pin down a single firm.
  if (company.includes('/')) {
    const parts = company.split('/').map(p => p.trim().toLowerCase());
    if (parts.some(p => EXACT_PLACEHOLDERS.has(p))) {
      return { ok: false, reason: 'slash_with_placeholder' };
    }
  }

  for (const re of SUFFIX_PATTERNS) {
    if (re.test(company)) {
      // Carve-out: well-known multi-word agency brands that legitimately end in "Agency".
      // Add to this set as we discover them.
      const KNOWN_AGENCY_BRANDS = new Set([
        // None for now — placeholder for future allowlist.
      ]);
      if (!KNOWN_AGENCY_BRANDS.has(companyLower)) {
        return { ok: false, reason: 'placeholder_suffix' };
      }
    }
  }

  // Founder = company (freelancer pattern, e.g. "John Smith" at "John Smith Consulting").
  if (name && name.toLowerCase() === companyLower) {
    return { ok: false, reason: 'name_equals_company' };
  }

  return { ok: true };
}

/**
 * Convenience boolean wrapper.
 */
function isLowQualityLead(lead) {
  return !evaluateLeadQuality(lead).ok;
}

module.exports = {
  evaluateLeadQuality,
  isLowQualityLead,
};
