'use strict';

/**
 * Query Generator — V1 Search Upgrade
 *
 * Generates diverse search queries using role synonym rotation and region expansion.
 * Produces 2 Serper queries + 2 CSE queries per call.
 * Each query uses ONE location (country OR city), never stacked.
 */

const ROLE_SYNONYMS = {
  'founder':           ['Founder', 'Co-Founder', 'CEO', 'Managing Director'],
  'co-founder':        ['Co-Founder', 'Founder', 'CEO'],
  'ceo':               ['CEO', 'Founder', 'Managing Director'],
  'director':          ['Director', 'VP', 'Head of'],
  'managing director': ['Managing Director', 'MD', 'CEO', 'Founder'],
  'md':                ['MD', 'Managing Director', 'CEO'],
  'marketing manager': ['Marketing Manager', 'Head of Marketing', 'Marketing Lead', 'CMO'],
  'head of marketing': ['Head of Marketing', 'Marketing Manager', 'CMO'],
  'cmo':               ['CMO', 'Head of Marketing', 'Marketing Director'],
  'sales manager':     ['Sales Manager', 'Head of Sales', 'VP Sales', 'Sales Director'],
  'head of sales':     ['Head of Sales', 'Sales Manager', 'VP Sales'],
  'cto':               ['CTO', 'Head of Engineering', 'VP Engineering', 'Tech Lead'],
  'owner':             ['Owner', 'Founder', 'CEO', 'Managing Director'],
  'partner':           ['Partner', 'Director', 'Principal'],
  'head of':           ['Head of', 'Director', 'VP'],
  'vp':                ['VP', 'Director', 'Head of'],
  'president':         ['President', 'CEO', 'MD'],
};

const REGION_MAP = {
  'Malaysia':     ['Malaysia', 'Kuala Lumpur'],
  'KL':           ['Kuala Lumpur', 'Malaysia'],
  'Kuala Lumpur': ['Kuala Lumpur', 'Malaysia'],
  'Selangor':     ['Selangor', 'Malaysia'],
  'PJ':           ['Petaling Jaya', 'Selangor'],
  'Penang':       ['Penang', 'Malaysia'],
  'Johor':        ['Johor Bahru', 'Malaysia'],
  'Singapore':    ['Singapore', 'Singapore'],
  'Indonesia':    ['Jakarta', 'Indonesia'],
  'Jakarta':      ['Jakarta', 'Indonesia'],
  'Thailand':     ['Bangkok', 'Thailand'],
  'Bangkok':      ['Bangkok', 'Thailand'],
  'Philippines':  ['Manila', 'Philippines'],
  'Manila':       ['Manila', 'Philippines'],
  'Vietnam':      ['Ho Chi Minh City', 'Vietnam'],
  'HCMC':         ['Ho Chi Minh City', 'Vietnam'],
  'Hanoi':        ['Hanoi', 'Vietnam'],
};

// Roles to check in command (longest match first to avoid partial hits)
const ROLE_KEYWORDS = [
  'managing director', 'head of marketing', 'head of sales', 'head of engineering',
  'co-founder', 'marketing manager', 'sales manager',
  'founder', 'director', 'owner', 'partner', 'president',
  'ceo', 'cmo', 'cto', 'coo', 'vp', 'md',
];

// Location keywords to check in command
const LOCATION_KEYWORDS = Object.keys(REGION_MAP);

/**
 * Parse role from a natural-language command string.
 * Returns canonical role key or null.
 */
function parseRole(lower) {
  for (const kw of ROLE_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

/**
 * Parse location from command. Returns region key or null.
 */
function parseLocation(lower) {
  // Sort by length desc so "Kuala Lumpur" matches before "Malaysia"
  const sorted = LOCATION_KEYWORDS.slice().sort((a, b) => b.length - a.length);
  for (const kw of sorted) {
    if (lower.includes(kw.toLowerCase())) return kw;
  }
  return null;
}

/**
 * Parse industry from command. Returns a string or null.
 */
function parseIndustry(lower) {
  const INDUSTRY_MAP = {
    'b2b':          null,   // not a useful LinkedIn search term
    'saas':         'SaaS',
    'software':     'software',
    'fintech':      'fintech',
    'proptech':     'proptech',
    'property':     'property',
    'marketing':    'marketing',
    'agency':       'agency',
    'digital':      'digital marketing',
    'advertising':  'advertising',
    'consulting':   'consulting',
    'ecommerce':    'e-commerce',
    'e-commerce':   'e-commerce',
    'recruitment':  'recruitment',
    'logistics':    'logistics',
    'insurance':    'insurance',
    'edtech':       'edtech',
    'healthtech':   'healthtech',
    'tech':         'technology',
    'media':        'media',
    'design':       'design',
    'hr':           'HR',
    'legal':        'legal',
    'accounting':   'accounting',
    'f&b':          'F&B',
    'food':         'food',
    'retail':       'retail',
    'training':     'training',
  };

  for (const [kw, label] of Object.entries(INDUSTRY_MAP)) {
    if (lower.includes(kw)) {
      return label; // null means skip (e.g. 'b2b' alone)
    }
  }
  return null;
}

/**
 * generateQueries(command, icp)
 *
 * Parses role, industry, location from the command. Falls back to icp fields.
 * Returns:
 *   serperQueries: string[]  — 2 queries (role synonym rotation, 1 location each)
 *   cseQueries:    string[]  — same but prefixed with "site:linkedin.com/in"
 */
function generateQueries(command, icp = {}) {
  const lower = (command || '').toLowerCase();

  // ── 1. Role ──────────────────────────────────────────────────────────────────
  const roleKey = parseRole(lower);
  const synonyms = roleKey
    ? ROLE_SYNONYMS[roleKey] || [roleKey]
    : (icp.job_titles
        ? (Array.isArray(icp.job_titles) ? icp.job_titles : icp.job_titles.split(',').map(s => s.trim()))
        : ['Founder', 'CEO']);

  const synonym1 = synonyms[0] || 'Founder';
  const synonym2 = synonyms[1] || synonyms[0] || 'CEO';

  // ── 2. Industry ──────────────────────────────────────────────────────────────
  const parsedIndustry = parseIndustry(lower);
  const industry = parsedIndustry
    || (icp.industries
        ? (Array.isArray(icp.industries) ? icp.industries[0] : String(icp.industries).split(',')[0].trim())
        : 'consulting');

  // ── 3. Location ──────────────────────────────────────────────────────────────
  const locationKey = parseLocation(lower);
  let locations;
  if (locationKey && REGION_MAP[locationKey]) {
    locations = REGION_MAP[locationKey];
  } else if (icp.geographies) {
    const geo = String(icp.geographies).trim();
    locations = REGION_MAP[geo] || [geo, geo];
  } else {
    // Default: Malaysia
    locations = REGION_MAP['Malaysia'];
  }

  const country = locations[0] || 'Malaysia';
  const city    = locations[1] || locations[0] || 'Malaysia';

  // ── 4. Build queries ─────────────────────────────────────────────────────────
  // Query 1: synonym1 + country
  // Query 2: synonym2 + city
  // NOT stacked — only one location term per query
  const base1 = `${synonym1} ${industry} ${country}`;
  const base2 = `${synonym2} ${industry} ${city}`;

  console.log(`[query-gen] role="${roleKey || 'default'}" industry="${industry}" country="${country}" city="${city}"`);
  console.log(`[query-gen] Q1: ${base1}`);
  console.log(`[query-gen] Q2: ${base2}`);

  return {
    serperQueries: [base1, base2],
    cseQueries: [
      `site:linkedin.com/in ${base1}`,
      `site:linkedin.com/in ${base2}`,
    ],
  };
}

module.exports = { generateQueries, ROLE_SYNONYMS, REGION_MAP };
