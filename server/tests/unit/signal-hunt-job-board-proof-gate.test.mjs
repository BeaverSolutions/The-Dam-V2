import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const signalHunt = require('../../services/signalHunt.js');

const roofingHiringQuery = {
  signal_id: 'roofing_hiring_sales_ops',
  signal_family: 'hiring_capability_build',
  source_channel: 'job_boards',
  country: 'US',
};

describe('Signal Hunt job-board proof gate', () => {
  it('rejects job-title fragments as company names before lookup', () => {
    expect(signalHunt._test.validSignalCompanyName('time Roofing Estimator')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('Commercial Roofing Project Manager')).toBe(false);
    expect(signalHunt._test.validSignalCompanyName('Champion Contractors & Services LLC')).toBe(true);
  });

  it('does not extract hiring signals from generic job-board category pages', () => {
    const signals = signalHunt._test.deterministicHiringSignals([
      {
        title: 'Full-time Roofing Estimator - A Step Above Inc.',
        snippet: 'A Step Above Inc. is hiring a Roofing Estimator in Las Vegas, NV.',
        link: 'https://www.ziprecruiter.com/Jobs/Roofing/-in-Las-Vegas,NV',
      },
      {
        title: 'Commercial Roofing Project Manager jobs in United States',
        snippet: '23,000+ jobs in United States.',
        link: 'https://www.linkedin.com/jobs/commercial-roofing-project-manager-jobs',
      },
      {
        title: 'Roofing Sales Manager Jobs, Employment | Indeed',
        snippet: 'Find roofing sales manager jobs. Apply now.',
        link: 'https://www.indeed.com/q-Roofing-Sales-Manager-jobs.html',
      },
    ], roofingHiringQuery);

    expect(signals).toEqual([]);
  });

  it('keeps a specific job-detail hiring proof', () => {
    const signals = signalHunt._test.deterministicHiringSignals([
      {
        title: 'Roofing Sales Representative - Champion Contractors & Services LLC',
        snippet: 'Champion Contractors & Services LLC is hiring a roofing sales representative.',
        link: 'https://www.indeed.com/viewjob?jk=abc123',
      },
    ], roofingHiringQuery);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      company: 'Champion Contractors & Services LLC',
      source_url: 'https://www.indeed.com/viewjob?jk=abc123',
    });
  });

  it('filters generic job-board pages from LLM-normalized hiring signals', () => {
    const signals = signalHunt._test.normaliseExtractedSignals([
      {
        company: 'Kirkland',
        signal_summary: 'Kirkland is hiring roofing sales managers.',
        why_now: 'Hiring signal.',
        source_url: 'https://www.indeed.com/q-Roofing-Manager-l-United-States-jobs.html',
        confidence: 0.8,
      },
      {
        company: 'Champion Contractors & Services LLC',
        signal_summary: 'Champion Contractors & Services LLC is hiring a roofing sales representative.',
        why_now: 'Hiring signal.',
        source_url: 'https://www.indeed.com/viewjob?jk=abc123',
        confidence: 0.8,
      },
    ], 'roofing_hiring_sales_ops');

    expect(signals.map(signal => signal.company)).toEqual(['Champion Contractors & Services LLC']);
  });
});
