import { createRequire } from 'module';

const require = createRequire(import.meta.url);

vi.mock('../../db/pool', () => ({ query: vi.fn() }));
vi.mock('../../services/logs', () => ({ createLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/logs.js', () => ({ createLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/pipelineTrace', () => ({ traceStage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/pipelineTrace.js', () => ({ traceStage: vi.fn().mockResolvedValue(undefined) }));

const agents = require('../../services/agents');

describe('signal-first top-up planning', () => {
  it('uses remaining bounded budget to over-fetch one clean signal lead when duplicates can shrink saves', () => {
    expect(agents._test.buildSignalFirstSourcingPlan(4, 10)).toMatchObject({
      paidQueryBudget: 10,
      maxSignalLeads: 5,
      bufferLeads: 1,
    });
  });

  it('keeps chat-sized five-lead runs bounded while reserving one duplicate buffer when budget allows', () => {
    expect(agents._test.buildSignalFirstSourcingPlan(5, 12)).toMatchObject({
      paidQueryBudget: 12,
      maxSignalLeads: 6,
      bufferLeads: 1,
    });
  });

  it('does not invent buffer leads when the paid query cap cannot support them', () => {
    expect(agents._test.buildSignalFirstSourcingPlan(4, 8)).toMatchObject({
      paidQueryBudget: 8,
      maxSignalLeads: 4,
      bufferLeads: 0,
    });
  });
});
