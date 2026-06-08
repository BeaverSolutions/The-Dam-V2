import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const resolver = require('../../services/companyEvidenceResolver');
const signalHuntSource = readFileSync(resolve(__dirname, '../../services/signalHunt.js'), 'utf-8');

const icp = {
  active_industries: ['marketing agency', 'B2B corporate training'],
};

describe('company evidence resolver', () => {
  it('resolves configured verticals from existing free snippets', async () => {
    const result = await resolver.resolveCompanyEvidence({
      company: 'Acme Digital',
      raw_snippet: 'Acme Digital is a digital marketing agency in Malaysia hiring sales roles.',
    }, icp, { fetchImpl: async () => { throw new Error('fetch should not run'); } });

    expect(result).toMatchObject({
      company: 'Acme Digital',
      vertical_match: 'marketing agency',
      source: 'snippet',
      confidence: 0.8,
    });
    expect(result.evidence[0].text).toMatch(/digital marketing agency/i);
  });

  it('resolves configured verticals from a free about-page scrape and caches the result', async () => {
    resolver.clearCompanyEvidenceCache();
    let fetchCount = 0;
    const fetchImpl = async (url) => {
      fetchCount++;
      expect(url).toBe('https://acme.test/about');
      return {
        ok: true,
        text: async () => '<html><body>We are a creative digital marketing agency for B2B brands.</body></html>',
      };
    };

    const signal = {
      company: 'Acme Digital',
      company_website: 'https://acme.test',
    };
    const first = await resolver.resolveCompanyEvidence(signal, icp, { fetchImpl });
    const second = await resolver.resolveCompanyEvidence(signal, icp, { fetchImpl });

    expect(first.vertical_match).toBe('marketing agency');
    expect(first.source).toBe('about_page');
    expect(second.vertical_match).toBe('marketing agency');
    expect(second.from_cache).toBe(true);
    expect(fetchCount).toBe(1);
  });

  it('returns unresolved for random non-ICP company evidence', async () => {
    resolver.clearCompanyEvidenceCache();
    const result = await resolver.resolveCompanyEvidence({
      company: 'Air Products',
      raw_snippet: 'Air Products is hiring a business development manager for industrial gases.',
      company_website: 'https://air-products.test',
    }, icp, {
      fetchImpl: async () => ({
        ok: true,
        text: async () => '<html><body>Industrial gases and chemicals supplier.</body></html>',
      }),
    });

    expect(result).toMatchObject({
      company: 'Air Products',
      vertical_match: null,
      source: 'unresolved',
      confidence: 0,
    });
  });

  it('runs before the strict ICP gate and before paid decision-maker lookup', () => {
    const runStart = signalHuntSource.indexOf('async function runSignalHunt');
    const resolverIdx = signalHuntSource.indexOf('resolveCompanyEvidence(signal, icp', runStart);
    const gateIdx = signalHuntSource.indexOf('const companyGate = evaluateSignalCompanyIcpGate', runStart);
    const decisionMakerIdx = signalHuntSource.indexOf('const person = await findDecisionMaker', runStart);

    expect(resolverIdx).toBeGreaterThan(runStart);
    expect(resolverIdx).toBeLessThan(gateIdx);
    expect(resolverIdx).toBeLessThan(decisionMakerIdx);
    expect(signalHuntSource).toContain('company_vertical_unproven');
    expect(signalHuntSource).toContain('missing_company_icp_evidence');
  });
});
