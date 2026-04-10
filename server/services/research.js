'use strict';

const pool = require('../db/pool');
const serperService = require('./searchService');
const hunterService = require('./hunter');

/* ─── Rotation pools ─────────────────────────────────────── */

const DEFAULT_TITLES = [
  'CEO', 'Founder', 'Co-Founder', 'Managing Director', 'Owner',
  'Director', 'MD', 'CTO', 'COO', 'Partner',
];

const DEFAULT_INDUSTRIES = [
  'consulting', 'agency', 'SaaS', 'training',
  'professional services', 'recruitment', 'marketing',
  'digital marketing', 'technology', 'software', 'fintech',
  'e-commerce', 'logistics', 'media', 'advertising',
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
  'ceo', 'founder', 'co-founder', 'director', 'md',
  'managing director', 'owner',
];

/* ─── Helpers ────────────────────────────────────────────── */

/**
 * Parse a comma-separated string OR an array into a trimmed array, ignoring empties.
 */
function parseCsvField(value) {
  if (!value) return [];
  // Already an array (from commandOverride injection)
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map(v => v.trim()).filter(Boolean);
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
    verified:       false,  // NEVER true from Serper — must pass Layer 2 verification
    data_source:    partial.data_source    || 'serper',
    snippet:        partial.snippet        || '',
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
};

function expandIndustry(industry) {
  const key = industry.toLowerCase().trim();
  return INDUSTRY_SEARCH_PHRASES[key] || [`"${industry}"`];
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
        ['Owner', 'Principal', 'Proprietor', 'Co-Founder', 'Partner'].forEach(x => expandedTitles.add(x));
      }
      if (/ceo/i.test(lower)) {
        ['Managing Director', 'MD', 'President', 'Chief Executive'].forEach(x => expandedTitles.add(x));
      }
      if (/director/i.test(lower)) {
        ['Head of', 'VP', 'Vice President'].forEach(x => expandedTitles.add(x));
      }
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
    // Last resort: generic B2B founders
    widened.industries = 'consulting, agency, saas, professional services, technology, b2b';
    widened.job_titles = 'Founder, CEO, Managing Director, Owner, Director';
  }

  return widened;
}

/* ─── Query pool ─────────────────────────────────────────── */

/**
 * QUERY POOL — generates all possible Serper queries from ICP config.
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

  const queryPool = [];

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
      // Geographic bias comes from gl:'my' in Serper only.
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
    }
  }

  // Strategy: buying signals (fewer, more targeted)
  // No location in query — "Sdn Bhd" + gl:'my' + Haiku handles Malaysia verification
  for (const phrase of uniquePhrases.slice(0, 6)) {
    queryPool.push({
      // searchLinkedInProfiles prepends site:linkedin.com/in — don't add it here
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
  }

  // Deduplicate by query string
  const seen = new Set();
  return queryPool.filter(item => {
    if (seen.has(item.query)) return false;
    seen.add(item.query);
    return true;
  });
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
 * Each candidate from Serper is UNVERIFIED. This layer uses
 * Hunter (structured data) + Haiku (AI classification) to verify
 * location, industry, and role independently.
 * Cost: ~$0.001 per Haiku call, Hunter included in plan.
 * ══════════════════════════════════════════════════════════════ */

let callAgent;
try {
  callAgent = require('./claude').callAgent;
} catch { callAgent = null; }

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

  // ── Haiku AI classification (the core verification) ──
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

CRITICAL: Do NOT count search query terms as evidence of location. Only count as Malaysia evidence: .my domain, "Sdn Bhd" or "Berhad" in company name, Malaysian city names in the company description or person's headline, Malay language markers. Generic mentions of "Malaysia" in snippets are unreliable.

Verify:
1. LOCATION: Is this person actually based in ${icp.geographies || 'Malaysia'}? Cite specific evidence.
2. INDUSTRY: Is this company actually in ${icp.industries || 'the target industry'}? Not just tangentially related.
3. ROLE: Is "${candidate.title}" actually a decision-maker role (${icp.job_titles || 'CEO/Founder/Director'})?

Return JSON:
{"location":"confirmed|likely|unlikely|unknown","location_evidence":"...","industry":"confirmed|likely|unlikely|unknown","industry_evidence":"...","role":"confirmed|likely|unlikely|unknown","confidence":0-100,"pass":true|false,"reason":"one line summary"}`;

      const result = await callAgent('research_beaver', prompt, { clientId });
      verification.haikuResult = result;

      if (result) {
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
        if (result.role === 'unlikely') {
          verification.rejectReason = `Role: not a decision-maker`;
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
      // If Haiku fails, rely on Hunter + regex signals only
    }
  }

  // ── Regex-based bonus signals (free, no API calls) ──
  const allText = `${candidate.name} ${candidate.company} ${candidate.title} ${candidate.snippet}`;
  if (/sdn\s*bhd|berhad/i.test(allText)) verification.score += 5;

  // ── Final decision ──
  if (verification.score >= 50) {
    verification.pass = true;
  } else if (verification.score >= 30) {
    verification.pass = true; // lower confidence, but save with P3 tier
    candidate.signal_tier = 'P3';
  } else {
    verification.pass = false;
    verification.rejectReason = verification.rejectReason || `Score too low (${verification.score})`;
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

/* ─── Strategy 1: Direct LinkedIn people search ──────────── */

/**
 * STRATEGY 1: Direct LinkedIn people search.
 * Serper: site:linkedin.com/in [title] [industry] [location]
 */
async function strategyDirectPeople(query, limit) {
  try {
    const results = await serperService.searchLinkedInProfiles(query, limit);
    return results.map(r => normaliseLead({
      ...r,
      data_source:  'serper',
      email_source: r.email ? 'serper' : '',
    }));
  } catch (err) {
    console.warn('[research] Strategy 1 (direct people) failed:', err.message);
    return [];
  }
}

/* ─── Strategy 2: Company-first search ───────────────────── */

/**
 * STRATEGY 2: Company-first search.
 * Step 1 — Serper: site:linkedin.com/company [industry] [location]
 * Step 2 — For each company: Hunter domainSearch to find decision-makers.
 * Returns leads with real emails where Hunter finds them.
 */
async function strategyCompanyFirst(clientId, icpMemory, limit) {
  const leads = [];

  try {
    // Pull company queries from the query pool
    const queryPool = buildQueryPool(icpMemory);
    const companyQueries = queryPool
      .filter(q => q.strategy === 'company')
      .slice(0, 3); // cap at 3 company queries to limit API spend

    for (const item of companyQueries) {
      try {
        // Step 1: find company LinkedIn pages via Serper.
        // Pass item.industry (just the phrase) — searchLinkedInCompanies prepends
        // "site:linkedin.com/company" itself. Passing item.query would double it.
        const searchPhrase = `${item.industry} "Sdn Bhd"`;
        const companyResults = await serperService.searchLinkedInCompanies
          ? serperService.searchLinkedInCompanies(searchPhrase, 3)
          : Promise.resolve([]);

        const companies = await companyResults;

        for (const c of companies) {
          const companyName = c.company || c.name || '';
          const domain = c.website || c.domain || '';

          if (!companyName && !domain) continue;

          // Step 2: Hunter domain search
          let hunterLeads = [];
          try {
            hunterLeads = await hunterService.domainSearch(clientId, {
              company: companyName,
              domain:  domain || undefined,
              limit:   3,
            });
          } catch (hErr) {
            console.warn('[research] Hunter domainSearch error:', hErr.message);
          }

          // Filter Hunter results by ICP-relevant titles
          const filtered = hunterLeads.filter(h => {
            if (!h.title) return false;
            const t = h.title.toLowerCase();
            return ICP_TITLE_KEYWORDS.some(kw => t.includes(kw));
          });

          if (filtered.length > 0) {
            for (const h of filtered) {
              leads.push(normaliseLead({
                name:           `${h.firstName || ''} ${h.lastName || ''}`.trim(),
                title:          h.title || '',
                company:        companyName,
                linkedin_url:   h.linkedin_url || '',
                email:          h.email || '',
                email_verified: h.confidence >= 70,
                email_source:   h.email ? 'hunter_domain' : '',
                data_source:    'hunter_domain',
              }));
            }
          } else if (companyName) {
            // Fallback: Serper people search scoped to this company
            try {
              const fallbackQuery = `site:linkedin.com/in "${companyName}" CEO OR Founder`;
              const fallbackResults = await serperService.searchLinkedInProfiles(fallbackQuery, 3);
              for (const r of fallbackResults) {
                leads.push(normaliseLead({
                  ...r,
                  company:     companyName || r.company,
                  data_source: 'serper_company',
                  email_source: r.email ? 'serper' : '',
                }));
              }
            } catch (fbErr) {
              console.warn('[research] Strategy 2 fallback Serper failed:', fbErr.message);
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
 * Serper: "[location]" "[title]" "[signal]" site:linkedin.com/in
 */
async function strategySignalBased(query, limit) {
  try {
    const results = await serperService.searchLinkedInProfiles(query, limit);
    return results.map(r => normaliseLead({
      ...r,
      data_source:  'serper_signal',
      email_source: r.email ? 'serper' : '',
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
async function researchLeads(clientId, { icpMemory = {}, targetCount = 5, batchIndex = 0, commandOverride = '' } = {}) {
  const emptyResult = { leads: [], queriesUsed: [], source: 'multi' };

  try {
    // 1. Load used queries
    const usedSet = await loadUsedQueries(clientId);

    // 2. Build query pool — if user gave a specific command, extract keywords and override ICP
    let effectiveIcp = icpMemory;
    if (commandOverride) {
      // Extract industry/role keywords from the command to override ICP defaults
      const cmd = commandOverride.toLowerCase();
      const extractedIndustries = [];
      const extractedTitles = [];

      // Common industry keywords
      const industryKeywords = [
        'marketing', 'agency', 'digital', 'property', 'proptech', 'fintech', 'saas',
        'ecommerce', 'e-commerce', 'edtech', 'healthtech', 'logistics', 'f&b', 'food',
        'consulting', 'recruitment', 'hr', 'legal', 'accounting', 'insurance',
        'media', 'creative', 'design', 'tech', 'software', 'it', 'seo', 'advertising',
      ];
      for (const kw of industryKeywords) {
        if (cmd.includes(kw)) extractedIndustries.push(kw);
      }

      // Common title keywords
      const titleKeywords = [
        'founder', 'ceo', 'coo', 'cmo', 'cto', 'director', 'md', 'managing director',
        'co-founder', 'owner', 'partner', 'head of', 'vp', 'president',
      ];
      for (const kw of titleKeywords) {
        if (cmd.includes(kw)) extractedTitles.push(kw);
      }

      // Override ICP with extracted keywords (command takes priority)
      if (extractedIndustries.length > 0 || extractedTitles.length > 0) {
        effectiveIcp = {
          ...icpMemory,
          ...(extractedIndustries.length > 0 ? { industries: extractedIndustries } : {}),
          ...(extractedTitles.length > 0 ? { job_titles: extractedTitles } : {}),
        };
        console.log(`[research] Command override: industries=${extractedIndustries.join(',')}, titles=${extractedTitles.join(',')}`);
      }
    }

    const queryPool = buildQueryPool(effectiveIcp);

    // 3. Pick next N unused queries (N = targetCount * 2, min 6)
    const pickCount = Math.max(targetCount * 2, 6);

    // Separate unused from used
    const unusedQueries = queryPool.filter(q => !usedSet.has(q.query));
    const usedQueries   = queryPool.filter(q =>  usedSet.has(q.query));

    // Pool exhaustion detection — warn when most queries have been used
    const exhaustionRate = queryPool.length > 0 ? usedQueries.length / queryPool.length : 0;
    if (exhaustionRate > 0.8) {
      console.warn(`[research] Query pool ${Math.round(exhaustionRate * 100)}% exhausted (${usedQueries.length}/${queryPool.length}). Consider different ICP keywords.`);
    }

    // Prefer unused; fall back to used if pool is exhausted
    const combined = [...unusedQueries, ...usedQueries];

    // Apply batchIndex offset so repeated calls rotate through the pool
    // Cap pick count to available unique queries to prevent duplicates
    const safeLength = Math.max(combined.length, 1);
    const safePick = Math.min(pickCount, combined.length);
    const offset = safePick > 0 ? (batchIndex * safePick) % safeLength : 0;
    const rotated = [...combined.slice(offset), ...combined.slice(0, offset)];
    const picked  = rotated.slice(0, safePick);

    // 4. Split by strategy
    const directQueries      = picked.filter(q => q.strategy === 'direct');
    const signalQueries      = picked.filter(q => q.strategy === 'signal');
    const signalJobsQueries  = picked.filter(q => q.strategy === 'signal_jobs');
    const signalNewsQueries  = picked.filter(q => q.strategy === 'signal_news');
    const signalGrowthQueries = picked.filter(q => q.strategy === 'signal_growth');
    // Company queries are handled inside strategyCompanyFirst via buildQueryPool

    // 5 & 6. Run all strategies in parallel
    const allSignalCount = signalQueries.length + signalJobsQueries.length + signalNewsQueries.length + signalGrowthQueries.length;
    const perQueryLimit = Math.max(Math.ceil(targetCount / Math.max(directQueries.length + allSignalCount, 1)), 2);

    const directPromises = directQueries.map(q =>
      strategyDirectPeople(q.query, perQueryLimit)
        .catch(err => {
          console.warn('[research] Direct query failed:', err.message);
          return [];
        })
    );

    const signalPromises = signalQueries.map(q =>
      strategySignalBased(q.query, perQueryLimit)
        .catch(err => {
          console.warn('[research] Signal query failed:', err.message);
          return [];
        })
    );

    // Buying signal queries — tag matched leads with signal + why_now
    const signalJobsPromises = signalJobsQueries.map(q =>
      strategySignalBased(q.query, perQueryLimit)
        .then(leads => leads.map(l => ({
          ...l,
          signal: l.signal || `Hiring signal: ${q.industry} company in ${q.location} is actively hiring`,
          why_now: l.why_now || `Hiring activity detected via job posting for "${q.industry}" in ${q.location} — likely scaling team now`,
          data_source: 'serper_signal_jobs',
        })))
        .catch(err => {
          console.warn('[research] Signal-jobs query failed:', err.message);
          return [];
        })
    );

    const signalNewsPromises = signalNewsQueries.map(q =>
      strategySignalBased(q.query, perQueryLimit)
        .then(leads => leads.map(l => ({
          ...l,
          signal: l.signal || `Growth signal: ${q.industry} company in ${q.location} recently hired, raised, or launched`,
          why_now: l.why_now || `Recent growth event detected for "${q.industry}" company in ${q.location} — timing is right for outreach`,
          data_source: 'serper_signal_news',
        })))
        .catch(err => {
          console.warn('[research] Signal-news query failed:', err.message);
          return [];
        })
    );

    const signalGrowthPromises = signalGrowthQueries.map(q =>
      strategyCompanyFirst(clientId, { ...icpMemory, industries: q.industry }, 3)
        .then(leads => leads.map(l => ({
          ...l,
          signal: l.signal || `Growth signal: ${q.industry} company in ${q.location} showing employee growth`,
          why_now: l.why_now || `Team expansion detected for "${q.industry}" company in ${q.location}`,
          data_source: l.data_source || 'serper_signal_growth',
        })))
        .catch(err => {
          console.warn('[research] Signal-growth query failed:', err.message);
          return [];
        })
    );

    const companyPromise = strategyCompanyFirst(clientId, icpMemory, targetCount)
      .catch(err => {
        console.warn('[research] Company-first strategy failed:', err.message);
        return [];
      });

    const [directResults, signalResults, signalJobsResults, signalNewsResults, signalGrowthResults, companyLeads] = await Promise.all([
      Promise.all(directPromises).then(arrays => arrays.flat()),
      Promise.all(signalPromises).then(arrays => arrays.flat()),
      Promise.all(signalJobsPromises).then(arrays => arrays.flat()),
      Promise.all(signalNewsPromises).then(arrays => arrays.flat()),
      Promise.all(signalGrowthPromises).then(arrays => arrays.flat()),
      companyPromise,
    ]);

    // 7. Merge and deduplicate by linkedin_url
    // Signal-tagged leads are prioritised (they come first, dedup keeps first occurrence)
    const allLeads = [
      ...signalJobsResults,   // P1: active hiring signal
      ...signalNewsResults,   // P1: growth event signal
      ...signalGrowthResults, // P2: growth signal
      ...signalResults,       // P2: signal-based
      ...directResults,       // P3: direct people
      ...companyLeads,        // P3: company-first
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
    const queriesUsed = picked.map(q => q.query);
    console.log(`[research] Layer 1 complete: ${preFiltered.length} candidates (from ${deduped.length} raw). Starting Layer 2 verification...`);

    const icp = effectiveIcp || {};
    let { verified, rejected } = await verifyBatch(preFiltered, icp, clientId);

    console.log(`[research] Layer 2 complete: ${verified.length} verified, ${rejected.length} rejected`);

    // ── Phase B3: Retry + expansion ladder ──
    // Retry up to MAX_RETRIES times. If the pool is exhausted or zero new candidates
    // come back, WIDEN the ICP progressively instead of giving up.
    //
    // Levels: 0 (strict) → 1 (+titles) → 2 (+industries) → 3 (+geo) → 4 (generic B2B)
    const MAX_RETRIES = 5;
    let retryCount = 0;
    let expansionLevel = 0;
    const allVerifiedUrls = new Set(verified.map(l => l.linkedin_url).filter(Boolean));

    while (verified.length < targetCount && retryCount < MAX_RETRIES) {
      retryCount++;
      const shortfall = targetCount - verified.length;
      console.log(`[research] Retry ${retryCount}/${MAX_RETRIES}: need ${shortfall} more verified leads (expansion level ${expansionLevel})`);

      // Use widened ICP if we've escalated
      const currentIcp = expansionLevel > 0 ? widenIcp(effectiveIcp, expansionLevel) : effectiveIcp;
      const freshPool = buildQueryPool(currentIcp);
      const freshSeen = new Set(usedSet);
      const freshUnused = freshPool.filter(q => !freshSeen.has(q.query));

      // If the current expansion level has no unused queries, escalate
      if (freshUnused.length === 0 && expansionLevel < 4) {
        expansionLevel++;
        console.log(`[research] Query pool exhausted at level ${expansionLevel - 1} — escalating to level ${expansionLevel}`);
        retryCount--; // this attempt was wasted, don't count it
        continue;
      }

      // Pick next batch of unused queries
      const actualPicked = freshUnused.slice(0, Math.min(pickCount, freshUnused.length));

      const retryDirectQueries = actualPicked.filter(q => q.strategy === 'direct');
      const retrySignalQueries = actualPicked.filter(q =>
        q.strategy === 'signal' || q.strategy === 'signal_jobs' || q.strategy === 'signal_news' || q.strategy === 'signal_growth'
      );

      const retryResults = await Promise.all([
        ...retryDirectQueries.map(q => strategyDirectPeople(q.query, perQueryLimit).catch(() => [])),
        ...retrySignalQueries.map(q => strategySignalBased(q.query, perQueryLimit).catch(() => [])),
      ]);

      const retryCandidates = retryResults.flat()
        .filter(l => l.linkedin_url && !allVerifiedUrls.has(l.linkedin_url));

      // Always mark queries as used to prevent repeat
      for (const q of actualPicked) usedSet.add(q.query);

      if (retryCandidates.length === 0) {
        console.log(`[research] Retry ${retryCount}: zero new candidates at level ${expansionLevel}`);
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

      // If this retry still couldn't produce verified leads → escalate
      if (retryVerification.verified.length === 0 && expansionLevel < 4) {
        expansionLevel++;
        console.log(`[research] Zero verified this batch — escalating expansion to level ${expansionLevel}`);
      }
    }

    // Mark verified leads
    const verifiedLeads = verified.slice(0, targetCount * 2).map(lead => ({
      ...lead,
      verified: true,
      metadata: {
        ...(lead.metadata || {}),
        verification: lead.verification,
        data_source: 'serper',
      },
    }));

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
        candidates: deduped.length,
        verified: verified.length,
        rejected: rejected.length,
        rejection_reasons: rejected.map(r => `${r.name}: ${r.verification?.rejectReason || 'unknown'}`),
        retries: retryCount,
      },
    };
  } catch (err) {
    console.warn('[research] researchLeads total failure:', err.message);
    return emptyResult;
  }
}

module.exports = { researchLeads, buildQueryPool, verifyBatch, widenIcp };
