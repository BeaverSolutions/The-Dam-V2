import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// leadReadinessGate is pure — no DB, no network
const { leadReadinessGate } = require('../../services/pipeline');

describe('pipeline.leadReadinessGate', () => {
  const base = {
    name: 'Ahmad Razak',
    company: 'Tin City Impact',
    email: 'ahmad@tincity.com',
    email_verified: true,
    linkedin_url: 'https://linkedin.com/in/ahmad',
  };

  it('passes a fully populated lead', () => {
    const r = leadReadinessGate(base);
    expect(r.ready).toBe(true);
  });

  it('rejects null lead', () => {
    const r = leadReadinessGate(null);
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no_lead');
  });

  it('rejects missing name', () => {
    const r = leadReadinessGate({ ...base, name: '' });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('missing_name');
  });

  it('rejects Unknown Contact name', () => {
    const r = leadReadinessGate({ ...base, name: 'Unknown Contact' });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('missing_name');
  });

  it('rejects missing company', () => {
    const r = leadReadinessGate({ ...base, company: '' });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('missing_company');
  });

  it('rejects Unknown Company', () => {
    const r = leadReadinessGate({ ...base, company: 'Unknown Company' });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('missing_company');
  });

  it('rejects lead with no email and no linkedin_url', () => {
    const r = leadReadinessGate({ ...base, email: null, linkedin_url: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no_contact_method');
  });

  it('rejects lead whose email has no @ character', () => {
    const r = leadReadinessGate({ ...base, email: 'notanemail', linkedin_url: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no_contact_method');
  });

  it('passes with email only (no linkedin_url)', () => {
    const r = leadReadinessGate({ ...base, linkedin_url: null });
    expect(r.ready).toBe(true);
  });

  it('passes with linkedin_url only (no email)', () => {
    const r = leadReadinessGate({ ...base, email: null });
    expect(r.ready).toBe(true);
  });
});
