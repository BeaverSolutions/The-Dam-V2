import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const captainOrchestrator = require('../../services/captainOrchestrator');
const agents = require('../../services/agents');

describe('campaign paid query preflight math', () => {
  it('uses signal-first-style spend for external target sizing in orchestrator preflight', () => {
    expect(captainOrchestrator._test.minPaidQueriesForExternalTarget(1)).toBe(3);
    expect(captainOrchestrator._test.minPaidQueriesForExternalTarget(4)).toBe(10);
    expect(captainOrchestrator._test.minPaidQueriesForExternalTarget(20)).toBe(42);
  });

  it('uses the same external target math in director execution checks', () => {
    expect(agents._test.minPaidQueriesForExternalTarget(1)).toBe(3);
    expect(agents._test.minPaidQueriesForExternalTarget(4)).toBe(10);
    expect(agents._test.minPaidQueriesForExternalTarget(20)).toBe(42);
  });
});
