import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// contactGate's only dependency is db/pool (a lazy node-postgres Pool that does
// not connect until first query). hasUsableCompany is pure, so requiring the
// module here is side-effect-free for this test.
const contactGate = require('../../services/contactGate');

const contactGateSource = readFileSync(resolve(__dirname, '../../services/contactGate.js'), 'utf-8');
const researchEnrichmentSource = readFileSync(resolve(__dirname, '../../services/researchEnrichment.js'), 'utf-8');
const indexSource = readFileSync(resolve(__dirname, '../../index.js'), 'utf-8');

// ── 1b: contactGate usable-company gate ──────────────────────────────────
describe('contactGate.hasUsableCompany', () => {
  const { hasUsableCompany } = contactGate;

  it('rejects null / blank / whitespace company', () => {
    expect(hasUsableCompany(null)).toBe(false);
    expect(hasUsableCompany(undefined)).toBe(false);
    expect(hasUsableCompany('')).toBe(false);
    expect(hasUsableCompany('   ')).toBe(false);
  });

  it('rejects junk placeholder company names (case-insensitive)', () => {
    expect(hasUsableCompany('Unknown')).toBe(false);
    expect(hasUsableCompany('Unknown Company')).toBe(false);
    expect(hasUsableCompany('independent')).toBe(false);
    expect(hasUsableCompany('Self-Employed')).toBe(false);
    expect(hasUsableCompany('self employed')).toBe(false);
    expect(hasUsableCompany('STEALTH')).toBe(false);
    expect(hasUsableCompany('Confidential')).toBe(false);
  });

  it('accepts real company names', () => {
    expect(hasUsableCompany('Tin City Impact')).toBe(true);
    expect(hasUsableCompany('Acme Sdn Bhd')).toBe(true);
    expect(hasUsableCompany('Mirtech')).toBe(true);
  });

  it('junk list mirrors the DB-first selector junk list', () => {
    // The DB-first selector (agents.js) excludes exactly these company values.
    for (const junk of ['unknown', 'unknown company', 'independent', 'self-employed', 'self employed', 'stealth', 'confidential']) {
      expect(contactGate.JUNK_COMPANY_NAMES.has(junk)).toBe(true);
    }
  });
});

describe('contactGate tier wiring (source contract)', () => {
  it('requires a usable company for Tier A and Tier B', () => {
    expect(contactGateSource).toContain('const usableCompany = hasUsableCompany(candidate.company)');
    expect(contactGateSource).toContain('if (hasUsableEmail && emailVerified && usableCompany)');
    expect(contactGateSource).toContain('if (hasLinkedin && usableCompany && (score >= TIER_B_SCORE_THRESHOLD || allowLinkedinOnly))');
  });

  it('emits a specific miss reason for no-company leads', () => {
    expect(contactGateSource).toContain("missReason = 'no_usable_company'");
  });
});

// ── 1c: Tier-B -> Tier-A email enrichment worker ─────────────────────────
describe('researchEnrichment.runPoolEmailEnrichment (source contract)', () => {
  const start = researchEnrichmentSource.indexOf('async function runPoolEmailEnrichment');
  const end = researchEnrichmentSource.indexOf('module.exports', start);
  const fn = researchEnrichmentSource.slice(start, end);

  it('exists and is exported', () => {
    expect(start).toBeGreaterThan(-1);
    expect(researchEnrichmentSource).toContain('runPoolEmailEnrichment,');
  });

  it('selects only Tier-B pool leads missing a verified email, with a usable company', () => {
    expect(fn).toContain("lead_tier = 'B'");
    expect(fn).toContain('(email IS NULL OR email_verified IS NOT TRUE)');
    expect(fn).toContain('linkedin_url IS NOT NULL');
    expect(fn).toContain("NULLIF(BTRIM(company), '') IS NOT NULL");
    expect(fn).toContain("LOWER(BTRIM(company)) NOT IN ('unknown','unknown company','independent','self-employed','self employed','stealth','confidential')");
  });

  it('re-attempts no more often than every 7 days', () => {
    expect(fn).toContain("email_enrich_attempted_at");
    expect(fn).toContain("NOW() - INTERVAL '7 days'");
  });

  it('dry-run returns candidates WITHOUT calling findEmail (no spend)', () => {
    const dryRunIdx = fn.indexOf('if (dryRun)');
    const findEmailIdx = fn.indexOf("require('./emailEnrichment')");
    expect(dryRunIdx).toBeGreaterThan(-1);
    expect(findEmailIdx).toBeGreaterThan(-1);
    // dry-run branch returns before findEmail is required/called.
    expect(dryRunIdx).toBeLessThan(findEmailIdx);
    expect(fn).toContain('no findEmail called, no spend');
  });

  it('promotes to Tier A only on a deliverable email', () => {
    expect(fn).toContain("result.status === 'deliverable'");
    expect(fn).toContain("lead_tier = 'A'");
  });
});

// ── 1c: cron wiring is flag-gated (no spend until explicitly enabled) ─────
describe('pool email enrichment cron (index.js source contract)', () => {
  const start = indexSource.indexOf('async function runPoolEmailEnrichmentCron');
  const end = indexSource.indexOf('runPoolEmailEnrichmentCron().catch', start);
  const fn = indexSource.slice(start, end > start ? end + 120 : start + 2000);

  it('is gated behind POOL_EMAIL_ENRICHMENT_ENABLED and reports disabled truthfully', () => {
    expect(fn).toContain("process.env.POOL_EMAIL_ENRICHMENT_ENABLED !== 'true'");
    expect(fn).toContain("jobHealth.markSkipped('pool_email_enrichment'");
  });

  it('fires only in the 08:45-08:55 MYT window', () => {
    expect(fn).toContain('utcHour !== 0 || utcMin < 45 || utcMin > 55');
  });

  it('marks the dedupe row BEFORE running so a restart cannot double-spend', () => {
    const dedupeInsertIdx = fn.indexOf('VALUES ($1, \'research_beaver\', $2, \'"fired"\'::jsonb');
    const runIdx = fn.indexOf('runPoolEmailEnrichment(client.id');
    expect(dedupeInsertIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeGreaterThan(-1);
    expect(dedupeInsertIdx).toBeLessThan(runIdx);
  });
});
