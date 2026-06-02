import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const service = (p) => readFileSync(resolve(__dirname, '../../', p), 'utf-8');
const signalHunt = require('../../services/signalHunt.js');

// Inline the pure helpers from signalHunt.js so we can execute them
// without touching DB or network. These match the source 1-for-1.
function listFrom(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
  return [];
}
function countryCodeFromText(value) {
  const s = String(value || '').toLowerCase();
  if (/\b(united states|usa|u\.s\.|us)\b/.test(s)) return 'US';
  if (/\b(singapore|sg)\b/.test(s)) return 'SG';
  if (/\b(malaysia|my|kuala lumpur|klang valley)\b/.test(s)) return 'MY';
  if (/\b(australia|au)\b/.test(s)) return 'AU';
  if (/\b(united kingdom|uk|great britain|gb|england)\b/.test(s)) return 'GB';
  return null;
}
function countryNameFromCode(code) {
  const c = String(code || '').toUpperCase();
  if (c === 'US') return 'United States';
  if (c === 'SG') return 'Singapore';
  if (c === 'AU') return 'Australia';
  if (c === 'GB' || c === 'UK') return 'United Kingdom';
  return 'Malaysia';
}
function countriesFromIcp(icp = {}) {
  const raw = [...listFrom(icp.geographies), ...listFrom(icp.geo), ...listFrom(icp.countries), ...listFrom(icp.locations), ...listFrom(icp.target_markets)];
  const countries = raw.map(v => countryCodeFromText(v)).filter(Boolean).map(code => ({ code, name: countryNameFromCode(code) }));
  const seen = new Set();
  const unique = countries.filter(c => { if (seen.has(c.code)) return false; seen.add(c.code); return true; });
  return unique.length > 0 ? unique : [{ code: 'MY', name: 'Malaysia' }];
}
function hasIcpSearchScope(icp = {}) {
  return [...listFrom(icp.industries), ...listFrom(icp.verticals), ...listFrom(icp.segments), ...listFrom(icp.geographies), ...listFrom(icp.geo), ...listFrom(icp.countries), ...listFrom(icp.locations), ...listFrom(icp.target_markets)].length > 0;
}
function industryPriority(value) {
  const s = String(value || '').toLowerCase();
  if (/\b(agency|digital|marketing|creative|media|advertising|professional service|consult)/i.test(s)) return 0;
  if (/\b(outbound|sales|growth|b2b service|smb|founder-led)/i.test(s)) return 1;
  if (/\b(training|learning|l&d|development)/i.test(s)) return 3;
  return 2;
}
function industriesFromIcp(icp = {}) {
  const raw = [...listFrom(icp.industries), ...listFrom(icp.verticals), ...listFrom(icp.segments)];
  const base = raw.length > 0 ? raw : ['B2B corporate training', 'digital agency'];
  const seen = new Set();
  return base
    .filter(value => {
      const key = String(value || '').trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => industryPriority(a) - industryPriority(b));
}
function buildSignalQueriesFromIcp(icp = {}) {
  const countries = countriesFromIcp(icp);
  const finalIndustries = industriesFromIcp(icp);
  const queries = [];
  for (const industry of finalIndustries) {
    for (const country of countries) {
      queries.push({ query: `"${industry}" "${country.name}" "hiring" "sales"`, signal_type: 'hiring_sales', tier: 'P1', country: country.code });
      queries.push({ query: `"${industry}" "${country.name}" ("expanding" OR "launched" OR "growth") founder OR CEO`, signal_type: 'growth_signal', tier: 'P1', country: country.code });
    }
  }
  return queries;
}
function normalizeSignalQuery(item, fallbackCountry = 'MY') {
  const raw = typeof item === 'string' ? { query: item } : (item || {});
  const query = String(raw.query || raw.search || raw.text || '').trim();
  if (!query) return null;
  const country = String(raw.country || countryCodeFromText(query) || fallbackCountry || 'MY').toUpperCase();
  return { query, signal_type: raw.signal_type || raw.type || 'buying_signal', tier: raw.tier || 'P2', country };
}
function queriesFromConfigContent(content) {
  if (Array.isArray(content?.queries) && content.queries.length > 0) return content.queries;
  const signalQueries = content?.signal_queries;
  if (Array.isArray(signalQueries)) return signalQueries;
  if (signalQueries && typeof signalQueries === 'object') {
    return Object.entries(signalQueries).flatMap(([signalType, value]) => {
      const items = Array.isArray(value) ? value : [value];
      return items.map(item => (typeof item === 'string' ? { query: item, signal_type: signalType } : { ...(item || {}), signal_type: item?.signal_type || signalType }));
    });
  }
  return [];
}

// ── Source contracts ──────────────────────────────────────────────────────
describe('signalHunt source contracts (ICP-first query priority)', () => {
  const src = service('services/signalHunt.js');
  const dbBuilderSrc = service('services/dbBuilder.js');
  const industriesFnStart = src.indexOf('function industriesFromIcp');
  const industriesFnEnd = src.indexOf('function hasIcpSearchScope', industriesFnStart);
  const industriesFn = src.slice(industriesFnStart, industriesFnEnd);

  it('ICP queries take priority over stored config and both over defaults', () => {
    expect(src).toContain('const icpQueries = hasIcpSearchScope(icp) ? buildSignalQueriesFromIcp(icp) : []');
    expect(src).toContain('const fallbackQueries = icpQueries.length > 0');
    expect(src).toContain('...icpQueries, ...configuredQueries');
  });

  it('uses the full ICP and does not slice to the first three industries', () => {
    expect(src).toContain('function industriesFromIcp');
    expect(industriesFn).not.toContain('.slice(0, 3)');
  });

  it('prioritizes agency/professional-services terms ahead of training terms', () => {
    expect(src).toContain('function industryPriority');
    expect(src).toContain('professional service');
    expect(src).toContain('training');
  });

  it('paid query budget consumed once per signal query (not doubled)', () => {
    expect(src).toContain('consumePaidQuery(1)');
    expect(src).not.toContain('consumePaidQuery(2)');
  });

  it('logs raw-zero blockers and blocks repeated zero-output query sets per day', () => {
    expect(src).toContain('function signalQuerySetHash');
    expect(src).toContain('signal_hunt_zero_query_set_');
    expect(src).toContain("'signal_hunt_zero_query_set_blocked'");
    expect(src).toContain("'repeated_zero_output_query_set'");
    expect(src).toContain("'raw_candidates_zero'");
    expect(src).toContain("'signals_zero_after_llm_parse'");
    expect(src).toContain("'contacts_zero'");
    expect(src).toContain('raw_results_total');
    expect(src).toContain('ON CONFLICT (client_id, agent, key) DO NOTHING');
  });

  it('saveSignalLeads routes through contactGate.tryPersistSourcedLead', () => {
    expect(src).toContain("contactGate.tryPersistSourcedLead(clientId, lead, {");
    expect(src).toContain("sourceStrategy: 'signal_hunt'");
  });

  it('saveSignalLeads sets buying_signal_strength to rich by default', () => {
    expect(src).toContain("|| 'rich'");
    expect(src).toContain('buying_signal_strength, signal_dated_at');
  });

  it('packages Signal Hunt leads with the V2.1 signal_package contract before save', () => {
    const packaged = signalHunt._test.attachSignalPackageToSignalLead({
      name: 'Jane Tan',
      title: 'Founder',
      company: 'Acme Training',
      linkedin_url: 'https://www.linkedin.com/in/janetan',
      email: 'jane@acmetraining.com',
      email_source: 'hunter',
      email_verified: true,
      data_source: 'signal_hunt',
      metadata: {
        signal: 'Acme Training is hiring sales roles in Kuala Lumpur',
        why_now: 'They are building sales capacity now',
        angle: 'Ask how founder-led outreach is being handled while hiring',
        signal_type: 'hiring_sales',
        signal_source_url: 'https://www.linkedin.com/jobs/view/123',
        signal_confidence: 0.92,
        country: 'Malaysia',
        source: 'signal_hunt',
      },
    }, { evidenceDate: '2026-06-03' });

    expect(packaged.metadata.signal_package).toMatchObject({
      signal_id: 'hiring_sales',
      signal_family: 'hiring_capability_build',
      source_channel: 'web_search',
      source_url: 'https://www.linkedin.com/jobs/view/123',
      evidence: 'Acme Training is hiring sales roles in Kuala Lumpur',
      evidence_date: '2026-06-03',
      why_now: 'They are building sales capacity now',
      decision_maker: {
        name: 'Jane Tan',
        title: 'Founder',
        source_url: 'https://www.linkedin.com/in/janetan',
      },
      contact: {
        email: 'jane@acmetraining.com',
        email_verified: true,
        email_source: 'hunter',
        linkedin_url: 'https://www.linkedin.com/in/janetan',
      },
    });
    expect(signalHunt._test.signalPackageMissingFields(packaged.metadata.signal_package)).toEqual([]);
  });

  it('refuses incomplete Signal Hunt packages before contactGate persistence', () => {
    const saveStart = src.indexOf('async function saveSignalLeads');
    const packageGate = src.indexOf('signalPackageMissingFields', saveStart);
    const contactGateCall = src.indexOf('contactGate.tryPersistSourcedLead', saveStart);

    expect(saveStart).toBeGreaterThan(-1);
    expect(packageGate).toBeGreaterThan(saveStart);
    expect(contactGateCall).toBeGreaterThan(packageGate);
    expect(src).toContain('missing_signal_package_before_signal_save');
  });

  it('applies Captain run_signal_playbook payloads to Signal Hunt query selection', () => {
    const config = {
      queries: [
        { query: '"agency" "Malaysia" "hiring" "sales"', signal_type: 'hiring_sales', tier: 'P1', country: 'MY' },
        { query: '"agency" "Malaysia" "expanding"', signal_type: 'growth_signal', tier: 'P1', country: 'MY' },
      ],
      query_source: 'current_icp',
      max_results_per_query: 3,
    };

    const planned = signalHunt._test.applySignalPlaybookToConfig(config, {
      signal_id: 'hiring_sales_roles',
      source_channel: 'linkedin_jobs',
      geo: ['MY'],
      cap: 1,
    });

    expect(planned.queries).toHaveLength(1);
    expect(planned.queries[0]).toMatchObject({
      signal_type: 'hiring_sales',
      source_channel: 'linkedin_jobs',
      signal_id: 'hiring_sales_roles',
    });
    expect(planned.query_source).toBe('current_icp_signal_playbook');
  });

  it('DB Builder consumes Research run_signal_playbook directives before pool health', () => {
    const researchDirectiveRead = dbBuilderSrc.indexOf("readPendingDirectives(client.id, 'research_beaver')");
    const playbookFilter = dbBuilderSrc.indexOf("directive_type === 'run_signal_playbook'");
    const runSignalHunt = dbBuilderSrc.indexOf('runSignalHunt(client.id', playbookFilter);
    const saveSignalLeads = dbBuilderSrc.indexOf('saveSignalLeads(client.id', playbookFilter);
    const healthCheck = dbBuilderSrc.indexOf('// Check pool health');

    expect(researchDirectiveRead).toBeGreaterThan(-1);
    expect(playbookFilter).toBeGreaterThan(researchDirectiveRead);
    expect(runSignalHunt).toBeGreaterThan(playbookFilter);
    expect(saveSignalLeads).toBeGreaterThan(runSignalHunt);
    expect(saveSignalLeads).toBeLessThan(healthCheck);
    expect(dbBuilderSrc).toContain('signal_playbook_consumed');
  });

  it('marks acted playbook directives before later budget-cap early returns', () => {
    const budgetCapLog = dbBuilderSrc.indexOf('Budget cap, skipping');
    const budgetCapReturn = dbBuilderSrc.indexOf('return;', budgetCapLog);
    const markConsumed = dbBuilderSrc.indexOf('markConsumed(client.id, consumedDirectiveIds)', budgetCapLog);

    expect(budgetCapLog).toBeGreaterThan(-1);
    expect(markConsumed).toBeGreaterThan(budgetCapLog);
    expect(markConsumed).toBeLessThan(budgetCapReturn);
  });
});

// ── Pure function unit tests ──────────────────────────────────────────────
describe('countriesFromIcp', () => {
  it('returns MY default when ICP has no geo fields', () => {
    expect(countriesFromIcp({})).toEqual([{ code: 'MY', name: 'Malaysia' }]);
  });

  it('extracts MY from Kuala Lumpur text', () => {
    const r = countriesFromIcp({ geographies: 'Kuala Lumpur, Malaysia' });
    expect(r.some(c => c.code === 'MY')).toBe(true);
  });

  it('deduplicates multiple references to the same country', () => {
    const r = countriesFromIcp({ geographies: 'Malaysia, Kuala Lumpur, MY' });
    expect(r.filter(c => c.code === 'MY').length).toBe(1);
  });

  it('extracts SG from Singapore text', () => {
    const r = countriesFromIcp({ countries: ['Singapore'] });
    expect(r.some(c => c.code === 'SG')).toBe(true);
  });
});

describe('buildSignalQueriesFromIcp', () => {
  it('produces industry x country cross-product (2 query types each)', () => {
    const r = buildSignalQueriesFromIcp({ industries: ['SaaS'], geographies: ['Malaysia'] });
    // 1 industry x 1 country x 2 query types = 2
    expect(r.length).toBe(2);
    expect(r[0].signal_type).toBe('hiring_sales');
    expect(r[1].signal_type).toBe('growth_signal');
  });

  it('includes country code on each query', () => {
    const r = buildSignalQueriesFromIcp({ industries: ['Agency'], countries: ['Singapore'] });
    expect(r.every(q => q.country === 'SG')).toBe(true);
  });

  it('does not drop later ICP verticals after the first three', () => {
    const r = buildSignalQueriesFromIcp({
      verticals: ['B2B corporate training', 'professional training', 'L&D providers', 'digital agency'],
      geographies: ['Malaysia'],
    });
    expect(r.some(q => q.query.includes('"digital agency"'))).toBe(true);
  });

  it('places agency/professional-services queries before training queries', () => {
    const r = buildSignalQueriesFromIcp({
      verticals: ['B2B corporate training', 'professional training', 'digital agency', 'professional services'],
      geographies: ['Malaysia'],
    });
    expect(r[0].query).toContain('"digital agency"');
    expect(r.findIndex(q => q.query.includes('"B2B corporate training"'))).toBeGreaterThan(
      r.findIndex(q => q.query.includes('"digital agency"'))
    );
  });
});

describe('normalizeSignalQuery', () => {
  it('returns null for empty/missing query string', () => {
    expect(normalizeSignalQuery({ query: '' })).toBeNull();
    expect(normalizeSignalQuery('')).toBeNull();
    expect(normalizeSignalQuery({})).toBeNull();
  });

  it('uppercases country code', () => {
    const r = normalizeSignalQuery({ query: 'test query', country: 'sg' });
    expect(r.country).toBe('SG');
  });

  it('falls back to MY for unresolvable country', () => {
    const r = normalizeSignalQuery({ query: 'test query with no country' }, 'MY');
    expect(r.country).toBe('MY');
  });

  it('infers country from query text', () => {
    const r = normalizeSignalQuery('"Malaysia" B2B hiring');
    expect(r.country).toBe('MY');
  });
});

describe('queriesFromConfigContent', () => {
  it('returns [] for null/empty content', () => {
    expect(queriesFromConfigContent(null)).toEqual([]);
    expect(queriesFromConfigContent({})).toEqual([]);
  });

  it('returns content.queries array when present', () => {
    const q = [{ query: 'test' }];
    expect(queriesFromConfigContent({ queries: q })).toBe(q);
  });

  it('reads signal_queries as object and normalises to array', () => {
    const r = queriesFromConfigContent({ signal_queries: { hiring: ['query A', 'query B'] } });
    expect(r.length).toBe(2);
    expect(r.every(x => x.signal_type === 'hiring')).toBe(true);
  });
});
