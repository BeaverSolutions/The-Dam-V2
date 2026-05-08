'use strict';

/**
 * ============================================================
 * SIGNAL HUNT — Phase C: Signal-First Lead Generation
 * ============================================================
 *
 * Philosophy: signal is the INPUT, not a filter.
 *
 * Flow:
 *   1. Load signal_hunt_config from agent_memory for the client
 *      (or fall back to sensible defaults based on ICP)
 *   2. Run open-web searches for each signal query (funding, hiring, expansion)
 *   3. Use Haiku to parse company name + signal summary from each result
 *   4. For each extracted company, run LinkedIn people search to find founder/decision-maker
 *   5. Enrich with Hunter email
 *   6. Return leads with P1 tag + signal + why_now + angle
 *
 * These leads become the FIRST batch the outreach pipeline processes
 * before falling back to cold research.
 */

const pool = require('../db/pool');
const logsService = require('./logs');
const { searchOpenWeb, searchLinkedInProfiles } = require('./searchService');
const hunterService = require('./hunter');

// Default signal queries — used when no client-specific config exists.
// Phrased as Google search queries with SEA/MY bias.
const DEFAULT_SIGNAL_QUERIES = [
  // Hiring signals (strongest — means they're scaling)
  { query: '"hiring" "sales" "Malaysia" site:linkedin.com/jobs', signal_type: 'hiring_sales', tier: 'P1' },
  { query: '"hiring" "marketing" "Kuala Lumpur"', signal_type: 'hiring_marketing', tier: 'P1' },
  { query: '"hiring" "growth" OR "revops" Malaysia', signal_type: 'hiring_growth', tier: 'P1' },

  // Funding signals
  { query: '"raised" "Malaysia" "Series A" OR "seed round" 2026', signal_type: 'funding', tier: 'P1' },
  { query: '"Malaysia" startup "raised" OR "closed" funding 2026', signal_type: 'funding', tier: 'P1' },

  // Launch / expansion signals
  { query: '"launched" "Malaysia" B2B 2026', signal_type: 'launch', tier: 'P2' },
  { query: '"Malaysia" "expanding" OR "expansion" 2026', signal_type: 'expansion', tier: 'P2' },
  { query: '"Malaysia" "new CEO" OR "new Managing Director" 2026', signal_type: 'leadership_change', tier: 'P2' },
];

const SIGNAL_HUNT_CONFIG_KEY = 'signal_hunt_config';

/**
 * Load the client's signal hunt config, or return defaults.
 */
async function loadSignalConfig(clientId) {
  try {
    const { rows } = await pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND key = $2 LIMIT 1`,
      [clientId, SIGNAL_HUNT_CONFIG_KEY]
    );
    if (rows[0]?.content?.queries?.length > 0) {
      return rows[0].content;
    }
  } catch (err) {
    console.warn('[signalHunt] Failed to load config, using defaults:', err.message);
  }
  return {
    queries: DEFAULT_SIGNAL_QUERIES,
    max_results_per_query: 5,
  };
}

/**
 * Extract companies + signal data from search results using Haiku.
 */
async function extractSignalsFromResults(results, signal_type) {
  if (!results || results.length === 0) return [];

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    // No Anthropic SDK — return raw results with low confidence
    return results.map(r => ({
      company: '',
      signal_type,
      signal_summary: r.title,
      signal_date: r.date || '',
      source_url: r.link,
      raw_snippet: r.snippet,
      confidence: 0.4,
    }));
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const snippets = results.map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.link}${r.date ? `\nDate: ${r.date}` : ''}`
  ).join('\n\n');

  try {
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a buying signal detector. Analyse these search results and extract real buying signals for B2B outreach.

Signal type: ${signal_type}

Search results:
${snippets}

For each result containing a REAL buying signal from a Malaysian company, return JSON array:
[{
  "company": "Exact company name",
  "signal_type": "${signal_type}",
  "signal_summary": "One sentence: what happened and why it matters for outreach",
  "why_now": "One sentence: why NOW is the right time to reach out",
  "angle": "One sentence: the opening angle Sales Beaver should use",
  "signal_date": "YYYY-MM-DD or empty",
  "source_url": "the URL",
  "raw_snippet": "original snippet",
  "confidence": 0.0-1.0
}]

Rules:
- Only include REAL signals from Malaysian (MY) or SEA companies
- Ignore generic articles, listicles, job boards with no specific company
- Confidence 0.9 = very clear specific company + event, 0.5 = weak
- If no real signals found, return []
- Return ONLY the JSON array, nothing else`
      }],
    });

    const content = resp.content[0]?.text || '[]';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.warn('[signalHunt] Haiku parsing failed:', err.message);
  }

  return [];
}

/**
 * For a company with a signal, find the best decision-maker via LinkedIn.
 * Returns { name, title, linkedin_url } or null.
 */
async function findDecisionMaker(companyName, icpTitles = []) {
  if (!companyName) return null;

  const titleHints = icpTitles.length > 0 ? icpTitles.slice(0, 3).join(' OR ') : 'founder OR CEO OR director';
  const query = `"${companyName}" (${titleHints})`;

  try {
    const profiles = await searchLinkedInProfiles(query, 3);
    if (profiles.length === 0) return null;

    // Prefer the highest-seniority title
    const seniorityRank = (title) => {
      const t = (title || '').toLowerCase();
      if (/founder|ceo|co-founder/.test(t)) return 5;
      if (/managing director|md|president/.test(t)) return 4;
      if (/director|head of|vp/.test(t)) return 3;
      if (/manager|lead/.test(t)) return 2;
      return 1;
    };

    const sorted = profiles
      .filter(p => p.name && p.linkedin_url)
      .sort((a, b) => seniorityRank(b.title) - seniorityRank(a.title));

    return sorted[0] || null;
  } catch (err) {
    console.warn(`[signalHunt] findDecisionMaker failed for ${companyName}:`, err.message);
    return null;
  }
}

/**
 * Main entry point: run a signal hunt for a client.
 * Returns an array of lead objects ready for the outreach pipeline.
 *
 * @param {string} clientId
 * @param {object} options
 * @param {number} options.maxLeads - stop after finding this many leads (default 20)
 * @param {object} options.icp - ICP memory for seniority ranking
 * @returns {Promise<Array<Lead>>}
 */
async function runSignalHunt(clientId, { maxLeads = 20, icp = {} } = {}) {
  console.log(`[signalHunt] Starting signal hunt for client ${clientId} (target: ${maxLeads})`);

  const config = await loadSignalConfig(clientId);
  const allSignals = [];
  const leads = [];

  // Step 1: Run all signal queries in sequence (cost control)
  for (const q of config.queries) {
    if (allSignals.length >= maxLeads * 2) break; // 2x buffer — some will fail contact lookup

    console.log(`[signalHunt] Running query: ${q.query}`);
    try {
      const results = await searchOpenWeb(q.query, config.max_results_per_query || 5);
      if (results.length === 0) continue;

      const extracted = await extractSignalsFromResults(results, q.signal_type);
      const validSignals = extracted.filter(s => s.company && s.confidence >= 0.5);

      // Assign tier from the query config
      validSignals.forEach(s => { s.tier = q.tier || 'P2'; });
      allSignals.push(...validSignals);

      console.log(`[signalHunt] Query "${q.signal_type}" extracted ${validSignals.length} signals`);
    } catch (err) {
      console.warn(`[signalHunt] Query failed: ${err.message}`);
    }
  }

  console.log(`[signalHunt] Total signals extracted: ${allSignals.length}`);

  if (allSignals.length === 0) {
    return [];
  }

  // Step 2: Dedupe by company name
  const seenCompanies = new Set();
  const uniqueSignals = allSignals.filter(s => {
    const key = (s.company || '').toLowerCase().trim();
    if (!key || seenCompanies.has(key)) return false;
    seenCompanies.add(key);
    return true;
  });

  // Step 3: Sort P1 first
  uniqueSignals.sort((a, b) => {
    const rank = { P1: 3, P2: 2, P3: 1 };
    return (rank[b.tier] || 0) - (rank[a.tier] || 0);
  });

  // Step 4: For each signal, find the decision-maker
  const icpTitles = (icp.job_titles || icp.who || '').split(',').map(t => t.trim()).filter(Boolean);

  for (const signal of uniqueSignals.slice(0, maxLeads * 2)) {
    if (leads.length >= maxLeads) break;

    const person = await findDecisionMaker(signal.company, icpTitles);
    if (!person || !person.linkedin_url) {
      console.log(`[signalHunt] No decision-maker found for ${signal.company}`);
      continue;
    }

    // Step 5: Hunter email enrichment
    let email = null;
    let email_source = null;
    let email_verified = false;
    try {
      const nameParts = (person.name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';
      const hunter = await hunterService.findEmail(clientId, {
        firstName,
        lastName,
        company: signal.company,
      });
      if (hunter?.email) {
        email = hunter.email;
        email_source = 'hunter';
        email_verified = !!hunter.verified;
      }
    } catch (err) {
      console.warn(`[signalHunt] Hunter enrichment failed for ${person.name}:`, err.message);
    }

    leads.push({
      name: person.name,
      title: person.title || '',
      company: signal.company,
      linkedin_url: person.linkedin_url,
      email,
      email_source,
      email_verified,
      signal_tier: signal.tier,
      score: signal.tier === 'P1' ? 90 : 70,
      verified: true,
      data_source: 'signal_hunt',
      metadata: {
        signal: signal.signal_summary,
        why_now: signal.why_now,
        angle: signal.angle,
        signal_type: signal.signal_type,
        signal_source_url: signal.source_url,
        signal_confidence: signal.confidence,
        tier: signal.tier,
        source: 'signal_hunt',
      },
    });
  }

  await logsService.createLog(clientId, {
    agent: 'research_beaver',
    action: 'signal_hunt_complete',
    metadata: {
      total_signals: allSignals.length,
      unique_companies: uniqueSignals.length,
      leads_with_contacts: leads.length,
      tiers: leads.reduce((acc, l) => {
        acc[l.signal_tier] = (acc[l.signal_tier] || 0) + 1;
        return acc;
      }, {}),
    },
  }).catch(() => {});

  console.log(`[signalHunt] Returning ${leads.length} leads with decision-makers`);
  return leads;
}

/**
 * Save signal-sourced leads directly to the DB, bypassing the Captain gates
 * (signals are pre-qualified — they ARE the filter).
 */
async function saveSignalLeads(clientId, leads) {
  const saved = [];
  const contactGate = require('./contactGate');

  for (const lead of leads) {
    // Dedup check on LinkedIn URL
    if (lead.linkedin_url) {
      const dup = await pool.query(
        `SELECT id FROM leads WHERE client_id = $1 AND linkedin_url = $2 AND deleted_at IS NULL LIMIT 1`,
        [clientId, lead.linkedin_url]
      );
      if (dup.rows.length > 0) {
        console.log(`[signalHunt] Skipping duplicate: ${lead.linkedin_url}`);
        continue;
      }
    }

    // Tiered contact gate (migration 061, 2026-05-05): assigns A/B tier;
    // C rejected and logged. Signals are pre-qualified by intent but signal
    // alone doesn't grant Tier A — channel-presence still required.
    const gateResult = await contactGate.tryPersistSourcedLead(clientId, lead, {
      sourceStrategy: 'signal_hunt',
      allowLinkedinOnly: !!lead.linkedin_only_override,
    });
    if (!gateResult.passed) {
      console.log(`[signalHunt] Tier C ${lead.name} — reason: ${gateResult.missReason}`);
      continue;
    }
    const leadTier = gateResult.tier;

    // Phase 2 V2 Step 6 (2026-05-08): buying_signal_strength + signal_dated_at.
    // signalHunt is a SIGNAL-FIRST producer — by definition every lead it
    // sources has a buying signal in metadata. Default to 'rich' (the source
    // of truth IS the signal hunt) unless explicitly overridden, with the
    // signal date pulled from metadata.signal_dated_at if Research Beaver
    // emitted it, else NOW() (today's hunt).
    const buyingSignalStrength = lead.buying_signal_strength
      || lead.metadata?.buying_signal_strength
      || 'rich';
    const signalDatedAt = lead.signal_dated_at
      || lead.metadata?.signal_dated_at
      || new Date().toISOString();

    try {
      const res = await pool.query(
        `INSERT INTO leads (client_id, name, email, company, title, signal_tier, score, source,
                            pipeline_stage, status, email_verified, email_source, linkedin_url, metadata,
                            lead_tier, tiered_at,
                            buying_signal_strength, signal_dated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'signal_hunt','prospecting','new',$8,$9,$10,$11,$12,NOW(),$13,$14)
         RETURNING *`,
        [
          clientId, lead.name, lead.email || null, lead.company, lead.title || null,
          lead.signal_tier, lead.score,
          lead.email_verified, lead.email_source, lead.linkedin_url,
          JSON.stringify(lead.metadata || {}),
          leadTier,
          buyingSignalStrength, signalDatedAt,
        ]
      );
      if (res.rows.length > 0) saved.push(res.rows[0]);
    } catch (err) {
      console.error('[signalHunt] Failed to save signal lead:', err.message);
    }
  }

  return saved;
}

module.exports = { runSignalHunt, saveSignalLeads, loadSignalConfig };
