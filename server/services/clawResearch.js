'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const hunterService = require('./hunter');

/**
 * clawResearch.js — Research engine using Claude Haiku + web_search
 *
 * Replaces Serper + Hunter + Haiku pipeline with direct Claude API calls.
 * Uses Haiku (cheaper) for all web searches and lead extraction.
 * Falls back to Hunter for email domain enrichment when needed.
 *
 * API: researchLeads(clientId, { icpMemory, targetCount, batchIndex, commandOverride })
 * Returns: { leads: [...], queriesUsed: [...], source: 'web_search', pool_stats: {...}, verification_stats: {...} }
 */

let client;
try {
  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 30_000,
    maxRetries: 2,
  });
} catch (err) {
  console.warn('[clawResearch] Failed to initialise Anthropic client:', err.message);
}

/* ─── Helpers ────────────────────────────────────────────── */

/**
 * Normalise a lead to standard output shape.
 */
function normaliseLead(partial) {
  return {
    name: partial.name || '',
    title: partial.title || '',
    company: partial.company || '',
    linkedin_url: partial.linkedin_url || '',
    email: partial.email || '',
    email_verified: partial.email_verified || 0,
    email_source: partial.email_source || '',
    verified: partial.verified || false,
    data_source: partial.data_source || 'web_search',
    signal: partial.signal || '',
    why_now: partial.why_now || '',
    snippet: partial.snippet || '',
    metadata: partial.metadata || {},
  };
}

/**
 * Extract industry/title keywords from user command.
 * Used to override ICP if user provides specific direction.
 */
function extractCommandOverrides(command) {
  if (!command) return { industries: [], job_titles: [] };

  const cmd = command.toLowerCase();
  const extracted = { industries: [], job_titles: [] };

  const industryKeywords = [
    'marketing', 'agency', 'digital', 'property', 'proptech', 'fintech', 'saas',
    'ecommerce', 'e-commerce', 'edtech', 'healthtech', 'logistics', 'f&b', 'food',
    'consulting', 'recruitment', 'hr', 'legal', 'accounting', 'insurance',
    'media', 'creative', 'design', 'tech', 'software', 'it', 'seo', 'advertising',
  ];
  for (const kw of industryKeywords) {
    if (cmd.includes(kw)) extracted.industries.push(kw);
  }

  const titleKeywords = [
    'founder', 'ceo', 'coo', 'cmo', 'cto', 'director', 'md', 'managing director',
    'co-founder', 'owner', 'partner', 'head of', 'vp', 'president',
  ];
  for (const kw of titleKeywords) {
    if (cmd.includes(kw)) extracted.job_titles.push(kw);
  }

  return extracted;
}

/**
 * Build search queries for Haiku to execute via web_search.
 * Supports batch rotation so repeated calls vary the queries.
 */
function buildSearchQueries(icp, batchIndex = 0) {
  const industries = icp.industries || [];
  const titles = icp.job_titles || [];
  const locations = icp.geographies || ['Malaysia'];
  const signalTypes = icp.signal_types || ['hiring', 'funding', 'product launch'];

  const queries = [];
  const queryCount = Math.max(industries.length * titles.length, 6);

  // LinkedIn profile searches
  for (let i = 0; i < Math.min(3, industries.length); i++) {
    const industry = industries[(batchIndex + i) % industries.length];
    for (let j = 0; j < Math.min(2, titles.length); j++) {
      const title = titles[(batchIndex + j) % titles.length];
      const location = locations[j % locations.length];
      queries.push(`site:linkedin.com/in ${title} ${industry} ${location}`);
    }
  }

  // Hiring signal queries
  for (let i = 0; i < 2; i++) {
    const industry = industries[i % industries.length];
    const location = locations[i % locations.length];
    queries.push(`${industry} company hiring ${location} 2026`);
  }

  // Funding signal queries
  queries.push(`${industries[0] || 'technology'} company funding round 2025 2026`);
  queries.push(`startups ${locations[0] || 'Malaysia'} Series A Series B`);

  // Dedup and return first 8
  const unique = [...new Set(queries)];
  return unique.slice(0, 8);
}

/**
 * Call Haiku with web_search to find leads matching ICP.
 * Returns raw search results + extracted leads.
 */
async function searchAndExtractLeads(queries, icp, targetCount = 10) {
  if (!client) throw new Error('Anthropic client not initialised');

  const prompt = `You are a lead research expert. You will execute the following search queries and extract qualified decision-makers.

SEARCH QUERIES:
${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}

INSTRUCTIONS:
1. Execute each search query using web_search
2. For each result, extract:
   - Full name
   - Job title
   - Company name
   - LinkedIn profile URL (if found)
   - Email (if visible in result snippet)
   - What signal this person/company shows (hiring, funding, growth, etc.)
   - When was the signal detected (e.g., "3 days ago", "2 weeks ago")

3. HARD REJECT these roles:
   - Intern, Junior, Assistant, Coordinator, Recruiter, HR Manager, QA
   - Anyone with "student" or "recent graduate" in title

4. HARD REJECT these locations (unless Malaysia mentioned):
   - Singapore, Hong Kong, India, Indonesia, Thailand, Philippines (unless founder in Malaysia)

5. OUTPUT: Return ONLY a JSON array of leads, no explanation:
[
  {
    "name": "Jane Doe",
    "title": "Chief Marketing Officer",
    "company": "TechCorp Malaysia",
    "linkedin_url": "https://linkedin.com/in/jane-doe",
    "email": "jane@techcorp.com.my",
    "signal": "Hiring 3 marketing roles",
    "why_now": "Job posting on LinkedIn 2 days ago",
    "snippet": "...",
    "verified": false
  }
]

Return valid JSON only. No markdown, no explanation.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4.5-20250101',
      max_tokens: 4000,
      tools: [
        {
          name: 'web_search',
          description: 'Search the web for current information',
          input_schema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query',
              },
            },
            required: ['query'],
          },
        },
      ],
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    // Parse the response — Haiku may use tool_use blocks or return JSON directly
    let extractedText = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        extractedText += block.text;
      }
    }

    // Try to parse JSON from response
    const jsonMatch = extractedText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('[clawResearch] No JSON found in Haiku response');
      return [];
    }

    const leads = JSON.parse(jsonMatch[0]);
    return Array.isArray(leads) ? leads.slice(0, targetCount * 2) : [];
  } catch (err) {
    console.error('[clawResearch] Haiku search failed:', err.message);
    return [];
  }
}

/**
 * Verify lead + extract/enrich email via Hunter.
 */
async function verifyLead(lead) {
  const verification = {
    score: 0,
    pass: true,
    hunterMatch: null,
    haikuResult: null,
    rejectReason: null,
  };

  // Hard reject rules
  const rejectRoles = ['intern', 'junior', 'assistant', 'coordinator', 'recruiter', 'qa'];
  const title = (lead.title || '').toLowerCase();
  if (rejectRoles.some(role => title.includes(role))) {
    verification.pass = false;
    verification.rejectReason = `Role: ${lead.title} is excluded`;
    return { verified: false, verification, ...lead };
  }

  // Score based on what we have
  let score = 50; // Base score for being a decision-maker

  // LinkedIn URL is valuable
  if (lead.linkedin_url) score += 15;

  // Email already present
  if (lead.email) {
    score += 20;
    verification.score = score;
    verification.pass = true;
    return { verified: true, verification, email_verified: 85, email_source: 'web_search', ...lead };
  }

  // Try Hunter for email enrichment
  if (lead.company) {
    try {
      const domain = await hunterService.findDomain(lead.company);
      if (domain) {
        verification.hunterMatch = domain;
        const email = await hunterService.findEmail(lead.name, domain);
        if (email && email.email) {
          lead.email = email.email;
          score += 20;
          verification.score = score;
          return { verified: true, verification, email_verified: 90, email_source: 'hunter', ...lead };
        }
      }
    } catch (err) {
      console.warn('[clawResearch] Hunter lookup failed for', lead.company, err.message);
    }
  }

  // No email found — P2 lead (needs enrichment)
  if (score >= 50) {
    verification.score = score;
    verification.pass = true;
    return { verified: true, verification, email_verified: 0, email_source: '', ...lead };
  }

  verification.pass = false;
  verification.rejectReason = 'Insufficient verification score';
  return { verified: false, verification, ...lead };
}

/**
 * Main export — drops into research.js's researchLeads() slot.
 */
async function researchLeads(clientId, { icpMemory = {}, targetCount = 5, batchIndex = 0, commandOverride = '' } = {}) {
  const emptyResult = { leads: [], queriesUsed: [], source: 'web_search' };

  try {
    // 1. Build effective ICP (command override takes priority)
    let effectiveIcp = { ...icpMemory };
    if (commandOverride) {
      const overrides = extractCommandOverrides(commandOverride);
      if (overrides.industries.length > 0) effectiveIcp.industries = overrides.industries;
      if (overrides.job_titles.length > 0) effectiveIcp.job_titles = overrides.job_titles;
      console.log(`[clawResearch] Command override: industries=${overrides.industries.join(',')}, titles=${overrides.job_titles.join(',')}`);
    }

    // 2. Build search queries (with batch rotation for variation)
    const queries = buildSearchQueries(effectiveIcp, batchIndex);
    console.log(`[clawResearch] Built ${queries.length} searches for batch ${batchIndex}`);

    // 3. Execute searches + extract candidates
    const candidates = await searchAndExtractLeads(queries, effectiveIcp, targetCount);
    console.log(`[clawResearch] Found ${candidates.length} candidates from searches`);

    if (candidates.length === 0) {
      return emptyResult;
    }

    // 4. Verify each lead + enrich emails
    const verificationResults = await Promise.all(
      candidates.map(c => verifyLead(normaliseLead(c)))
    );

    const verified = verificationResults.filter(l => l.verified);
    const rejected = verificationResults.filter(l => !l.verified);

    console.log(`[clawResearch] Verified: ${verified.length}, Rejected: ${rejected.length}`);

    // 5. Tag signal tier (P1 = high confidence, P2 = some signal, P3 = weak)
    const tieredLeads = verified.slice(0, targetCount * 2).map(lead => {
      let signal_tier = 'P2';
      if (lead.email && lead.signal && (lead.signal.includes('hiring') || lead.signal.includes('funding'))) {
        signal_tier = 'P1';
      } else if (!lead.email || !lead.signal) {
        signal_tier = 'P3';
      }

      return {
        ...lead,
        signal_tier,
        metadata: {
          ...(lead.metadata || {}),
          verification: lead.verification,
          data_source: 'web_search',
        },
      };
    });

    // 6. Return in research.js-compatible format
    return {
      leads: tieredLeads,
      queriesUsed: queries,
      source: 'web_search',
      pool_stats: {
        queries_executed: queries.length,
        candidates_found: candidates.length,
        verified: verified.length,
        exhaustion_pct: 0, // N/A for Haiku (unlimited queries)
      },
      verification_stats: {
        candidates: candidates.length,
        verified: verified.length,
        rejected: rejected.length,
        rejection_reasons: rejected.map(r => `${r.name}: ${r.verification?.rejectReason || 'unknown'}`),
        retries: 0,
      },
    };
  } catch (err) {
    console.error('[clawResearch] researchLeads failed:', err.message);
    return emptyResult;
  }
}

module.exports = { researchLeads };
