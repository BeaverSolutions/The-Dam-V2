import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const registry = require('../../services/platformRegistry');

describe('platform registry', () => {
  it('defines MY hiring platforms as separate tools, not one combined query', () => {
    const platforms = registry.platformsFor({ signalFamily: 'hiring_capability_build', geo: 'MY' });
    const ids = platforms.map(p => p.id);

    expect(ids).toEqual(expect.arrayContaining(['jobstreet_my', 'hiredly_my', 'linkedin_jobs']));
    expect(platforms.find(p => p.id === 'jobstreet_my')).toMatchObject({
      provider: 'brave',
      source_channel: 'job_boards',
      queryLimits: { maxChars: 400, maxWords: 50 },
    });
    expect(platforms.find(p => p.id === 'hiredly_my').evidenceRequired).toEqual(
      expect.arrayContaining(['company', 'role', 'source_url'])
    );
  });

  it('keeps press/news separate and lower priority for hiring proof', () => {
    const platforms = registry.platformsFor({ signalFamily: 'hiring_capability_build', geo: 'MY' });

    expect(platforms.findIndex(p => p.id === 'jobstreet_my')).toBeLessThan(
      platforms.findIndex(p => p.id === 'press_news')
    );
  });

  it('validates Brave query limits before execution', () => {
    const valid = registry.validateQuery('site:hiredly.com "sales" "training" "Malaysia"', 'brave');
    expect(valid).toMatchObject({ valid: true, chars: 46, words: 4 });
    expect(valid.query_hash).toMatch(/^[a-f0-9]{16}$/);

    const longQuery = `${'word '.repeat(51)}`.trim();
    const invalid = registry.validateQuery(longQuery, 'brave');
    expect(invalid.valid).toBe(false);
    expect(invalid.blocker).toBe('provider_query_limit_exceeded');
    expect(invalid.limits).toMatchObject({ maxChars: 400, maxWords: 50 });
  });
});
