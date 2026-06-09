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

  it('rejects directory profile labels as contact names before Sales Beaver', () => {
    const r = leadReadinessGate({ ...base, name: 'Marketing Company Profile' });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('invalid_contact_name');
  });

  it('rejects team labels as contact names before Sales Beaver', () => {
    const r = leadReadinessGate({ ...base, name: 'Key Executive Team' });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('invalid_contact_name');
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

  it('rejects aggregator directory rows before Sales Beaver', () => {
    const r = leadReadinessGate({
      ...base,
      name: 'Peter Phang',
      company: 'Techbehemoths',
      email: 'peter@techbehemoths.com',
      metadata: {
        signal_package: {
          source_url: 'https://techbehemoths.com/companies/software-development/malaysia',
        },
      },
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('directory_or_aggregator_company');
  });

  it('rejects SEO page-title companies from vertical directory sources', () => {
    const r = leadReadinessGate({
      ...base,
      name: 'Jeff Tan Ka Wei',
      company: "Malaysia's Leading Corporate Training Providers",
      email: null,
      linkedin_url: 'https://linkedin.com/in/jefftan',
      metadata: {
        platform: 'agency_directory',
        source_channel: 'vertical_directory',
        signal_package: {
          platform: 'agency_directory',
          source_channel: 'vertical_directory',
          source_url: 'https://thrivingtalents.com/',
        },
      },
    });

    expect(r.ready).toBe(false);
    expect(r.reason).toBe('directory_or_aggregator_company');
  });

  it('rejects vertical directory leads without persisted direct company website evidence', () => {
    const r = leadReadinessGate({
      ...base,
      name: 'Ed Ley',
      company: 'CorporateTrainingMY',
      email: null,
      linkedin_url: 'https://linkedin.com/in/edley',
      metadata: {
        platform: 'agency_directory',
        source_channel: 'vertical_directory',
        signal_package: {
          platform: 'agency_directory',
          source_channel: 'vertical_directory',
          source_url: 'https://corporatetrainingmalaysia.com/corporate-training-kuala-lumpur',
        },
      },
    });

    expect(r.ready).toBe(false);
    expect(r.reason).toBe('directory_or_aggregator_company');
  });

  it('allows vertical directory leads after Research persists direct company website evidence', () => {
    const r = leadReadinessGate({
      ...base,
      name: 'Alexandre Hanszmann',
      company: 'Thriving Talents',
      email: null,
      linkedin_url: 'https://linkedin.com/in/alexandrehanszmann',
      metadata: {
        platform: 'agency_directory',
        source_channel: 'vertical_directory',
        company_website: 'https://thrivingtalents.com',
        signal_package: {
          platform: 'agency_directory',
          source_channel: 'vertical_directory',
          source_url: 'https://thrivingtalents.com/',
          company_website: 'https://thrivingtalents.com',
        },
      },
    });

    expect(r.ready).toBe(true);
  });

  it('keeps real marketing agencies eligible when the contact and company are concrete', () => {
    const r = leadReadinessGate({
      ...base,
      name: 'Sarah Lim',
      company: 'Bright Street Marketing',
      email: 'sarah@brightstreetmarketing.my',
      linkedin_url: null,
      metadata: {
        signal_package: {
          source_url: 'https://brightstreetmarketing.my',
        },
      },
    });
    expect(r.ready).toBe(true);
  });

  it('does not reject real agency names that merely contain an aggregator token', () => {
    const r = leadReadinessGate({
      ...base,
      name: 'Sarah Lim',
      company: 'Clutch Creative Marketing',
      email: 'sarah@clutchcreative.my',
      linkedin_url: null,
      metadata: {
        signal_package: {
          source_url: 'https://clutchcreative.my',
        },
      },
    });
    expect(r.ready).toBe(true);
  });

  it('rejects lead with no email and no linkedin_url', () => {
    const r = leadReadinessGate({ ...base, email: null, linkedin_url: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('no_contact_method');
  });

  it('can run as an identity-only gate before email enrichment', () => {
    const r = leadReadinessGate({
      ...base,
      email: null,
      linkedin_url: null,
    }, { requireContactMethod: false });
    expect(r.ready).toBe(true);
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
