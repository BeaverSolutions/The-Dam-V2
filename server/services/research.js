'use strict';

const pool = require('../db/pool');
const searchService = require('./searchService');
const hunterService = require('./hunter');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_PAID_SEARCH_QUERIES_PER_RUN = envInt('RESEARCH_MAX_PAID_QUERIES_PER_RUN', 6);

/* ─── Rotation pools ─────────────────────────────────────── */

const DEFAULT_TITLES = [
  'CEO', 'Founder', 'Co-Founder', 'Managing Director', 'Owner',
  'Director', 'MD',
];

const DEFAULT_INDUSTRIES = [
  'consulting', 'agency', 'SaaS', 'training',
  'professional services', 'recruitment', 'marketing',
  'digital marketing', 'media', 'advertising',
];

const KL_LOCATIONS = [
  'Kuala Lumpur', 'Petaling Jaya', 'Bangsar', 'Damansara',
  'Subang Jaya', 'Shah Alam', 'TTDI', 'Klang Valley',
];

const SIGNALS = [
  'hiring', 'expanding', 'growing team',
  'new clients', 'launched', 'Series A',
];

const ICP_TITLE_KEYWORDS = [
  'ceo', 'founder', 'co-founder', 'managing director', 'owner',
];

/* Titles that MUST match the full title (not substring) to pass Hunter filtering */
const ICP_TITLE_EXACT = new Set([
  'ceo', 'founder', 'co-founder', 'managing director', 'owner',
  'chief executive officer', 'director', 'md',
]);

/* Hard-reject titles — if the lead's title contains any of these, reject immediately.
   These are junior/mid-level roles that should never reach outreach.

   2026-05-22 — removed 'executive', 'officer', 'head of' because the substring
   .includes() match was killing ICP-approved titles BEFORE Haiku even ran:
     - 'executive'  matched "Chief Executive Officer"  (a real C-suite title)
     - 'officer'    matched "Chief Executive Officer", "Chief Operating Officer"
     - 'head of'    matched "Head of Sales", "Head of Growth" (both in ICP)
   Junior IC titles like "Account Executive" / "Marketing Officer" still get
   rejected — Haiku marks them role=unlikely. The pre-gate's job is to skip
   obvious junior roles cheaply, not to second-guess the ICP. */
const BANNED_TITLE_KEYWORDS = [
  'intern', 'trainee', 'junior', 'associate', 'assistant',
  'coordinator', 'specialist', 'analyst',
  'manager', 'supervisor', 'admin', 'receptionist', 'clerk',
  'engineer', 'developer', 'designer', 'writer', 'editor',
  'consultant', 'advisor', 'agent', 'representative', 'lead',
  'team lead', 'senior', 'staff',
];

/* ─── Helpers ────────────────────────────────────────────── */

/**
 * Strip human-prose annotations from an ICP token so it can be used as a
 * clean search keyword. The ICP is operator-edited and sometimes contains
 * prose like "skills development — PRIMARY. Founder-led agencies" or
 * "Sales Director (only if company size <50)". Feeding those verbatim into
 * Brave as quoted phrases returns 0 results. (2026-05-15)
 */
function cleanIcpToken(s) {
  return String(s || '')
    // drop "— PRIMARY ...", "— SECONDARY ...", "- TERTIARY ..." annotation tails
    .replace(/\s*[—–-]\s*(PRIMARY|SECONDARY|TERTIARY)\b.*$/i, '')
    // drop parentheticals e.g. "(only if company size <50)"
    .replace(/\([^)]*\)/g, '')
    .trim();
}

/**
 * Parse a comma-separated string OR an array into a trimmed array, ignoring empties.
 * Every token is run through cleanIcpToken so prose annotations never reach a query.
 */
function parseCsvField(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(v => cleanIcpToken(v)).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map(v => cleanIcpToken(v)).filter(Boolean);
}

/**
 * Normalise a lead to the standard output shape.
 */
function normaliseLead(partial) {
  return {
    name:           partial.name           || '',
    title:          partial.title          || '',
    company:        partial.company        || '',
    linkedin_url:   partial.linkedin_url   || '',
    email:          partial.email          || '',
    email_verified: partial.email_verified || false,
    email_source:   partial.email_source   || '',
    verified:       false,  // NEVER true from search — must pass Layer 2 verification
    data_source:    partial.data_source    || 'brave',
    snippet:        partial.snippet        || '',
    country:        partial.country        || '',
    location:       partial.location       || '',
    domain:         partial.domain         || '',
    linkedin_company_url: partial.linkedin_company_url || '',
    signal:         partial.signal         || '',
    angle:          partial.angle          || '',
    friction:       partial.friction       || '',
    why_now:        partial.why_now        || '',
    notes:          partial.notes          || '',
    short_description: partial.short_description || '',
    metadata:       partial.metadata       || {},
  };
}

/**
 * Map ICP industry names to concrete search phrases.
 * "Agency" alone is too generic — expand to specific types.
 */
const INDUSTRY_SEARCH_PHRASES = {
  'property':     ['"property developer"', '"real estate"', '"property management"'],
  'proptech':     ['"proptech"', '"property technology"', '"property tech"'],
  'agency':       ['"marketing agency"', '"digital agency"', '"creative agency"', '"advertising agency"'],
  'marketing':    ['"marketing agency"', '"digital marketing"'],
  'digital':      ['"digital agency"', '"digital marketing"'],
  'consulting':   ['"consulting firm"', '"management consulting"'],
  'saas':         ['"SaaS"', '"software as a service"'],
  'fintech':      ['"fintech"', '"financial technology"'],
  'edtech':       ['"edtech"', '"education technology"'],
  'recruitment':  ['"recruitment agency"', '"staffing"', '"headhunting"'],
  'ecommerce':    ['"e-commerce"', '"online retail"'],
  'f&b':          ['"F&B"', '"food and beverage"', '"restaurant"'],
  'logistics':    ['"logistics"', '"supply chain"'],
  'insurance':    ['"insurance"', '"insurtech"'],
  'hr':           ['"HR tech"', '"human resources"'],
  'legal':        ['"law firm"', '"legal"'],
  'accounting':   ['"accounting firm"', '"audit"'],
  'media':        ['"media company"', '"content"', '"publishing"'],
  'design':       ['"design agency"', '"UX"', '"branding agency"'],
  'tech':         ['"tech company"', '"technology"'],
  'software':     ['"software company"', '"software development"'],
  'seo':          ['"SEO agency"', '"search engine"'],
  'advertising':  ['"advertising agency"', '"ad agency"'],
  'training':     ['"corporate training"', '"professional training"', '"training provider"', '"learning and development"'],
  'corporate training': ['"corporate training"', '"training company"', '"professional development"'],
  'professional training': ['"professional training"', '"training provider"', '"skills development"'],
  'l&d providers': ['"learning and development"', '"L&D provider"', '"corporate training"'],
  'coaching':     ['"executive coaching"', '"sales coaching"', '"business coaching"'],
  'professional services': ['"professional services"', '"consulting firm"', '"business services"'],
  'creative':     ['"creative agency"', '"creative studio"', '"content studio"'],
  'pr':           ['"PR agency"', '"public relations"', '"communications agency"'],
};

function expandIndustry(industry) {
  const key = industry.toLowerCase().trim();
  if (INDUSTRY_SEARCH_PHRASES[key]) return INDUSTRY_SEARCH_PHRASES[key];
  const matchedKey = Object.keys(INDUSTRY_SEARCH_PHRASES)
    .find(k => key.includes(k) || k.includes(key));
  return matchedKey ? INDUSTRY_SEARCH_PHRASES[matchedKey] : [`"${industry}"`];
}

/**
 * Phase B3: Expansion ladder.
 * When the query pool is exhausted or returning zero new candidates,
 * progressively widen the ICP to find more leads.
 *
 * Level 0 = original ICP (strict)
 * Level 1 = add synonym titles (Founder → Founder/Owner/Proprietor/Principal)
 * Level 2 = add sibling industries (agency → also consulting/services/media)
 * Level 3 = widen geography (Klang Valley → all Malaysia)
 * Level 4 = broaden to generic B2B founder/CEO across any industry
 */
function widenIcp(originalIcp, level) {
  if (level <= 0) return originalIcp;

  const widened = { ...originalIcp };

  if (level >= 1) {
    // Expand job titles
    const origTitles = parseCsvField(widened.job_titles || widened.who);
    const expandedTitles = new Set(origTitles);
    for (const t of origTitles) {
      const lower = t.toLowerCase();
      if (/founder/i.test(lower)) {
        ['Owner', 'Principal', 'Proprietor', 'Co-Founder'].forEach(x => expandedTitles.add(x));
      }
      if (/ceo/i.test(lower)) {
        ['Managing Director', 'MD', 'Chief Executive'].forEach(x => expandedTitles.add(x));
      }
      // Do NOT expand "Director" to VP/Head of — those are not decision-maker/owner roles
    }
    widened.job_titles = Array.from(expandedTitles).join(', ');
  }

  if (level >= 2) {
    // Expand industries with siblings
    const origIndustries = parseCsvField(widened.industries);
    const expandedIndustries = new Set(origIndustries);
    for (const ind of origIndustries) {
      const lower = ind.toLowerCase();
      if (/agency|marketing|digital/i.test(lower)) {
        ['consulting', 'professional services', 'media', 'advertising'].forEach(x => expandedIndustries.add(x));
      }
      if (/property|proptech|real estate/i.test(lower)) {
        ['construction', 'architecture', 'interior design'].forEach(x => expandedIndustries.add(x));
      }
      if (/saas|software|tech/i.test(lower)) {
        ['fintech', 'edtech', 'platform', 'IT services'].forEach(x => expandedIndustries.add(x));
      }
    }
    widened.industries = Array.from(expandedIndustries).join(', ');
  }

  if (level >= 3) {
    // Widen geography
    const origGeo = (widened.geographies || widened.geography || widened.location || '').toLowerCase();
    if (/klang|kl|kuala lumpur|selangor/i.test(origGeo)) {
      widened.geographies = 'Malaysia, Kuala Lumpur, Selangor, Penang, Johor, Cyberjaya, Putrajaya';
    }
  }

  if (level >= 4) {
    // Last resort: generic B2B founders — still restricted to owner/C-level
    widened.industries = 'consulting, agency, saas, professional services, b2b';
    widened.job_titles = 'Founder, CEO, Managing Director, Owner, Co-Founder';
  }

  return widened;
}

/* ─── Query pool ─────────────────────────────────────────── */

/**
 * QUERY POOL — generates all possible search queries from ICP config.
 * Returns array of { query, strategy, title, industry, location }
 */
function buildQueryPool(icpMemory) {
  const icp = icpMemory || {};

  // Resolve titles
  const rawTitles = parseCsvField(icp.job_titles || icp.who);
  const titles = rawTitles.length > 0 ? rawTitles : DEFAULT_TITLES;

  // Resolve industries — expand to concrete search phrases
  const rawIndustries = parseCsvField(icp.industries);
  const industries = rawIndustries.length > 0 ? rawIndustries : DEFAULT_INDUSTRIES;

  // Resolve base location — ICP stores as 'geographies' (plural)
  const rawLocation = (icp.geographies || icp.geography || icp.location || '').trim();
  const baseLocation = rawLocation || KL_LOCATIONS[0];

  // 2026-05-23: detect geo scope so we emit per-country query variants in
  // addition to the existing MY-only "Sdn Bhd"/"Berhad" templates. Detection
  // is loose — any mention of the country name OR legal-entity suffix OR
  // ISO code enables that country's variants. MJ scope: MY, SG, AU, US, UK.
  const geoLower = baseLocation.toLowerCase();
  const includesSG = /singapore|\bsg\b|pte\s*\.?\s*ltd/i.test(geoLower);
  const includesAU = /australia|\baus?\b|\bpty\s*\.?\s*ltd/i.test(geoLower);
  const includesUS = /united states|\bu\.?s\.?a?\b|america/i.test(geoLower);
  const includesUK = /united kingdom|\buk\b|britain|england|\bgb\b/i.test(geoLower);

  const queryPool = [];
  const countryForQuery = (query) => {
    const q = String(query || '').toLowerCase();
    if (/pte\s*\.?\s*ltd|singapore|\bsg\b/.test(q)) return 'SG';
    if (/pty\s*\.?\s*ltd|australia|\bau\b/.test(q)) return 'AU';
    if (/united states|\bu\.?s\.?a?\b|america|\bus\b/.test(q)) return 'US';
    if (/united kingdom|\buk\b|britain|england|\bgb\b/.test(q)) return 'GB';
    return 'MY';
  };

  // Generate compound industry search phrases
  const industryPhrases = [];
  for (const ind of industries) {
    industryPhrases.push(...expandIndustry(ind));
  }
  // Deduplicate phrases
  const uniquePhrases = [...new Set(industryPhrases)];

  // Up to 5 titles — broader coverage while avoiding query explosion
  const topTitles = titles.slice(0, 5);

  for (const title of topTitles) {
    for (const phrase of uniquePhrases.slice(0, 12)) {
      // Strategy: direct people search.
      // "Sdn Bhd" is a structural Malaysia signal (legal entity suffix) — safe to include.
      // NO location keywords (Malaysia, KL, etc.) — they cause query pollution where all
      // snippets contain the keyword, making Haiku's location verification circular.
      // Geographic bias comes from gl:'my' / country:'MY' in search providers.
      queryPool.push({
        query:    `${title} ${phrase} "Sdn Bhd"`,
        strategy: 'direct',
        title,
        industry: phrase,
        location: baseLocation,
      });

      // "Berhad" variant — catches public listed and larger Malaysian companies
      queryPool.push({
        query:    `${title} ${phrase} "Berhad"`,
        strategy: 'direct',
        title,
        industry: phrase,
        location: baseLocation,
      });

      // SG variant — "Pte Ltd" suffix (Singapore legal entity). Only if SG is
      // in ICP scope. Same structure as MY direct query, swapped suffix.
      if (includesSG) {
        queryPool.push({
          query:    `${title} ${phrase} "Pte Ltd"`,
          strategy: 'direct',
          title,
          industry: phrase,
          location: baseLocation,
        });
      }
      // AU variant — "Pty Ltd" suffix (Australian proprietary limited).
      if (includesAU) {
        queryPool.push({
          query:    `${title} ${phrase} "Pty Ltd" Australia`,
          strategy: 'direct',
          title,
          industry: phrase,
          location: baseLocation,
        });
      }
      // US variant — no clean legal suffix (Inc/LLC are noisy at scale).
      // Use the explicit country tag in the query plus a B2B qualifier.
      if (includesUS) {
        queryPool.push({
          query:    `${title} ${phrase} "United States" B2B`,
          strategy: 'direct',
          title,
          industry: phrase,
          location: baseLocation,
        });
      }
      // UK variant — "Ltd" / "Limited" suffix + UK geography keyword.
      if (includesUK) {
        queryPool.push({
          query:    `${title} ${phrase} "Ltd" UK`,
          strategy: 'direct',
          title,
          industry: phrase,
          location: baseLocation,
        });
      }
    }

    // Strategy: company search — no location in query, gl:'my' handles geo bias
    for (const phrase of uniquePhrases.slice(0, 8)) {
      queryPool.push({
        query:    `site:linkedin.com/company ${phrase} "Sdn Bhd"`,
        strategy: 'company',
        title:    '',
        industry: phrase,
        location: baseLocation,
      });
      // SG variant
      if (includesSG) {
        queryPool.push({
          query:    `site:linkedin.com/company ${phrase} "Pte Ltd"`,
          strategy: 'company',
          title:    '',
          industry: phrase,
          location: baseLocation,
        });
      }
      // AU variant
      if (includesAU) {
        queryPool.push({
          query:    `site:linkedin.com/company ${phrase} "Pty Ltd"`,
          strategy: 'company',
          title:    '',
          industry: phrase,
          location: baseLocation,
        });
      }
      // US variant
      if (includesUS) {
        queryPool.push({
          query:    `site:linkedin.com/company ${phrase} "United States"`,
          strategy: 'company',
          title:    '',
          industry: phrase,
          location: baseLocation,
        });
      }
      // UK variant
      if (includesUK) {
        queryPool.push({
          query:    `site:linkedin.com/company ${phrase} "Ltd" UK`,
          strategy: 'company',
          title:    '',
          industry: phrase,
          location: baseLocation,
        });
      }
    }
  }

  // Strategy: buying signals (fewer, more targeted)
  // No location in query — "Sdn Bhd" + gl:'my' + Haiku handles Malaysia verification
  for (const phrase of uniquePhrases.slice(0, 6)) {
    queryPool.push({
      query:    `${phrase} "Sdn Bhd" hiring`,
      strategy: 'signal_jobs',
      title:    '',
      industry: phrase,
      location: baseLocation,
    });

    queryPool.push({
      query:    `${phrase} "Sdn Bhd" hiring OR raised OR launched`,
      strategy: 'signal_news',
      title:    '',
      industry: phrase,
      location: baseLocation,
    });

    // SG variants
    if (includesSG) {
      queryPool.push({
        query:    `${phrase} "Pte Ltd" hiring`,
        strategy: 'signal_jobs',
        title:    '',
        industry: phrase,
        location: baseLocation,
      });
      queryPool.push({
        query:    `${phrase} "Pte Ltd" hiring OR raised OR launched`,
        strategy: 'signal_news',
        title:    '',
        industry: phrase,
        location: baseLocation,
      });
    }
    if (includesUS) {
      queryPool.push({
        query:    `${phrase} "United States" "hiring" "sales" B2B founder`,
        strategy: 'signal_jobs',
        title:    '',
        industry: phrase,
        location: baseLocation,
        country:  'US',
      });
      queryPool.push({
        query:    `${phrase} "United States" "raised" OR "launched" B2B founder`,
        strategy: 'signal_news',
        title:    '',
        industry: phrase,
        location: baseLocation,
        country:  'US',
      });
    }
  }

  // Strategy: growth signals — different angle, breaks dedup loop
  const GROWTH_SIGNALS = [
    'hiring first sales person "Sdn Bhd"',
    'hiring BD manager "Sdn Bhd"',
    '"Series A" Malaysia founder',
    '"bootstrapped" founder Malaysia B2B',
    'Malaysia startup founder 2024 OR 2025 B2B',
    'founder CEO "small team" Malaysia B2B clients',
    '"head of sales" hiring Malaysia "Sdn Bhd"',
    'Malaysia B2B SaaS founder "growing team"',
    'Malaysia founder "first enterprise client"',
    'Malaysia CEO agency "scaling"',
  ];
  // SG growth signals — parallel structure to MY set
  const GROWTH_SIGNALS_SG = includesSG ? [
    'hiring first sales person "Pte Ltd"',
    'hiring BD manager "Pte Ltd"',
    '"Series A" Singapore founder',
    '"bootstrapped" founder Singapore B2B',
    'Singapore startup founder 2024 OR 2025 B2B',
    'founder CEO "small team" Singapore B2B clients',
    '"head of sales" hiring Singapore "Pte Ltd"',
    'Singapore B2B SaaS founder "growing team"',
    'Singapore founder "first enterprise client"',
    'Singapore CEO agency "scaling"',
  ] : [];
  for (const sig of [...GROWTH_SIGNALS, ...GROWTH_SIGNALS_SG]) {
    queryPool.push({
      query:    sig,
      strategy: 'signal_growth',
      title:    '',
      industry: 'growth_signal',
      location: baseLocation,
    });
  }

  // Strategy: email-derivable companies — surfaces firms with public staff directories.
  // These return company/team/contact pages that expose email patterns, shifting the
  // search distribution toward prospects that can be reached via email (not just LinkedIn).
  for (const phrase of uniquePhrases.slice(0, 6)) {
    queryPool.push({
      query:    `site:rocketreach.co "${phrase}" "Sdn Bhd"`,
      strategy: 'email_derivable',
      title:    '',
      industry: phrase,
      location: baseLocation,
    });
    queryPool.push({
      query:    `"team" "${phrase}" "@" Malaysia`,
      strategy: 'email_derivable',
      title:    '',
      industry: phrase,
      location: baseLocation,
    });
    queryPool.push({
      query:    `"contact" "${phrase}" "Sdn Bhd"`,
      strategy: 'email_derivable',
      title:    '',
      industry: phrase,
      location: baseLocation,
    });
    // SG variants
    if (includesSG) {
      queryPool.push({
        query:    `site:rocketreach.co "${phrase}" "Pte Ltd"`,
        strategy: 'email_derivable',
        title:    '',
        industry: phrase,
        location: baseLocation,
      });
      queryPool.push({
        query:    `"team" "${phrase}" "@" Singapore`,
        strategy: 'email_derivable',
        title:    '',
        industry: phrase,
        location: baseLocation,
      });
      queryPool.push({
        query:    `"contact" "${phrase}" "Pte Ltd"`,
        strategy: 'email_derivable',
        title:    '',
        industry: phrase,
        location: baseLocation,
      });
    }
  }

  const strategyPriority = {
    signal_jobs: 0,
    signal_news: 1,
    signal_growth: 2,
    signal: 3,
    company: 4,
    email_derivable: 5,
    direct: 6,
  };

  // Deduplicate by query string, then run signal-led strategies first.
  const seen = new Set();
  return queryPool.filter(item => {
    if (seen.has(item.query)) return false;
    seen.add(item.query);
    return true;
  }).map(item => ({ ...item, country: item.country || countryForQuery(item.query) }))
    .sort((a, b) => (strategyPriority[a.strategy] ?? 99) - (strategyPriority[b.strategy] ?? 99));
}

/* ─── Query tracker ──────────────────────────────────────── */

/**
 * QUERY TRACKER — loads used queries from agent_memory.
 * Returns a Set of used query strings.
 */
async function loadUsedQueries(clientId) {
  try {
    const result = await pool.query(
      `SELECT content FROM agent_memory
       WHERE client_id = $1
         AND agent = 'research_beaver'
         AND key = 'used_queries'
       LIMIT 1`,
      [clientId]
    );
    if (result.rows.length === 0) return new Set();
    const arr = result.rows[0].content;
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    console.warn('[research] loadUsedQueries failed:', err.message);
    return new Set();
  }
}

/**
 * QUERY TRACKER — saves updated used queries back to agent_memory.
 */
async function saveUsedQueries(clientId, usedSet) {
  try {
    const arr = Array.from(usedSet);
    await pool.query(
      `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
       VALUES ($1, 'research_beaver', 'used_queries', $2::jsonb, 'config', NOW())
       ON CONFLICT (client_id, agent, key)
       DO UPDATE SET content = $2::jsonb, updated_at = NOW()`,
      [clientId, JSON.stringify(arr)]
    );
  } catch (err) {
    console.warn('[research] saveUsedQueries failed:', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
 * LAYER 2: VERIFICATION — confirm candidates before saving
 * Each candidate from search is UNVERIFIED. This layer uses
 * Hunter (structured data) + Haiku (AI classification) to verify
 * location, industry, and role independently.
 * Cost: ~$0.001 per Haiku call, Hunter included in plan.
 * ══════════════════════════════════════════════════════════════ */

let callAgent;
try {
  callAgent = require('./claude').callAgent;
} catch (err) {
  console.error('[research] CRITICAL: Claude module failed to load — all verification calls will be skipped:', err.message);
  callAgent = null;
}

/**
 * Verify a single candidate against the ICP using Hunter + Haiku.
 * Returns the candidate with verification metadata + score.
 */
async function verifyCandidate(candidate, icp, hunterCache = {}, clientId = null) {
  const verification = {
    score: 0,
    hunterMatch: false,
    hunterDomain: null,
    haikuResult: null,
    pass: false,
    rejectReason: null,
  };

  // ── Hunter company lookup (use cache to avoid duplicate calls) ──
  const companyKey = (candidate.company || '').toLowerCase().trim();
  let hunterData = hunterCache[companyKey] || null;

  if (!hunterData && candidate.company && candidate.company !== 'Unknown' && candidate.company.length >= 3) {
    try {
      // Hunter domainSearch needs the real clientId to get the API key from secrets
      const results = await hunterService.domainSearch(clientId, { company: candidate.company, limit: 1 }).catch(() => []);
      if (results && results.length > 0) {
        const domain = results[0]?.domain || null;
        hunterData = { domain, found: true, employees: results.length };
        verification.hunterDomain = domain;
        if (domain && (domain.endsWith('.my') || domain.endsWith('.com.my'))) {
          verification.score += 5;
        }
      }
      hunterCache[companyKey] = hunterData || { domain: null, found: false, employees: 0 };
    } catch (err) {
      console.warn(`[verify] Hunter lookup failed for "${candidate.company}":`, err.message);
      hunterCache[companyKey] = { domain: null, found: false, employees: 0, error: err.message };
    }
  }

  if (hunterData?.found) {
    verification.score += 10; // company domain exists
    if (hunterData.employees > 0) verification.score += 5;
    verification.hunterMatch = true;
  }

  // ── Pre-Haiku title gate: hard reject banned titles before spending API calls ──
  const candidateTitle = (candidate.title || '').toLowerCase().trim();
  if (candidateTitle) {
    if (BANNED_TITLE_KEYWORDS.some(bk => candidateTitle.includes(bk))) {
      verification.rejectReason = `Title "${candidate.title}" is not a decision-maker role (banned keyword match)`;
      verification.pass = false;
      console.log(`[verify] ⛔ Pre-filter reject: "${candidate.name}" — title "${candidate.title}" contains banned keyword`);
      return { ...candidate, verification };
    }
  }

  // ── Haiku AI classification (the core verification) ──
  let haikuCompleted = false;
  if (callAgent) {
    try {
      const icpContext = `Industries: ${icp.industries || 'any'}\nTitles: ${icp.job_titles || 'CEO, Founder, Director'}\nGeography: ${icp.geographies || icp.geography || 'Malaysia'}\nCompany Size: ${icp.company_size || '1-50'}`;

      const hunterContext = hunterData?.found
        ? `Hunter found domain: ${hunterData.domain}, ~${hunterData.employees} employees indexed`
        : 'Hunter: no data (common for SEA SMBs)';

      const prompt = `Classify this lead candidate against the ICP. Return JSON only.

CANDIDATE:
Name: ${candidate.name}
Title: ${candidate.title || 'unknown'}
Company: ${candidate.company || 'unknown'}
LinkedIn URL: ${candidate.linkedin_url || 'none'}
Google Snippet: ${candidate.snippet || 'none'}
${hunterContext}

ICP REQUIREMENTS:
${icpContext}

CRITICAL: Do NOT count search query terms as evidence of location. Only count actual evidence: country-specific company suffix/TLD, city names in the company description or person's headline, LinkedIn country/city hints, or company website location markers. Generic mentions of a country in snippets are unreliable.

CRITICAL ROLE CHECK: The acceptable roles are the ICP titles only: ${icp.job_titles || 'CEO, Founder, Co-Founder, Managing Director, Owner, Director'}. Founder/owner/C-suite/Managing Director roles are strongest. Head of Sales, Head of Growth, Sales Director, or VP Sales are acceptable only when those titles are explicitly present in the ICP and the company appears SMB/founder-led. Generic Manager, Coordinator, Lead, Specialist, Engineer, Assistant, or unrelated functional roles are not acceptable.

Verify:
1. LOCATION: Is this person actually based in ${icp.geographies || 'Malaysia'}? Cite specific evidence.
2. COUNTRY: Resolve to a single country full name from this fixed list: Malaysia, Singapore, Indonesia, Philippines, Thailand, Vietnam, US, UK, India, China, Japan, Australia, UAE, Other, Unknown. Use evidence from the LinkedIn URL country tag, company TLD, headline city, or "Sdn Bhd"/"Pte Ltd" suffix. If unsure → "Unknown" (do not guess).
3. INDUSTRY: Is this company actually in ${icp.industries || 'the target industry'}? Not just tangentially related.
4. ROLE: Is "${candidate.title}" actually one of the ICP-approved decision-maker roles (${icp.job_titles || 'CEO/Founder/Director'})? "Likely" is NOT good enough for unrelated titles. For ICP-listed senior commercial roles, require clear evidence they own revenue/growth in an SMB/founder-led company.

Return JSON:
{"location":"confirmed|likely|unlikely|unknown","location_evidence":"...","country":"Malaysia|Singapore|Indonesia|Philippines|Thailand|Vietnam|US|UK|India|China|Japan|Australia|UAE|Other|Unknown","industry":"confirmed|likely|unlikely|unknown","industry_evidence":"...","role":"confirmed|likely|unlikely|unknown","confidence":0-100,"pass":true|false,"reason":"one line summary"}`;

      const result = await callAgent('research_beaver', prompt, { clientId });
      verification.haikuResult = result;

      if (result) {
        haikuCompleted = true;

        // ICP+channel patches per MJ direction 2026-04-29
        // Lift country onto verification + candidate so the captain-level ICP v2 gate
        // can hard-reject by country without re-asking Haiku.
        if (typeof result.country === 'string' && result.country.trim()) {
          verification.country = result.country.trim();
          candidate.country = result.country.trim();
        }

        // Hard rejects
        if (result.location === 'unlikely') {
          verification.rejectReason = `Location: ${result.location_evidence || 'not in target geography'}`;
          verification.pass = false;
          return { ...candidate, verification };
        }
        if (result.industry === 'unlikely') {
          verification.rejectReason = `Industry: ${result.industry_evidence || 'not in target industry'}`;
          verification.pass = false;
          return { ...candidate, verification };
        }
        if (result.role === 'unlikely' || result.role === 'unknown') {
          verification.rejectReason = `Role: "${candidate.title}" is not a decision-maker`;
          verification.pass = false;
          return { ...candidate, verification };
        }

        // Score points
        if (result.location === 'confirmed') verification.score += 15;
        else if (result.location === 'likely') verification.score += 8;
        if (result.industry === 'confirmed') verification.score += 15;
        else if (result.industry === 'likely') verification.score += 8;
        if (result.role === 'confirmed') verification.score += 10;
        else if (result.role === 'likely') verification.score += 5;
      }
    } catch (err) {
      console.warn(`[verify] Haiku classification failed for "${candidate.name}":`, err.message);
      // Haiku failed — do NOT pass this lead on Hunter/regex signals alone
    }
  }

  // ── If Haiku didn't complete, reject the lead — no silent pass-through ──
  if (!haikuCompleted) {
    verification.rejectReason = 'Haiku verification unavailable — cannot confirm ICP fit';
    verification.pass = false;
    console.log(`[verify] ⛔ Rejecting "${candidate.name}" — Haiku verification did not complete`);
    return { ...candidate, verification };
  }

  // ── Regex-based bonus signals (free, no API calls) ──
  const allText = `${candidate.name} ${candidate.company} ${candidate.title} ${candidate.snippet}`;
  if (/sdn\s*bhd|berhad/i.test(allText)) verification.score += 5;

  // ── Final decision ──
  // BUG FIX 2026-05-18: threshold was 50, but the MAX achievable score for a
  // perfect Malaysian-SME lead WITHOUT Hunter data is only 45 (location 15 +
  // industry 15 + role 10 + "Sdn Bhd" regex 5). Hunter has no data for most
  // SEA SMBs (see hunterContext, ~line 473), so the entire founder-led-SME
  // ICP was mathematically unable to pass verification — Brave + Haiku credits
  // burned every run, 0 leads produced.
  //
  // Threshold = 40: a lead with Haiku-confirmed location (15) + industry (15)
  // + role (10) now clears WITHOUT Hunter. The hard rejects above (location/
  // industry/role = "unlikely", banned title) still gate quality; the score
  // only grades confirmed-vs-likely strength. Hunter (+20) and the "Sdn Bhd"
  // regex (+5) are bonuses, not requirements.
  const PASS_THRESHOLD = 40;
  if (verification.score >= PASS_THRESHOLD) {
    verification.pass = true;
  } else {
    verification.pass = false;
    verification.rejectReason = verification.rejectReason || `Score too low (${verification.score}/${PASS_THRESHOLD})`;
  }

  return { ...candidate, verification };
}

/**
 * Verify a batch of candidates in parallel.
 * Hard cap: max 20 Haiku calls per batch (cost control).
 */
async function verifyBatch(candidates, icp, clientId = null) {
  const MAX_VERIFY = 20;
  const toVerify = candidates.slice(0, MAX_VERIFY);
  const hunterCache = {}; // shared cache to avoid duplicate company lookups

  console.log(`[verify] Verifying ${toVerify.length} candidates (max ${MAX_VERIFY}) clientId=${clientId || 'none'}`);

  const results = await Promise.allSettled(
    toVerify.map(c => verifyCandidate(c, icp, hunterCache, clientId))
  );

  const verified = [];
  const rejected = [];

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      if (r.value.verification?.pass) {
        verified.push(r.value);
        console.log(`[verify] ✅ ${r.value.name} (${r.value.company}) — score ${r.value.verification.score}`);
      } else {
        rejected.push(r.value);
        console.log(`[verify] ❌ ${r.value.name} (${r.value.company}) — ${r.value.verification?.rejectReason || 'failed'}`);
      }
    }
  }

  console.log(`[verify] Results: ${verified.length} verified, ${rejected.length} rejected`);
  return { verified, rejected };
}

function summarizeRejectionReasons(rejected) {
  return rejected.reduce((acc, lead) => {
    const reason = String(lead?.verification?.rejectReason || 'unknown');
    const bucket = reason.startsWith('Location:')
      ? 'location'
      : reason.startsWith('Industry:')
        ? 'industry'
        : reason.startsWith('Role:')
          ? 'role'
          : reason.startsWith('Title ')
            ? 'title'
            : reason.startsWith('Score too low')
              ? 'score'
              : reason.startsWith('Haiku')
                ? 'verification_unavailable'
                : 'other';
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {});
}

function rejectionSamples(rejected, limit = 10) {
  return rejected.slice(0, limit).map(lead => ({
    name: lead.name || null,
    title: lead.title || null,
    company: lead.company || null,
    data_source: lead.data_source || null,
    source_strategy: lead.metadata?.source_strategy || null,
    reason: lead.verification?.rejectReason || 'unknown',
    score: lead.verification?.score ?? null,
  }));
}

/* ─── Strategy 1: Direct LinkedIn people search ──────────── */

/**
 * STRATEGY 1: Direct LinkedIn people search.
 * Brave: site:linkedin.com/in [title] [industry] [location]
 */
async function strategyDirectPeople(queryItem, limit) {
  const query = typeof queryItem === 'string' ? queryItem : queryItem.query;
  const country = typeof queryItem === 'string' ? 'MY' : (queryItem.country || 'MY');
  try {
    const results = await searchService.searchLinkedInProfiles(query, limit, { country });
    return results.map(r => normaliseLead({
      ...r,
      data_source:  'brave',
      email_source: r.email ? 'brave' : '',
    }));
  } catch (err) {
    console.warn('[research] Strategy 1 (direct people) failed:', err.message);
    return [];
  }
}

/* ─── Strategy 2: Company-first search ───────────────────── */

/**
 * STRATEGY 2: Company-first search.
 * Step 1 — Brave: site:linkedin.com/company [industry] [location]
 * Step 2 — For each company: Hunter domainSearch to find decision-makers.
 * Returns leads with real emails where Hunter finds them.
 */
function titleHintsFromIcp(icpMemory) {
  const titles = parseCsvField(icpMemory?.job_titles || icpMemory?.who);
  const preferred = titles.length > 0 ? titles : DEFAULT_TITLES;
  const clean = preferred
    .slice(0, 5)
    .map(t => String(t || '').trim())
    .filter(Boolean);
  return clean.length > 0
    ? clean.map(t => /\s/.test(t) ? `"${t}"` : t).join(' OR ')
    : 'Founder OR CEO OR "Managing Director"';
}

function companyDiscoveryContext(item, companyName) {
  const strategy = item?.strategy || 'company';
  const industry = item?.industry || 'the tenant ICP';
  const location = item?.location || 'the target geography';

  if (strategy === 'signal_jobs') {
    return {
      dataSource: 'brave_signal_jobs',
      sourceStrategy: 'signal_company_first',
      signal: `Hiring signal: ${companyName || industry} is actively hiring`,
      whyNow: `Hiring activity detected via company search for "${industry}" in ${location}; decision-maker lookup is scoped to the discovered company.`,
    };
  }

  if (strategy === 'signal_news') {
    return {
      dataSource: 'brave_signal_news',
      sourceStrategy: 'signal_company_first',
      signal: `Growth signal: ${companyName || industry} recently hired, raised, or launched`,
      whyNow: `Recent growth event detected via company search for "${industry}" in ${location}; decision-maker lookup is scoped to the discovered company.`,
    };
  }

  if (strategy === 'signal_growth' || strategy === 'signal') {
    return {
      dataSource: 'brave_signal_growth',
      sourceStrategy: 'signal_company_first',
      signal: `Growth signal: ${companyName || industry} matches ${industry}`,
      whyNow: `Growth activity detected for "${industry}" in ${location}; decision-maker lookup is scoped to the discovered company.`,
    };
  }

  return {
    dataSource: 'brave_company',
    sourceStrategy: 'company_first',
    signal: `Company-first match: ${companyName || industry} matches ${industry}`,
    whyNow: `Company discovered through ${industry} company search in the target geography.`,
  };
}

const COMPANY_DISCOVERY_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'company', 'companies', 'provider', 'providers',
  'sdn', 'bhd', 'berhad', 'pte', 'ltd', 'pty', 'inc', 'llc', 'limited', 'united',
  'states', 'malaysia', 'singapore', 'australia', 'hiring', 'sales', 'raised',
  'launched', 'growth', 'founder', 'ceo', 'site', 'linkedin', 'com',
  'first', 'person', 'manager', 'startup', 'clients', 'team',
]);

function companyDiscoveryTokens(value) {
  return String(value || '')
    .replace(/l\s*&\s*d/ig, 'learning development')
    .replace(/[^a-z0-9]+/ig, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3 && !COMPANY_DISCOVERY_STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function companyDiscoveryMatchesQuery(item, company) {
  const strategy = String(item?.strategy || '');
  if (strategy === 'signal_growth') return true;

  const preferredScope = item?.industry && item.industry !== 'growth_signal'
    ? item.industry
    : item?.query;
  const tokens = [...new Set(companyDiscoveryTokens(preferredScope))];
  if (tokens.length === 0) return true;

  const text = [
    company?.company,
    company?.name,
    company?.title,
    company?.snippet,
  ].filter(Boolean).join(' ').toLowerCase();

  return tokens.some(token => text.includes(token));
}

async function strategyCompanyFirst(clientId, icpMemory, limit, options = {}) {
  const leads = [];

  try {
    const suppliedQueries = Array.isArray(options.queryItems) ? options.queryItems.filter(Boolean) : null;
    const stats = options.stats || null;
    if (stats && !Array.isArray(stats.fallbackQueriesUsed)) stats.fallbackQueriesUsed = [];
    if (stats && !Number.isFinite(Number(stats.companyFilteredOut))) stats.companyFilteredOut = 0;
    const maxCompanyQueries = Number.isFinite(Number(options.maxCompanyQueries))
      ? Math.max(0, Number(options.maxCompanyQueries))
      : 3;
    let fallbackProfileBudget = Number.isFinite(Number(options.maxFallbackProfileQueries))
      ? Math.max(0, Number(options.maxFallbackProfileQueries))
      : 0;
    const hunterEnabled = Number(require('./spendGuard').CAPS.hunter || 0) > 0;
    const titleHints = titleHintsFromIcp(icpMemory);

    // Pull company queries from the paid-query picker. When suppliedQueries is
    // present, the caller already counted each item against maxPaidQueries.
    const queryPool = suppliedQueries || buildQueryPool(icpMemory).filter(q => q.strategy === 'company');
    const companyQueries = queryPool.slice(0, suppliedQueries ? suppliedQueries.length : maxCompanyQueries);
    const seenCompanyKeys = new Set();

    for (const item of companyQueries) {
      try {
        // Step 1: find company LinkedIn pages via Brave search.
        // Pass item.industry (just the phrase) — searchLinkedInCompanies prepends
        // "site:linkedin.com/company" itself. Passing item.query would double it.
        const searchPhrase = String(item.query || `${item.industry} "Sdn Bhd"`)
          .replace(/^site:linkedin\.com\/company\s+/i, '')
          .trim();
        const companyResults = await searchService.searchLinkedInCompanies
          ? searchService.searchLinkedInCompanies(searchPhrase, 3, { country: item.country || 'MY' })
          : Promise.resolve([]);

        const companies = await companyResults;

        for (const c of companies) {
          const companyName = c.company || c.name || '';
          const domain = c.website || c.domain || '';

          if (!companyName && !domain) continue;
          const companyKey = String(companyName || domain)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();

          if (!companyDiscoveryMatchesQuery(item, c)) {
            if (stats) stats.companyFilteredOut++;
            continue;
          }
          if (companyKey && seenCompanyKeys.has(companyKey)) continue;
          if (companyKey) seenCompanyKeys.add(companyKey);

          // Step 2: Hunter domain search when explicitly capped on.
          let hunterLeads = [];
          if (hunterEnabled) {
            try {
              hunterLeads = await hunterService.domainSearch(clientId, {
                company: companyName,
                domain:  domain || undefined,
                limit:   3,
              });
            } catch (hErr) {
              console.warn('[research] Hunter domainSearch error:', hErr.message);
            }
          }

          // Filter Hunter results by ICP-relevant titles (exact match, not substring)
          const filtered = hunterLeads.filter(h => {
            if (!h.title) return false;
            const t = h.title.toLowerCase().trim();
            // Check banned titles first — hard reject
            if (BANNED_TITLE_KEYWORDS.some(bk => t.includes(bk))) return false;
            // Exact match against ICP titles
            return ICP_TITLE_EXACT.has(t);
          });

          if (filtered.length > 0) {
            for (const h of filtered) {
              const context = companyDiscoveryContext(item, companyName);
              leads.push(normaliseLead({
                name:           `${h.firstName || ''} ${h.lastName || ''}`.trim(),
                title:          h.title || '',
                company:        companyName,
                linkedin_url:   h.linkedin_url || '',
                email:          h.email || '',
                email_verified: h.confidence >= 70,
                email_source:   h.email ? 'hunter_domain' : '',
                data_source:    h.email ? 'hunter_domain' : context.dataSource,
                domain:         domain || h.domain || '',
                linkedin_company_url: c.linkedin_company_url || '',
                signal:         context.signal,
                why_now:        context.whyNow,
                snippet:        [h.snippet, c.snippet].filter(Boolean).join(' '),
                metadata:       {
                  source_strategy: context.sourceStrategy,
                  company_discovery_query: item.query,
                  company_discovery_strategy: item.strategy || 'company',
                  company_discovery_snippet: c.snippet || '',
                  linkedin_company_url: c.linkedin_company_url || '',
                },
              }));
            }
          } else if (companyName && fallbackProfileBudget > 0) {
            // Fallback: Brave people search scoped to this company
            try {
              fallbackProfileBudget--;
              const fallbackQuery = `"${companyName}" (${titleHints})`;
              if (stats) stats.fallbackQueriesUsed.push(fallbackQuery);
              const fallbackResults = await searchService.searchLinkedInProfiles(fallbackQuery, 3, { country: item.country || 'MY' });
              for (const r of fallbackResults) {
                const context = companyDiscoveryContext(item, companyName);
                leads.push(normaliseLead({
                  ...r,
                  company:        companyName || r.company,
                  domain:         domain || '',
                  linkedin_company_url: c.linkedin_company_url || '',
                  data_source:    context.dataSource,
                  email_source:   r.email ? 'brave' : '',
                  signal:         context.signal,
                  why_now:        context.whyNow,
                  snippet:        [r.snippet, c.snippet].filter(Boolean).join(' '),
                  metadata:       {
                    source_strategy: context.sourceStrategy,
                    company_discovery_query: item.query,
                    company_discovery_strategy: item.strategy || 'company',
                    company_discovery_snippet: c.snippet || '',
                    linkedin_company_url: c.linkedin_company_url || '',
                  },
                }));
              }
            } catch (fbErr) {
              console.warn('[research] Strategy 2 fallback search failed:', fbErr.message);
            }
          }
        }
      } catch (innerErr) {
        console.warn('[research] Strategy 2 inner loop failed:', innerErr.message);
      }
    }
  } catch (err) {
    console.warn('[research] Strategy 2 (company-first) failed:', err.message);
  }

  return leads.slice(0, limit);
}

/* ─── Strategy 3: Signal-based search ───────────────────── */

/**
 * STRATEGY 3: Signal-based search.
 * Brave: "[location]" "[title]" "[signal]" site:linkedin.com/in
 */
async function strategySignalBased(queryItem, limit) {
  const query = typeof queryItem === 'string' ? queryItem : queryItem.query;
  const country = typeof queryItem === 'string' ? 'MY' : (queryItem.country || 'MY');
  try {
    const results = await searchService.searchLinkedInProfiles(query, limit, { country });
    return results.map(r => normaliseLead({
      ...r,
      data_source:  'brave_signal',
      email_source: r.email ? 'brave' : '',
    }));
  } catch (err) {
    console.warn('[research] Strategy 3 (signal-based) failed:', err.message);
    return [];
  }
}

/* ─── Main export ────────────────────────────────────────── */

/**
 * MAIN EXPORT — multi-source research orchestrator.
 * Runs all strategies, merges results, deduplicates by linkedin_url.
 * Returns { leads: [], queriesUsed: [], source: 'multi' }
 */
async function researchLeads(clientId, { icpMemory = {}, targetCount = 5, batchIndex = 0, commandOverride = '', maxPaidQueries = MAX_PAID_SEARCH_QUERIES_PER_RUN } = {}) {
  const emptyResult = { leads: [], queriesUsed: [], source: 'multi' };

  try {
    try {
      const { getLegacyIcpForClient } = require('./tenantContext');
      const canonicalIcp = await getLegacyIcpForClient(clientId, {
        source: 'service',
        fallback: icpMemory && Object.keys(icpMemory).length > 0 ? icpMemory : null,
      });
      if (canonicalIcp) icpMemory = canonicalIcp;
    } catch (ctxErr) {
      console.warn('[research] tenant profile ICP load failed, using provided ICP memory:', ctxErr.message);
    }

    // 0. Log ICP consumption for debugging
    console.log(`[research] ═══ Starting research for client ${clientId} ═══`);
    console.log(`[research] ICP job_titles: ${icpMemory?.job_titles || 'NONE (using defaults)'}`);
    console.log(`[research] ICP industries: ${icpMemory?.industries || 'NONE (using defaults)'}`);
    console.log(`[research] ICP geographies: ${icpMemory?.geographies || icpMemory?.geography || 'NONE (using defaults)'}`);
    console.log(`[research] Target count: ${targetCount}, Batch index: ${batchIndex}`);
    const paidQueryCap = Math.max(1, Math.min(MAX_PAID_SEARCH_QUERIES_PER_RUN, Number(maxPaidQueries) || MAX_PAID_SEARCH_QUERIES_PER_RUN));

    // 1. Load used queries
    const usedSet = await loadUsedQueries(clientId);

    // 2. Build query pool — ICP-only (Phase 2 V2 Step 9, 2026-05-15)
    // The legacy commandOverride keyword-extraction branch was deleted: it accepted
    // a freeform string and substring-matched against a small industry/title keyword
    // list, then overwrote the ICP. In practice the autonomous kickoff passed a
    // 500-word paragraph (buildAutonomousBrief), every keyword matched, and the
    // resulting Brave queries returned 0. ICP memory is now the single source of
    // truth for query construction. Short user commands route via Captain's
    // create_lead tool / /inject, not through this path.
    const queryPool = buildQueryPool(icpMemory);

    // 3. Pick the next discovery queries. Signal-first is the product rule:
    // find active buying intent first, use company/direct searches only as
    // support when signal queries cannot fill the paid-query budget.
    const pickCount = Math.max(targetCount * 2, 6);

    // Separate unused from used
    const unusedQueries = queryPool.filter(q => !usedSet.has(q.query));
    const usedQueries   = queryPool.filter(q =>  usedSet.has(q.query));

    // Pool exhaustion detection — auto-reset + ICP widening when >80% used
    const exhaustionRate = queryPool.length > 0 ? usedQueries.length / queryPool.length : 0;
    let finalUnused = unusedQueries;
    let finalUsed = usedQueries;

    if (exhaustionRate > 0.8) {
      console.warn(`[research] Query pool ${Math.round(exhaustionRate * 100)}% exhausted. Auto-resetting used_queries and widening ICP.`);
      // Reset used_queries so next run starts fresh with rotated angles
      await saveUsedQueries(clientId, new Set());
      // Rebuild pool with widened ICP (level 2 = sibling industries + synonym titles)
      const widenedIcp = widenIcp(icpMemory, 2);
      const widenedPool = buildQueryPool(widenedIcp);
      finalUnused = widenedPool; // all queries fresh after reset
      finalUsed = [];
    }

    // Prefer unused; fall back to used if pool is exhausted
    const combined = [...finalUnused, ...finalUsed];

    // Apply batchIndex offset so repeated calls rotate through the pool
    // Cap pick count to available unique queries to prevent duplicates
    const safeLength = Math.max(combined.length, 1);
    const safePick = Math.min(pickCount, combined.length);
    const offset = safePick > 0 ? (batchIndex * safePick) % safeLength : 0;
    const rotated = [...combined.slice(offset), ...combined.slice(0, offset)];
    let paidQueriesRemaining = paidQueryCap;
    const initialQueryBudget = Math.min(safePick, paidQueriesRemaining, Math.max(1, Math.min(targetCount, 5)));
    const pickedKeys = new Set();
    const picked = [];
    const signalStrategies = new Set(['signal_jobs', 'signal_news', 'signal_growth', 'signal']);
    const rotatedSignal = rotated.filter(q => signalStrategies.has(q.strategy));
    for (const q of rotatedSignal.slice(0, initialQueryBudget)) {
      picked.push(q);
      pickedKeys.add(q.query);
    }
    const rotatedCompany = rotated.filter(q => q.strategy === 'company');
    for (const q of rotatedCompany) {
      if (picked.length >= initialQueryBudget) break;
      if (pickedKeys.has(q.query)) continue;
      picked.push(q);
      pickedKeys.add(q.query);
    }
    for (const q of rotated) {
      if (picked.length >= initialQueryBudget) break;
      if (pickedKeys.has(q.query) || q.strategy === 'direct') continue;
      picked.push(q);
      pickedKeys.add(q.query);
    }
    for (const q of rotated) {
      if (picked.length >= initialQueryBudget) break;
      if (pickedKeys.has(q.query)) continue;
      picked.push(q);
      pickedKeys.add(q.query);
    }
    paidQueriesRemaining -= picked.length;
    if (safePick > picked.length) {
      console.log(`[research] Capping paid query fanout from ${safePick} to ${picked.length} for this run`);
    }

    // 4. Split by strategy
    const directQueries      = picked.filter(q => q.strategy === 'direct');
    const signalQueries      = picked.filter(q => q.strategy === 'signal');
    const signalJobsQueries  = picked.filter(q => q.strategy === 'signal_jobs');
    const signalNewsQueries  = picked.filter(q => q.strategy === 'signal_news');
    const signalGrowthQueries = picked.filter(q => q.strategy === 'signal_growth');
    const companyQueries = picked.filter(q => q.strategy === 'company');
    const companyDiscoveryQueries = [
      ...signalJobsQueries,
      ...signalNewsQueries,
      ...signalGrowthQueries,
      ...companyQueries,
    ];
    const companyFallbackBudget = companyDiscoveryQueries.length > 0
      ? Math.min(paidQueriesRemaining, Math.max(targetCount * 2, 1))
      : 0;
    paidQueriesRemaining -= companyFallbackBudget;
    const companyFirstStats = { fallbackQueriesUsed: [] };

    // 5 & 6. Run all strategies in parallel
    const profileQueryCount = directQueries.length + signalQueries.length;
    const perQueryLimit = Math.max(Math.ceil(targetCount / Math.max(profileQueryCount, 1)), 2);

    const directPromises = directQueries.map(q =>
      strategyDirectPeople(q, perQueryLimit)
        .catch(err => {
          console.warn('[research] Direct query failed:', err.message);
          return [];
        })
    );

    const signalPromises = signalQueries.map(q =>
      strategySignalBased(q, perQueryLimit)
        .catch(err => {
          console.warn('[research] Signal query failed:', err.message);
          return [];
        })
    );

    // Signal job/news queries must discover companies first. Running them as
    // generic profile searches returns people who mention hiring/sales terms,
    // then Layer 2 correctly rejects them as non-ICP decision-makers.
    const companyPromise = companyDiscoveryQueries.length > 0
      ? strategyCompanyFirst(clientId, icpMemory, targetCount * 2, {
        queryItems: companyDiscoveryQueries,
        maxFallbackProfileQueries: companyFallbackBudget,
        stats: companyFirstStats,
      })
        .catch(err => {
          console.warn('[research] Company-first strategy failed:', err.message);
          return [];
        })
      : Promise.resolve([]);

    const [directResults, signalResults, companyLeads] = await Promise.all([
      Promise.all(directPromises).then(arrays => arrays.flat()),
      Promise.all(signalPromises).then(arrays => arrays.flat()),
      companyPromise,
    ]);

    // 7. Merge and deduplicate by linkedin_url
    // Signal-tagged leads are prioritised (they come first, dedup keeps first occurrence)
    const allLeads = [
      ...companyLeads,        // P1/P2: signal/company-first with scoped decision-maker lookup
      ...signalResults,       // P2: signal-based
      ...directResults,       // P3: direct people
    ];

    const seen = new Set();
    const deduped = allLeads.filter(lead => {
      // Leads without a LinkedIn URL are kept but only one per name+company combo
      const key = lead.linkedin_url
        ? lead.linkedin_url
        : `${lead.name}||${lead.company}`.toLowerCase();
      if (!key || key === '||') return true; // can't dedup, keep it
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 8. Pre-filter: reject leads with no company name BEFORE Layer 2
    // This saves Haiku API calls on leads that will be rejected anyway
    const preFiltered = deduped.filter(lead => {
      if (!lead.company || lead.company === 'Unknown' || lead.company.length < 3) {
        console.log(`[research] Pre-filter: dropping ${lead.name} — no company name`);
        return false;
      }
      return true;
    });
    console.log(`[research] Pre-filter: ${deduped.length} → ${preFiltered.length} (dropped ${deduped.length - preFiltered.length} with unknown company)`);

    // 9. Mark all picked queries as used, save back
    for (const q of picked) {
      usedSet.add(q.query);
    }
    await saveUsedQueries(clientId, usedSet);

    // 10. LAYER 2: Verify candidates before returning
    // Retry up to 2 more times if we haven't hit targetCount yet (each retry fetches fresh queries)
    const queriesUsed = [
      ...picked.map(q => q.query),
      ...companyFirstStats.fallbackQueriesUsed,
    ];
    console.log(`[research] Layer 1 complete: ${preFiltered.length} candidates (from ${deduped.length} raw). Starting Layer 2 verification...`);

    const icp = icpMemory || {};
    let { verified, rejected } = await verifyBatch(preFiltered, icp, clientId);
    let companyFilteredOutTotal = companyFirstStats.companyFilteredOut || 0;

    console.log(`[research] Layer 2 complete: ${verified.length} verified, ${rejected.length} rejected`);

    // ── Metric accumulators (2026-05-22) ───────────────────────────────
    // Previously, verification_stats reported `candidates: deduped.length` —
    // the INITIAL Layer 1 count only — while `rejected` accumulated across
    // every retry round. That made the metric internally incoherent: 14
    // initial candidates could "produce" 51 rejections, with no signal that
    // retry rounds had fired. Fix: track candidates / queries / rounds
    // across the entire pipeline so a single log entry is self-consistent.
    let candidatesVerifiedTotal = preFiltered.length;
    let queriesUsedTotal = queriesUsed.length;
    let roundsRan = 1; // the initial Layer 2 pass counts as round 1

    // ── Phase B3: Retry + expansion ladder ──
    // Retry up to MAX_RETRIES times. If the pool is exhausted or zero new candidates
    // come back, WIDEN the ICP progressively instead of giving up.
    //
    // Levels: 0 (strict) → 1 (+titles) → 2 (+industries) → 3 (+geo) → 4 (generic B2B)
    const MAX_RETRIES = 5;
    // ── Spend circuit breaker (2026-05-18) ─────────────────────────────
    // MAX_SEARCH_ROUNDS hard-caps the retry rounds that actually hit the
    // paid search provider. It is NEVER decremented — unlike retryCount,
    // which the expansion ladder rolls back, making MAX_RETRIES not a real
    // ceiling. consecutiveZeroYield stops the ladder once a round produces
    // nothing twice running. Without these, a high-rejection ICP drains
    // Brave across 5+ rounds and still returns 0 leads — the documented
    // "burn without producing" failure.
    const MAX_SEARCH_ROUNDS = 4;
    let searchRounds = 0;
    let consecutiveZeroYield = 0;
    let circuitBreakerTripped = null;
    let retryCount = 0;
    let expansionLevel = 0;
    const allVerifiedUrls = new Set(verified.map(l => l.linkedin_url).filter(Boolean));
    if (verified.length === 0 && preFiltered.length >= Math.max(targetCount, 3)) {
      circuitBreakerTripped = `initial verification rejected all ${preFiltered.length} candidates`;
      console.warn(`[research] CIRCUIT BREAKER: ${circuitBreakerTripped} — stopping paid search`);
    }

    while (!circuitBreakerTripped && verified.length < targetCount && retryCount < MAX_RETRIES) {
      retryCount++;
      const shortfall = targetCount - verified.length;
      console.log(`[research] Retry ${retryCount}/${MAX_RETRIES}: need ${shortfall} more verified leads (expansion level ${expansionLevel})`);

      // Use widened ICP if we've escalated
      const currentIcp = expansionLevel > 0 ? widenIcp(icpMemory, expansionLevel) : icpMemory;
      const freshPool = buildQueryPool(currentIcp);
      const freshSeen = new Set(usedSet);
      const freshUnused = freshPool.filter(q => !freshSeen.has(q.query));

      if (paidQueriesRemaining <= 0) {
        circuitBreakerTripped = `paid query cap (${paidQueryCap}) reached`;
        console.warn(`[research] CIRCUIT BREAKER: ${circuitBreakerTripped} — stopping paid search`);
        break;
      }

      // If the current expansion level has no unused queries, escalate
      if (freshUnused.length === 0 && expansionLevel < 4) {
        expansionLevel++;
        console.log(`[research] Query pool exhausted at level ${expansionLevel - 1} — escalating to level ${expansionLevel}`);
        retryCount--; // this attempt was wasted, don't count it
        continue;
      }

      // Pick next batch of unused queries
      const actualPicked = freshUnused.slice(0, Math.min(pickCount, freshUnused.length, paidQueriesRemaining));
      paidQueriesRemaining -= actualPicked.length;
      queriesUsed.push(...actualPicked.map(q => q.query));

      const retryDirectQueries = actualPicked.filter(q => q.strategy === 'direct');
      const retrySignalQueries = actualPicked.filter(q => q.strategy === 'signal');
      const retryCompanyQueries = actualPicked.filter(q =>
        q.strategy === 'company'
        || q.strategy === 'signal_growth'
        || q.strategy === 'signal_jobs'
        || q.strategy === 'signal_news'
      );
      const retryCompanyStats = { fallbackQueriesUsed: [] };
      const retryCompanyFallbackBudget = retryCompanyQueries.length > 0
        ? Math.min(paidQueriesRemaining, Math.max(shortfall * 2, 1))
        : 0;
      paidQueriesRemaining -= retryCompanyFallbackBudget;

      // CIRCUIT BREAKER: stop before spending if the paid-search round cap is hit
      if (searchRounds >= MAX_SEARCH_ROUNDS) {
        circuitBreakerTripped = `search-round cap (${MAX_SEARCH_ROUNDS}) reached`;
        console.warn(`[research] CIRCUIT BREAKER: ${circuitBreakerTripped} — stopping paid search to prevent burn`);
        break;
      }
      searchRounds++;
      queriesUsedTotal += actualPicked.length; // accumulate for metric

      const retryResults = await Promise.all([
        ...retryDirectQueries.map(q => strategyDirectPeople(q, perQueryLimit).catch(() => [])),
        ...retrySignalQueries.map(q => strategySignalBased(q, perQueryLimit).catch(() => [])),
        retryCompanyQueries.length > 0
          ? strategyCompanyFirst(clientId, currentIcp, shortfall * 2, {
            queryItems: retryCompanyQueries,
            maxFallbackProfileQueries: retryCompanyFallbackBudget,
            stats: retryCompanyStats,
          }).catch(() => [])
          : Promise.resolve([]),
      ]);
      queriesUsedTotal += retryCompanyStats.fallbackQueriesUsed.length;
      queriesUsed.push(...retryCompanyStats.fallbackQueriesUsed);
      companyFilteredOutTotal += retryCompanyStats.companyFilteredOut || 0;

      const retryCandidates = retryResults.flat()
        .filter(l => l.linkedin_url && !allVerifiedUrls.has(l.linkedin_url));

      // Always mark queries as used to prevent repeat
      for (const q of actualPicked) usedSet.add(q.query);

      if (retryCandidates.length === 0) {
        consecutiveZeroYield++;
        console.log(`[research] Retry ${retryCount}: zero new candidates at level ${expansionLevel} (zero-yield streak: ${consecutiveZeroYield})`);
        if (consecutiveZeroYield >= 2) {
          circuitBreakerTripped = 'two consecutive zero-yield rounds';
          console.warn(`[research] CIRCUIT BREAKER: ${circuitBreakerTripped} — stopping paid search`);
          break;
        }
        // Escalate expansion level, but don't count this as a failed retry
        if (expansionLevel < 4) {
          expansionLevel++;
          console.log(`[research] Escalating expansion to level ${expansionLevel}`);
          retryCount--; // give us another shot at this budget
          continue;
        } else {
          console.log(`[research] Already at max expansion — stopping`);
          break;
        }
      }

      console.log(`[research] Retry ${retryCount}: verifying ${retryCandidates.length} fresh candidates`);
      const retryVerification = await verifyBatch(retryCandidates, currentIcp || icp, clientId);
      verified.push(...retryVerification.verified.filter(l => !allVerifiedUrls.has(l.linkedin_url)));
      rejected.push(...retryVerification.rejected);
      retryVerification.verified.forEach(l => { if (l.linkedin_url) allVerifiedUrls.add(l.linkedin_url); });

      // Accumulate metrics for this round
      candidatesVerifiedTotal += retryCandidates.length;
      roundsRan++;

      // CIRCUIT BREAKER: a round where verification rejects every candidate
      // is a paid round that produced nothing. Two in a row → stop. No point
      // paying for more searches that verification keeps throwing away.
      if (retryVerification.verified.length === 0) {
        consecutiveZeroYield++;
        if (consecutiveZeroYield >= 2) {
          circuitBreakerTripped = 'two consecutive rounds with zero verified leads';
          console.warn(`[research] CIRCUIT BREAKER: ${circuitBreakerTripped} — stopping paid search`);
          break;
        }
        if (expansionLevel < 4) {
          expansionLevel++;
          console.log(`[research] Zero verified this batch — escalating expansion to level ${expansionLevel}`);
        }
      } else {
        consecutiveZeroYield = 0; // a productive round resets the breaker
      }
    }

    // Mark verified leads
    const verifiedLeads = verified.slice(0, targetCount * 2).map(lead => ({
      ...lead,
      verified: true,
      metadata: {
        ...(lead.metadata || {}),
        verification: lead.verification,
        data_source: 'brave',
      },
    }));

    // ─── Quality scoring (Phase B integration) ───────────────────────
    // Score every verified lead so Sales Beaver can pull top-N by score.
    // Failure here is non-fatal — leads still flow without scores.
    let scoringStats = { scored: 0, top_score: null, avg_score: null };
    try {
      const tenantConfig = require('./tenantConfig');
      const qualityScorer = require('./qualityScorer');
      const cfg = await tenantConfig.getTenantConfig(clientId);

      let scoreSum = 0, topScore = 0;
      for (const lead of verifiedLeads) {
        try {
          const result = qualityScorer.scoreLead(lead, cfg);
          lead.quality_score = result.score;
          lead.quality_score_breakdown = result.breakdown;
          scoreSum += result.score;
          if (result.score > topScore) topScore = result.score;
          scoringStats.scored++;
        } catch (scoreErr) {
          console.warn('[research] quality score failed for', lead.name, ':', scoreErr.message);
        }
      }
      scoringStats.top_score = topScore || null;
      scoringStats.avg_score = scoringStats.scored > 0 ? Math.round(scoreSum / scoringStats.scored) : null;
      console.log(`[research] Quality-scored ${scoringStats.scored}/${verifiedLeads.length} leads. avg=${scoringStats.avg_score} top=${scoringStats.top_score}`);

      // Sort by quality_score DESC so top scorers surface first downstream
      verifiedLeads.sort((a, b) => (b.quality_score || 0) - (a.quality_score || 0));
    } catch (err) {
      console.warn('[research] tenant config / scoring layer failed:', err.message);
    }

    // ─── Daily KPI report to Captain ────────────────────────────────
    // Beavers report their own daily output to Captain via beaverState.
    // Captain reads these in his EOD brief + tomorrow's morning brief.
    // Failure non-fatal — research output still flows.
    try {
      const beaverState = require('./beaverState');
      await beaverState.reportDailyKPIs(clientId, 'research_beaver', {
        sourced: verifiedLeads.length,
        avg_quality: scoringStats.avg_score,
        top_score: scoringStats.top_score,
        strategies_used: [...new Set(verifiedLeads.map(l => l.data_source))].length,
        queries_used: queriesUsed.length,
        rejection_rate_pct: deduped.length > 0
          ? Math.round((rejected.length / deduped.length) * 100)
          : null,
        verification_retries: retryCount,
      }).catch(() => {});
    } catch (err) {
      console.warn('[research] daily KPI report failed:', err.message);
    }

    return {
      leads:       verifiedLeads,
      queriesUsed,
      source:      'multi',
      pool_stats: {
        total_queries: queryPool.length,
        unused: unusedQueries.length,
        used: usedQueries.length,
        exhaustion_pct: Math.round(exhaustionRate * 100),
      },
      verification_stats: {
        candidates: deduped.length,                  // initial Layer 1 pool (BACKCOMPAT)
        candidates_total: candidatesVerifiedTotal,   // total fetched across all rounds (TRUTH)
        queries_total: queriesUsedTotal,             // total queries across all rounds
        rounds_ran: roundsRan,                       // initial pass + retry rounds
        circuit_breaker_tripped: circuitBreakerTripped, // reason if breaker tripped, else null
        verified: verified.length,
        rejected: rejected.length,
        rejection_reasons: rejected.map(r => `${r.name}: ${r.verification?.rejectReason || 'unknown'}`),
        rejection_summary: summarizeRejectionReasons(rejected),
        rejection_samples: rejectionSamples(rejected),
        retries: retryCount,
        search_rounds: searchRounds,
        circuit_breaker: circuitBreakerTripped,
        company_filtered_out: companyFilteredOutTotal,
      },
      scoring_stats: scoringStats,
    };
  } catch (err) {
    console.warn('[research] researchLeads total failure:', err.message);
    return emptyResult;
  }
}

module.exports = { researchLeads, buildQueryPool, verifyBatch, widenIcp };
