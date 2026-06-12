import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  markDailyKickoffOrphans,
  ORPHAN_AGENT,
  ORPHAN_REASON,
} = require('../../services/kickoffOrphanRecovery.js');

const CLIENT_ID = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';
const CLIENT = { id: CLIENT_ID, slug: 'beaver-solutions' };
const NOW = new Date('2026-06-12T04:00:00.000Z');
const MARKER_AT = new Date('2026-06-12T03:00:00.000Z');

function createPool({ memoryInserted = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM clients')) {
        return { rows: [CLIENT] };
      }
      if (sql.includes('INSERT INTO agent_memory')) {
        return { rows: memoryInserted ? [{ id: 'memory-row' }] : [] };
      }
      if (sql.includes('INSERT INTO logs')) {
        return { rows: [{ id: 'log-row' }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function proof(overrides = {}) {
  return {
    daily_kickoff_started: true,
    daily_kickoff_started_at: MARKER_AT.toISOString(),
    daily_kickoff_work_log: false,
    daily_kickoff_failure_proof: false,
    trace_count: 0,
    sent: 0,
    approval_ready: 0,
    drafting: 0,
    rejected: 0,
    ...overrides,
  };
}

function memoryInsert(pool) {
  return pool.calls.find(call => call.sql.includes('INSERT INTO agent_memory'));
}

function logInsert(pool) {
  return pool.calls.find(call => call.sql.includes('INSERT INTO logs'));
}

describe('daily kickoff orphan recovery', () => {
  it('marks a process-restart orphan once with the allowed captain_orchestrator agent', async () => {
    const pool = createPool();
    const result = await markDailyKickoffOrphans({
      pool,
      now: NOW,
      uptimeSeconds: 60,
      enabledSlugs: ['beaver-solutions'],
      getDailyKickoffProof: async () => proof(),
      isKickoffRunning: () => false,
    });

    expect(result.marked).toBe(1);
    expect(ORPHAN_AGENT).toBe('captain_orchestrator');
    expect(ORPHAN_AGENT).not.toBe('captain');
    expect(ORPHAN_REASON).toBe('process_restart_orphan');

    const memory = memoryInsert(pool);
    expect(memory.params[1]).toBe('daily_kickoff_failure_2026-06-12_process_restart_orphan');
    expect(memory.sql).toContain("'captain_orchestrator'");
    expect(memory.sql).not.toContain("VALUES ($1, 'captain',");

    const log = logInsert(pool);
    expect(log.sql).toContain("'captain_orchestrator'");
    expect(log.sql).toContain("'autonomous_kickoff_failed'");
    expect(log.sql).not.toContain("VALUES ($1, 'captain',");

    const metadata = JSON.parse(log.params[1]);
    expect(metadata).toMatchObject({
      reason: 'process_restart_orphan',
      boundary: 'daily_kickoff_orphan_sweep',
      run_marker_at: MARKER_AT.toISOString(),
      trace_count: 0,
      sent: 0,
      approval_ready: 0,
      drafting: 0,
      rejected: 0,
      delivered: 0,
      total_output: 0,
    });
  });

  it('is idempotent when the orphan memory key already exists', async () => {
    const pool = createPool({ memoryInserted: false });
    const result = await markDailyKickoffOrphans({
      pool,
      now: NOW,
      uptimeSeconds: 60,
      enabledSlugs: ['beaver-solutions'],
      getDailyKickoffProof: async () => proof(),
      isKickoffRunning: () => false,
    });

    expect(result.marked).toBe(0);
    expect(logInsert(pool)).toBeUndefined();
  });

  it('does not mark while the same-process kickoff is still running', async () => {
    const pool = createPool();
    const result = await markDailyKickoffOrphans({
      pool,
      now: NOW,
      uptimeSeconds: 60,
      enabledSlugs: ['beaver-solutions'],
      getDailyKickoffProof: async () => proof(),
      isKickoffRunning: clientId => clientId === CLIENT_ID,
    });

    expect(result.skipped_running).toBe(1);
    expect(memoryInsert(pool)).toBeUndefined();
  });

  it('does not mark when uptime is older than the kickoff marker age', async () => {
    const pool = createPool();
    const result = await markDailyKickoffOrphans({
      pool,
      now: NOW,
      uptimeSeconds: 90 * 60,
      enabledSlugs: ['beaver-solutions'],
      getDailyKickoffProof: async () => proof(),
      isKickoffRunning: () => false,
    });

    expect(result.skipped_not_orphan).toBe(1);
    expect(memoryInsert(pool)).toBeUndefined();
  });

  it('does not mark when work proof already exists', async () => {
    const pool = createPool();
    const result = await markDailyKickoffOrphans({
      pool,
      now: NOW,
      uptimeSeconds: 60,
      enabledSlugs: ['beaver-solutions'],
      getDailyKickoffProof: async () => proof({ trace_count: 1 }),
      isKickoffRunning: () => false,
    });

    expect(result.skipped_work_proof).toBe(1);
    expect(memoryInsert(pool)).toBeUndefined();
  });

  it('does not mark when explicit orphan failure proof already exists', async () => {
    const pool = createPool();
    const result = await markDailyKickoffOrphans({
      pool,
      now: NOW,
      uptimeSeconds: 60,
      enabledSlugs: ['beaver-solutions'],
      getDailyKickoffProof: async () => proof({ daily_kickoff_failure_proof: true }),
      isKickoffRunning: () => false,
    });

    expect(result.skipped_failure_proof).toBe(1);
    expect(memoryInsert(pool)).toBeUndefined();
  });
});
