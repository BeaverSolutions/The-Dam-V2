import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const emailEnrichmentSource = readFileSync(resolve(__dirname, '../../services/emailEnrichment.js'), 'utf-8');

function sourceBetween(startNeedle, endNeedle) {
  const start = emailEnrichmentSource.indexOf(startNeedle);
  expect(start).toBeGreaterThan(-1);
  const end = emailEnrichmentSource.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return emailEnrichmentSource.slice(start, end);
}

describe('email enrichment provider waterfall', () => {
  it('logs unconfigured free-provider skips before spend guard checks', () => {
    const anymailBody = sourceBetween('async function tryAnymail', 'async function tryIcypeas');
    const icypeasBody = sourceBetween('async function tryIcypeas', 'async function getSnovAccessToken');
    const snovBody = sourceBetween('async function trySnov', 'async function tryHunter');

    for (const [provider, body] of [
      ['anymail', anymailBody],
      ['icypeas', icypeasBody],
      ['snov', snovBody],
    ]) {
      const skipIdx = body.indexOf(`await logUnconfiguredProviderSkip('${provider}'`);
      const guardIdx = body.indexOf(`spendGuard.checkProvider('${provider}'`);

      expect(skipIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeGreaterThan(-1);
      expect(skipIdx).toBeLessThan(guardIdx);
    }
  });

  it('marks missing free-provider keys as zero-unit provider usage', () => {
    const helperBody = sourceBetween('async function logUnconfiguredProviderSkip', 'async function tryAnymail');

    expect(helperBody).toContain('spendGuard.logProviderUsage(provider');
    expect(helperBody).toContain('units: 0');
    expect(helperBody).toContain("status: 'unconfigured'");
    expect(helperBody).toContain("reason: 'missing_api_key'");
  });

  it('keeps Hunter after Anymail, Icypeas, and Snov in the paid-source waterfall', () => {
    const findEmailBody = sourceBetween('async function findEmail', 'module.exports =');
    const anymailIdx = findEmailBody.indexOf('const anymailResult = await tryAnymail');
    const icypeasIdx = findEmailBody.indexOf('const icypeasResult = await tryIcypeas');
    const snovIdx = findEmailBody.indexOf('const snovResult = await trySnov');
    const hunterIdx = findEmailBody.indexOf('const hunterResult = await tryHunter');

    expect(anymailIdx).toBeGreaterThan(-1);
    expect(icypeasIdx).toBeGreaterThan(anymailIdx);
    expect(snovIdx).toBeGreaterThan(icypeasIdx);
    expect(hunterIdx).toBeGreaterThan(snovIdx);
  });
});
