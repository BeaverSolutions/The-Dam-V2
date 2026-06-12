import { createRequire } from 'module';
import { vi } from 'vitest';

const require = createRequire(import.meta.url);
const noaaHail = require('../../services/providers/noaaHail.js');

const REAL_SAMPLE = `Time,Size,Location,County,State,Lat,Lon,Comments
1202,175,2 N Attica,Marion,IA,41.26,-93.01,Pershing IOWA. (DMX)
1215,100,1 NNW Knoxville,Marion,IA,41.33,-93.11,(DMX)
1220,200,5 WSW Grant City,Worth,MO,40.47,-94.5,"Report relayed from social media, time estimated from radar. (EAX)"
bad,row
1305,75,Dime Hail,Knox,IL,40.00,-90.00,Below floor
`;

describe('NOAA SPC hail provider', () => {
  it('builds official today and dated SPC hail report URLs', () => {
    expect(noaaHail.buildSpcHailReportUrl()).toBe('https://www.spc.noaa.gov/climo/reports/today_hail.csv');
    expect(noaaHail.buildSpcHailReportUrl(new Date('2026-06-11T00:00:00Z'))).toBe(
      'https://www.spc.noaa.gov/climo/reports/260611_rpts_hail.csv'
    );
  });

  it('parses real SPC hail CSV rows defensively and skips malformed rows', () => {
    const rows = noaaHail.parseHailCsv(REAL_SAMPLE, {
      reportDate: '2026-06-11',
      sourceUrl: 'https://www.spc.noaa.gov/climo/reports/260611_rpts_hail.csv',
    });

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      time_utc: '1202',
      size_hundredths: 175,
      size_inches: 1.75,
      location: '2 N Attica',
      metro: 'Attica',
      county: 'Marion',
      state: 'IA',
      lat: 41.26,
      lon: -93.01,
      report_date: '2026-06-11',
      source_url: 'https://www.spc.noaa.gov/climo/reports/260611_rpts_hail.csv',
    });
    expect(rows[2].comments).toContain('time estimated from radar');
  });

  it('filters by minimum hail size and recency', () => {
    const rows = noaaHail.parseHailCsv(REAL_SAMPLE, { reportDate: '2026-06-11' });
    const filtered = noaaHail.filterHailReports(rows, {
      minSizeHundredths: 100,
      sinceDate: '2026-06-11',
    });

    expect(filtered.map(row => row.metro)).toEqual(['Attica', 'Knoxville', 'Grant City']);
    expect(filtered.every(row => row.size_hundredths >= 100)).toBe(true);
  });

  it('dedupes target metros and respects maxMetros bounds', () => {
    const rows = noaaHail.parseHailCsv(`${REAL_SAMPLE}1310,125,Knoxville,Marion,IA,41.31,-93.1,Duplicate metro\n`, {
      reportDate: '2026-06-11',
    });

    const metros = noaaHail.targetMetrosFromReports(rows, {
      minSizeHundredths: 100,
      maxMetros: 2,
    });

    expect(metros).toEqual([
      expect.objectContaining({ city: 'Grant City', state: 'MO', max_size_hundredths: 200 }),
      expect.objectContaining({ city: 'Attica', state: 'IA', max_size_hundredths: 175 }),
    ]);
  });

  it('caches fetched SPC day files instead of repeatedly hitting NOAA', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => REAL_SAMPLE,
    });
    const cache = new Map();

    const first = await noaaHail.fetchHailReportsForDate('2026-06-11', { fetchImpl, cache });
    const second = await noaaHail.fetchHailReportsForDate('2026-06-11', { fetchImpl, cache });

    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toContain('BeavrDam');
  });
});
