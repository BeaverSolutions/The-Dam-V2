import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { isDbBuilderStale } = require('../../services/jobHealth.js');

describe('jobHealth db_builder schedule', () => {
  it('does not mark DB Builder stale during the planned gap between 08:30 and 13:00 MYT', () => {
    const lastRunAt = '2026-05-28T00:32:48.487Z';
    const now = new Date('2026-05-28T03:45:00.000Z').getTime();

    expect(isDbBuilderStale(lastRunAt, now)).toBe(false);
  });

  it('marks DB Builder stale after a scheduled window is missed', () => {
    const lastRunAt = '2026-05-27T05:02:00.000Z';
    const now = new Date('2026-05-28T01:00:00.000Z').getTime();

    expect(isDbBuilderStale(lastRunAt, now)).toBe(true);
  });

  it('does not mark DB Builder stale immediately inside the grace period', () => {
    const lastRunAt = '2026-05-27T05:02:00.000Z';
    const now = new Date('2026-05-28T00:45:00.000Z').getTime();

    expect(isDbBuilderStale(lastRunAt, now)).toBe(false);
  });
});
