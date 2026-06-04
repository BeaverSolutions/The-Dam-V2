import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseRequestedLeadCount } = require('../../utils/requestedLeadCount');

describe('requested lead count parser', () => {
  it('does not treat V2.1 as a one-lead request', () => {
    expect(parseRequestedLeadCount('run V2.1 normal paid E2E with 5 leads', 50)).toBe(5);
    expect(parseRequestedLeadCount('V2.1 5 leads', 50)).toBe(5);
  });

  it('defaults when only a version number is present', () => {
    expect(parseRequestedLeadCount('run V2.1 paid test', 20)).toBe(20);
  });

  it('prefers numbers attached to lead nouns over earlier incidental numbers', () => {
    expect(parseRequestedLeadCount('run 1 quick V2.1 smoke check for 5 prospects', 20)).toBe(5);
    expect(parseRequestedLeadCount('run campaign at 09:30 tomorrow with 5 prospects', 20)).toBe(5);
  });

  it('still supports concise campaign count commands', () => {
    expect(parseRequestedLeadCount('kickoff 5', 20)).toBe(5);
    expect(parseRequestedLeadCount('find 12 VP-level leads at Series B SaaS companies', 50)).toBe(12);
  });

  it('bounds requested counts to the single-kickoff max', () => {
    expect(parseRequestedLeadCount('find 999 leads', 50)).toBe(20);
    expect(parseRequestedLeadCount('kickoff 47 leads', 20)).toBe(20);
  });
});
