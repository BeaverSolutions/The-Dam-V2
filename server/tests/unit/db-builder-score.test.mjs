import { createRequire } from 'module';
import { vi, describe, it, expect } from 'vitest';
const require = createRequire(import.meta.url);

vi.mock('../../db/pool', () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

const dbBuilder = require('../../services/dbBuilder');

describe('dbBuilder score normalization', () => {
  it('uses quality_score before verification score when source score is missing', () => {
    expect(dbBuilder.effectiveLeadScore({
      score: undefined,
      quality_score: 88,
      verification: { score: 45 },
    })).toBe(88);
  });

  it('does not let a placeholder source score of 0 mask quality_score', () => {
    expect(dbBuilder.effectiveLeadScore({
      score: 0,
      quality_score: 88,
      verification: { score: 45 },
    })).toBe(88);
  });

  it('falls back to verification score so verified leads do not become score 0', () => {
    expect(dbBuilder.effectiveLeadScore({
      score: undefined,
      quality_score: undefined,
      verification: { score: 45 },
    })).toBe(45);
  });
});
