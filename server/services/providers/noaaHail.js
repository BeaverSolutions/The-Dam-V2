'use strict';

const SPC_REPORT_BASE = 'https://www.spc.noaa.gov/climo/reports';
const DEFAULT_USER_AGENT = 'BeavrDam/2.0 signal-engine (+https://app.beaver.solutions)';
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const inMemoryCache = new Map();

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dateFromInput(value = new Date()) {
  if (value instanceof Date) return value;
  return new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
}

function isoDate(value = new Date()) {
  const date = dateFromInput(value);
  return date.toISOString().slice(0, 10);
}

function spcDateCode(value) {
  const date = dateFromInput(value);
  return `${pad2(date.getUTCFullYear() % 100)}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

function buildSpcHailReportUrl(date = null) {
  if (!date) return `${SPC_REPORT_BASE}/today_hail.csv`;
  return `${SPC_REPORT_BASE}/${spcDateCode(date)}_rpts_hail.csv`;
}

function parseCsvLine(line = '') {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map(cell => cell.trim());
}

function cleanMetroFromLocation(location = '') {
  let value = String(location || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  value = value.replace(/^\d+(?:\.\d+)?\s+(?:N|S|E|W|NE|NW|SE|SW|NNE|NNW|SSE|SSW|ENE|ESE|WNW|WSW)\s+/i, '');
  return value.replace(/^[,\s-]+|[,\s-]+$/g, '').trim();
}

function parseNumber(value) {
  const n = Number(String(value || '').trim());
  return Number.isFinite(n) ? n : null;
}

function parseHailCsv(csv = '', { reportDate = null, sourceUrl = null } = {}) {
  const lines = String(csv || '').split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length <= 1) return [];
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells.length < 8) continue;
    const [time, size, location, county, state, lat, lon, comments] = cells;
    const sizeHundredths = parseNumber(size);
    const latitude = parseNumber(lat);
    const longitude = parseNumber(lon);
    if (!time || !location || !county || !state || sizeHundredths === null || latitude === null || longitude === null) continue;
    rows.push({
      time_utc: String(time).padStart(4, '0'),
      size_hundredths: sizeHundredths,
      size_inches: Number((sizeHundredths / 100).toFixed(2)),
      location: String(location).trim(),
      metro: cleanMetroFromLocation(location),
      county: String(county).trim(),
      state: String(state).trim().toUpperCase(),
      lat: latitude,
      lon: longitude,
      comments: String(comments || '').trim(),
      report_date: reportDate ? isoDate(reportDate) : null,
      source_url: sourceUrl || null,
    });
  }
  return rows;
}

function filterHailReports(reports = [], {
  minSizeHundredths = 100,
  sinceDate = null,
  states = null,
} = {}) {
  const stateSet = Array.isArray(states) && states.length > 0
    ? new Set(states.map(state => String(state).trim().toUpperCase()).filter(Boolean))
    : null;
  const since = sinceDate ? isoDate(sinceDate) : null;
  return (Array.isArray(reports) ? reports : []).filter(report => {
    if (!report?.metro || !report.state) return false;
    if ((Number(report.size_hundredths) || 0) < minSizeHundredths) return false;
    if (since && report.report_date && report.report_date < since) return false;
    if (stateSet && !stateSet.has(String(report.state).toUpperCase())) return false;
    return true;
  });
}

function targetMetrosFromReports(reports = [], {
  minSizeHundredths = 100,
  maxMetros = 5,
  states = null,
} = {}) {
  const filtered = filterHailReports(reports, { minSizeHundredths, states });
  const byMetro = new Map();
  for (const report of filtered) {
    const key = `${String(report.metro).toLowerCase()}|${String(report.state).toUpperCase()}`;
    const current = byMetro.get(key);
    if (!current || report.size_hundredths > current.max_size_hundredths) {
      byMetro.set(key, {
        city: report.metro,
        state: report.state,
        county: report.county,
        max_size_hundredths: report.size_hundredths,
        max_size_inches: report.size_inches,
        report_date: report.report_date,
        source_url: report.source_url,
        report,
      });
    }
  }
  return [...byMetro.values()]
    .sort((a, b) => b.max_size_hundredths - a.max_size_hundredths || String(a.city).localeCompare(String(b.city)))
    .slice(0, Math.max(1, Number(maxMetros) || 1));
}

async function fetchHailReportsForDate(date, {
  fetchImpl = globalThis.fetch,
  cache = inMemoryCache,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const reportDate = isoDate(date);
  const sourceUrl = buildSpcHailReportUrl(date);
  const cached = cache?.get?.(sourceUrl);
  const nowMs = dateFromInput(now).getTime();
  if (cached && nowMs - cached.fetched_at_ms < cacheTtlMs) return cached.rows;

  const res = await fetchImpl(sourceUrl, {
    headers: { 'User-Agent': DEFAULT_USER_AGENT },
  });
  if (!res?.ok) {
    const err = new Error(`noaa_spc_hail_http_${res?.status || 'unknown'}`);
    err.status = res?.status || null;
    throw err;
  }
  const text = await res.text();
  const rows = parseHailCsv(text, { reportDate, sourceUrl });
  cache?.set?.(sourceUrl, { fetched_at_ms: nowMs, rows });
  return rows;
}

function datesBack({ days = 7, now = new Date() } = {}) {
  const base = dateFromInput(now);
  const count = Math.max(1, Math.floor(Number(days) || 1));
  return Array.from({ length: count }, (_, idx) => {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() - idx));
    return isoDate(date);
  });
}

async function fetchRecentHailReports({
  days = 7,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  cache = inMemoryCache,
} = {}) {
  const all = [];
  for (const date of datesBack({ days, now })) {
    try {
      all.push(...await fetchHailReportsForDate(date, { fetchImpl, cache, now }));
    } catch {
      // NOAA preliminary daily files can be absent or temporarily malformed.
      // One missing day should not block the rest of the bounded lookback.
    }
  }
  return all;
}

module.exports = {
  buildSpcHailReportUrl,
  parseHailCsv,
  filterHailReports,
  targetMetrosFromReports,
  fetchHailReportsForDate,
  fetchRecentHailReports,
  _test: {
    parseCsvLine,
    cleanMetroFromLocation,
    datesBack,
  },
};
