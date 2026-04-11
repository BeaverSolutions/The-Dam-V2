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

SEARCH QUERIES TO EXECUTE (use the web_search tool for each):
${queries.map((q, i) => `${i + 1}. ${q}`).join('\n')}

PROCESS:
1. Use web_search to run EACH query above
2. From the search results, extract real people who are decision-makers at real companies
3. Capture: name, job title, company name, LinkedIn URL (when present), any email visible in snippet, the buying signal you detected, why NOW is the right time
4. Stay focused on Malaysian / Southeast Asian companies (unless query specifies otherwise)

HARD REJECT:
- Roles: Intern, Junior, Assistant, Coordinator, Recruiter, HR Manager, QA, Student
- Locations outside Malaysia (unless query targets a different country)
- Generic listicles, job boards with no specific person, news roundups

OUTPUT FORMAT — CRITICAL:
After completing all searches, your final response must be ONLY a JSON array. No prose before. No prose after. No markdown fences. Just the array.

Example of the EXACT format expected:
[{"name":"Jane Doe","title":"CMO","company":"Acme Sdn Bhd","linkedin_url":"https://linkedin.com/in/jane","email":"","signal":"hiring 3 marketing roles","why_now":"job posted 2 days ago","snippet":"..."}]

If you find zero qualified leads, return: []

Begin searching now.`;

  // Use Sonnet 4.5 for the search call — web_search tool support is rock-solid
  // on Sonnet. Haiku 4.5 may or may not support web_search reliably; cost
  // delta is negligible at this scale (~$0.05/batch vs ~$0.005/batch).
  const SEARCH_MODEL = process.env.CLAW_SEARCH_MODEL || 'claude-sonnet-4-5-20250929';

  try {
    console.log(`[clawResearch] Calling ${SEARCH_MODEL} with web_search (max_uses=8)`);
    const response = await client.messages.create({
      model: SEARCH_MODEL,
      max_tokens: 4000,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 8,
        },
      ],
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    // Log block-type breakdown so we can see what came back
    const blockTypes = response.content.map(b => b.type).join(',');
    const stopReason = response.stop_reason;
    console.log(`[clawResearch] Response: stop_reason=${stopReason} blocks=[${blockTypes}]`);

    // Extract text from all text blocks (server tool blocks are handled by API)
    let extractedText = '';
    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        extractedText += block.text;
      }
    }

    if (!extractedText) {
      console.warn('[clawResearch] No text blocks in response — model may have stopped after tool use');
      return [];
    }

    // Log a snippet so we can see what's there
    console.log(`[clawResearch] Text response (first 300 chars): ${extractedText.substring(0, 300)}`);

    // Robust JSON extraction — handle markdown fences, JSON objects, JSON arrays
    let jsonStr = null;

    // Try 1: ```json [...] ``` code fence
    const fenceMatch = extractedText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();

    // Try 2: bare JSON array
    if (!jsonStr) {
      const arrMatch = extractedText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (arrMatch) jsonStr = arrMatch[0];
    }

    // Try 3: single JSON object → wrap in array
    if (!jsonStr) {
      const objMatch = extractedText.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = `[${objMatch[0]}]`;
    }

    if (!jsonStr) {
      console.warn('[clawResearch] No JSON found in text response');
      return [];
    }

    let leads;
    try {
      leads = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.warn(`[clawResearch] JSON parse failed: ${parseErr.message}`);
      console.warn(`[clawResearch] Attempted to parse: ${jsonStr.substring(0, 200)}`);
      return [];
    }

    // Some models return { leads: [...] } instead of bare array
    if (leads && !Array.isArray(leads) && Array.isArray(leads.leads)) leads = leads.leads;
    if (!Array.isArray(leads)) leads = [leads];

    console.log(`[clawResearch] Parsed ${leads.length} leads from response`);
    return leads.slice(0, targetCount * 2);
  } catch (err) {
    console.error(`[clawResearch] Search call failed: ${err.message}`);
    if (err.status) console.error(`[clawResearch] HTTP ${err.status}: ${err.error?.error?.message || ''}`);
    return [];
  }
}

/**
 * Verify lead + extract/enrich email via Hunter.
 */
async function verifyLead(clientId, lead) {
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
  if (lead.company && lead.name) {
    try {
      const nameParts = lead.name.trim().split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ');

      const result = await hunterService.findEmail(clientId, {
        firstName,
        lastName,
        company: lead.company,
      });

      if (result && result.email) {
        lead.email = result.email;
        score += 20;
        verification.score = score;
        verification.hunterMatch = result;
        return { verified: true, verification, email_verified: result.verified || 80, email_source: 'hunter', ...lead };
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
      candidates.map(c => verifyLead(clientId, normaliseLead(c)))
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
