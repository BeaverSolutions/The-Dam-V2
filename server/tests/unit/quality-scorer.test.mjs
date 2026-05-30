import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  scoreSignal, scoreTitle, scoreReachability, scoreSegmentHistory,
  scoreLead, SIGNAL_DECAY_MAX_DAYS, SEGMENT_HISTORY_PLACEHOLDER,
} = require('../../services/qualityScorer');

describe('scoreSignal', () => {
  it('returns raw=0 and reason=no_signal when no signal_type and no signal text', () => {
    const r = scoreSignal({ metadata: {} }, {});
    expect(r.raw).toBe(0);
    expect(r.reason).toBe('no_signal');
  });

  it('scores uncategorised signal text at 50% decay-adjusted', () => {
    const r = scoreSignal(
      { metadata: { why_now: 'They just expanded into new markets (very clear signal)' } },
      {}
    );
    expect(r.raw).toBeGreaterThan(0);
    expect(r.signal_type).toBe('uncategorised');
    expect(r.reason).toBe('signal_text_no_type');
  });

  it('fully decays a 30-day-old signal to raw=0', () => {
    const r = scoreSignal(
      { metadata: { signal_type: 'hiring_sales', signal_recency_days: SIGNAL_DECAY_MAX_DAYS } },
      { hiring_sales: 1.0 }
    );
    expect(r.raw).toBe(0);
    expect(r.decay).toBe(0);
  });

  it('returns full tenant weight for a fresh signal (day 0)', () => {
    const r = scoreSignal(
      { metadata: { signal_type: 'funding', signal_recency_days: 0 } },
      { funding: 0.8 }
    );
    // raw = round(0.8 * 1.0 * 1.0 * 100) = 80
    expect(r.raw).toBe(80);
  });

  it('falls back to tenant weight 0.5 for unknown signal types', () => {
    const r = scoreSignal(
      { metadata: { signal_type: 'unknown_type', signal_recency_days: 0 } },
      {}
    );
    expect(r.raw).toBe(50);
  });
});

describe('scoreTitle', () => {
  const icpConfig = {
    titles: {
      senior_standalone: ['CEO', 'Founder', 'Owner'],
      senior_leader: ['VP', 'Head of', 'Director'],
      junior_ic_regex: 'executive|coordinator|analyst',
    },
  };

  it('returns 100 for senior standalone match', () => {
    expect(scoreTitle({ title: 'CEO' }, icpConfig).raw).toBe(100);
    expect(scoreTitle({ title: 'Co-Founder' }, icpConfig).raw).toBe(100);
  });

  it('returns 80 for senior leader match', () => {
    expect(scoreTitle({ title: 'VP of Sales' }, icpConfig).raw).toBe(80);
    expect(scoreTitle({ title: 'Head of Marketing' }, icpConfig).raw).toBe(80);
  });

  it('returns 0 for junior_ic_regex match', () => {
    expect(scoreTitle({ title: 'Account Executive' }, icpConfig).raw).toBe(0);
    expect(scoreTitle({ title: 'Marketing Coordinator' }, icpConfig).raw).toBe(0);
  });

  it('returns 40 for unmatched title', () => {
    expect(scoreTitle({ title: 'Technologist' }, icpConfig).raw).toBe(40);
  });

  it('returns 0 for empty title', () => {
    expect(scoreTitle({ title: '' }, icpConfig).raw).toBe(0);
  });
});

describe('scoreReachability', () => {
  it('returns 100 for verified email + linkedin', () => {
    const r = scoreReachability({ email: 'a@b.com', email_verified: true, linkedin_url: 'https://linkedin.com/in/a' });
    expect(r.raw).toBe(100);
  });

  it('returns 80 for verified email only', () => {
    const r = scoreReachability({ email: 'a@b.com', email_verified: true });
    expect(r.raw).toBe(80);
  });

  it('returns 60 for unverified email + linkedin', () => {
    const r = scoreReachability({ email: 'a@b.com', email_verified: false, linkedin_url: 'https://linkedin.com/in/a' });
    expect(r.raw).toBe(60);
  });

  it('returns 50 for linkedin only (no email)', () => {
    const r = scoreReachability({ linkedin_url: 'https://linkedin.com/in/a' });
    expect(r.raw).toBe(50);
  });

  it('returns 0 for no contact method', () => {
    const r = scoreReachability({});
    expect(r.raw).toBe(0);
    expect(r.reason).toBe('unreachable');
  });
});

describe('scoreLead', () => {
  const tenantConfig = {
    quality_weights: { signal: 0.40, title: 0.25, reachability: 0.20, segment_history: 0.15 },
    signal_preferences: { funding: 1.0 },
    icp_config: {
      titles: {
        senior_standalone: ['CEO', 'Founder'],
        senior_leader: ['VP'],
        junior_ic_regex: 'analyst',
      },
    },
  };

  it('returns score bounded 0-100 even with weights summing > 1', () => {
    const badConfig = { ...tenantConfig, quality_weights: { signal: 0.9, title: 0.9, reachability: 0.9, segment_history: 0.9 } };
    const lead = {
      title: 'CEO',
      email: 'a@b.com', email_verified: true, linkedin_url: 'https://li.com/in/a',
      metadata: { signal_type: 'funding', signal_recency_days: 0 },
    };
    const { score } = scoreLead(lead, badConfig);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('throws when lead or tenantConfig is missing', () => {
    expect(() => scoreLead(null, tenantConfig)).toThrow();
    expect(() => scoreLead({}, null)).toThrow();
  });

  it('breakdown contributions sum to reported score', () => {
    const lead = {
      title: 'Founder',
      email: 'a@b.com', email_verified: true, linkedin_url: 'https://li.com/in/a',
      metadata: { signal_type: 'funding', signal_recency_days: 5 },
    };
    const { score, breakdown } = scoreLead(lead, tenantConfig);
    const contributionSum = Math.round(
      breakdown.signal.contribution + breakdown.title.contribution +
      breakdown.reachability.contribution + breakdown.segment_history.contribution
    );
    expect(Math.abs(score - contributionSum)).toBeLessThanOrEqual(1); // rounding tolerance
  });
});
