import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const signalHunt = require('../../services/signalHunt.js');

const source = (p) => readFileSync(resolve(__dirname, '../../', p), 'utf-8');

function hailReport(overrides = {}) {
  return {
    size_hundredths: 175,
    size_inches: 1.75,
    metro: 'Knoxville',
    county: 'Marion',
    state: 'IA',
    report_date: '2026-06-11',
    source_url: 'https://www.spc.noaa.gov/climo/reports/260611_rpts_hail.csv',
    ...overrides,
  };
}

describe('Signal Hunt NOAA hail lane', () => {
  it('asserts parser version v6 for the extraction/query-shape change', () => {
    expect(source('services/signalHunt.js')).toContain("SIGNAL_HUNT_PARSER_VERSION = 'universal_signal_planner_v6'");
  });

  it('builds bounded metro-scoped roofing discovery queries from NOAA hail events', () => {
    const queries = signalHunt._test.buildHailEventDiscoveryQueries([
      hailReport({ metro: 'Knoxville', state: 'IA' }),
      hailReport({ metro: 'Knoxville', state: 'IA', size_hundredths: 100, size_inches: 1 }),
      hailReport({ metro: 'Grant City', state: 'MO', county: 'Worth', size_hundredths: 200, size_inches: 2 }),
    ], {
      signal: {
        id: 'noaa_hail_roofing',
        family: 'pain_friction_evidence',
        stop_rules: { max_metros: 2, max_queries: 3 },
        evidence_required: ['company', 'pain', 'source_url'],
      },
      icp: { geo: ['United States'], active_industries: ['roofing contractors'] },
    });

    expect(queries).toHaveLength(3);
    expect(queries.map(q => q.query)).toEqual([
      '"roofing contractor" "Grant City" "MO"',
      '"roofing company" "Grant City" "MO"',
      '"roofing contractor" "Knoxville" "IA"',
    ]);
    expect(queries[0]).toMatchObject({
      provider: 'brave',
      country: 'US',
      source_channel: 'vertical_web',
      platform: 'vertical_web',
      discovery_mode: 'vertical_first',
      signal_id: 'noaa_hail_roofing',
      signal_family: 'pain_friction_evidence',
      expected_evidence: ['company', 'pain', 'source_url'],
      hail_event: expect.objectContaining({
        county: 'Worth',
        state: 'MO',
        source_url: 'https://www.spc.noaa.gov/climo/reports/260611_rpts_hail.csv',
      }),
    });
  });

  it('keeps the NOAA report as signal source_url while using the company page for identity resolution', () => {
    const [query] = signalHunt._test.buildHailEventDiscoveryQueries([hailReport()], {
      signal: { id: 'noaa_hail_roofing', family: 'pain_friction_evidence', stop_rules: { max_metros: 1, max_queries: 1 } },
      icp: { geo: ['United States'], active_industries: ['roofing contractors'] },
    });

    const [signal] = signalHunt._test.verticalFirstSignalsFromResults([
      {
        title: 'Knoxville Roofing Co | Residential Roofing',
        snippet: 'Knoxville Roofing Co is a local roofing contractor serving Marion County.',
        link: 'https://knoxvilleroofing.example/services',
      },
    ], query);

    expect(signal).toMatchObject({
      company: 'Knoxville Roofing Co',
      company_website: 'https://knoxvilleroofing.example',
      source_url: 'https://www.spc.noaa.gov/climo/reports/260611_rpts_hail.csv',
      signal_family: 'pain_friction_evidence',
      why_now: '1.75-inch hail reported in Marion, IA on 2026-06-11 (NOAA SPC)',
    });
    expect(signal.metadata.company_source_url).toBe('https://knoxvilleroofing.example/services');
  });

  it('preserves hail event fields through Signal Hunt query normalisation', () => {
    const normalized = signalHunt._test.normalizeSignalQuery({
      query: '"roofing contractor" "Knoxville" "IA"',
      provider: 'brave',
      platform: 'vertical_web',
      signal_type: 'noaa_hail_roofing',
      signal_id: 'noaa_hail_roofing',
      signal_family: 'pain_friction_evidence',
      source_channel: 'vertical_web',
      country: 'US',
      cost_class: 'paid_search',
      expected_evidence: ['company', 'pain', 'source_url'],
      industry: 'roofing contractor',
      term: 'roofing contractor',
      source_term: 'roofing contractor',
      parser: 'vertical_directory_company',
      discovery_mode: 'vertical_first',
      hail_event: hailReport(),
      why_now: '1.75-inch hail reported in Marion, IA on 2026-06-11 (NOAA SPC)',
      signal_summary: 'hail event summary',
      angle: 'storm response angle',
    });

    expect(normalized).toMatchObject({
      provider: 'brave',
      platform: 'vertical_web',
      discovery_mode: 'vertical_first',
      expected_evidence: ['company', 'pain', 'source_url'],
      hail_event: expect.objectContaining({ county: 'Marion', state: 'IA' }),
      why_now: '1.75-inch hail reported in Marion, IA on 2026-06-11 (NOAA SPC)',
      signal_summary: 'hail event summary',
      angle: 'storm response angle',
    });
  });

  it('passes tenant persona titles into decision-maker lookup title hints', () => {
    expect(signalHunt._test.titlesFromIcp({
      personas: ['Owner', 'Founder', 'President', 'CEO', 'Co-Owner'],
    })).toEqual(['Owner', 'Founder', 'President', 'CEO', 'Co-Owner']);
  });
});
