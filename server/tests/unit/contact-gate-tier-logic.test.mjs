import { createRequire } from 'module';
import { vi, describe, it, expect, beforeAll } from 'vitest';
const require = createRequire(import.meta.url);

// Mock pool before requiring contactGate so no real DB connection is created
vi.mock('../../db/pool', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

const contactGate = require('../../services/contactGate');
const {
  tryPersistSourcedLead, isFakeDomain, hasUsableCompany,
  FAKE_EMAIL_DOMAINS, TIER_B_SCORE_THRESHOLD,
} = contactGate;

const CLIENT_ID = 'ce2fc8e5-0000-0000-0000-000000000000';

describe('isFakeDomain', () => {
  it('detects every domain in FAKE_EMAIL_DOMAINS', () => {
    for (const domain of FAKE_EMAIL_DOMAINS) {
      expect(isFakeDomain(`user@${domain}`)).toBe(true);
    }
  });

  it('passes real company domains', () => {
    expect(isFakeDomain('user@tincityimpact.com')).toBe(false);
    expect(isFakeDomain('mj@beaver.solutions')).toBe(false);
  });

  it('handles null / empty safely', () => {
    expect(isFakeDomain(null)).toBe(false);
    expect(isFakeDomain('')).toBe(false);
    expect(isFakeDomain('noatsign')).toBe(false);
  });
});

describe('tryPersistSourcedLead — Tier A', () => {
  it('passes Tier A for SMTP-verified email and usable company', async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Ahmad Razak', company: 'Tin City Impact',
      email: 'ahmad@tincity.com', email_verified: true,
      linkedin_url: 'https://linkedin.com/in/ahmad',
    });
    expect(r.passed).toBe(true);
    expect(r.tier).toBe('A');
  });

  it('rejects Tier A when email is on a fake domain (even if email_verified=true)', async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Ahmad Razak', company: 'Tin City Impact',
      email: 'ahmad@independent.com', email_verified: true,
      linkedin_url: 'https://linkedin.com/in/ahmad',
    });
    // Must NOT be Tier A since domain is fake; may qualify for Tier B via linkedin
    expect(r.tier).not.toBe('A');
  });

  it('rejects Tier A when email_verified is false', async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Ahmad Razak', company: 'Tin City Impact',
      email: 'ahmad@tincity.com', email_verified: false,
      linkedin_url: 'https://linkedin.com/in/ahmad',
      score: 90,
    });
    // Falls to Tier B (has linkedin + high score) — not Tier A
    expect(r.tier).not.toBe('A');
  });
});

describe('tryPersistSourcedLead — Tier B', () => {
  it(`passes Tier B when linkedin_url present and score >= ${TIER_B_SCORE_THRESHOLD} and usable company`, async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Siti Nurhaliza', company: 'GrowthCo',
      linkedin_url: 'https://linkedin.com/in/siti',
      score: TIER_B_SCORE_THRESHOLD, email: null, email_verified: false,
    });
    expect(r.passed).toBe(true);
    expect(r.tier).toBe('B');
  });

  it(`rejects Tier B when score < ${TIER_B_SCORE_THRESHOLD}`, async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Siti Nurhaliza', company: 'GrowthCo',
      linkedin_url: 'https://linkedin.com/in/siti',
      score: TIER_B_SCORE_THRESHOLD - 1, email: null, email_verified: false,
    });
    expect(r.passed).toBe(false);
    expect(r.tier).toBeNull();
    expect(r.missReason).toContain('linkedin_only_below_p1_score');
  });

  it('allowLinkedinOnly bypasses score threshold', async () => {
    const r = await tryPersistSourcedLead(
      CLIENT_ID,
      { name: 'Siti Nurhaliza', company: 'GrowthCo', linkedin_url: 'https://linkedin.com/in/siti', score: 0 },
      { allowLinkedinOnly: true }
    );
    expect(r.passed).toBe(true);
    expect(r.tier).toBe('B');
  });
});

describe('tryPersistSourcedLead — Tier C miss reasons', () => {
  it('no_usable_company when company is junk', async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Ahmad Razak', company: 'Unknown',
      email: 'ahmad@real.com', email_verified: true,
    });
    expect(r.passed).toBe(false);
    expect(r.missReason).toBe('no_usable_company');
  });

  it('no_channels when no email and no linkedin_url', async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Ahmad Razak', company: 'Tin City', email: null, linkedin_url: null,
    });
    expect(r.passed).toBe(false);
    expect(r.missReason).toBe('no_channels');
  });

  it('unverified_email_no_linkedin_fallback for unverified email without linkedin', async () => {
    const r = await tryPersistSourcedLead(CLIENT_ID, {
      name: 'Ahmad Razak', company: 'Tin City',
      email: 'ahmad@tincity.com', email_verified: false, linkedin_url: null,
    });
    expect(r.passed).toBe(false);
    expect(r.missReason).toBe('unverified_email_no_linkedin_fallback');
  });
});
