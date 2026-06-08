import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const service = (p) => readFileSync(resolve(__dirname, '../../', p), 'utf-8');

function runSignalHuntBlocks(src) {
  const blocks = [];
  let idx = 0;
  while ((idx = src.indexOf('runSignalHunt(', idx)) !== -1) {
    blocks.push(src.slice(Math.max(0, idx - 900), Math.min(src.length, idx + 500)));
    idx += 'runSignalHunt('.length;
  }
  return blocks;
}

describe('Signal Hunt ICP plumbing', () => {
  const autonomous = service('routes/autonomous.js');
  const agents = service('services/agents.js');
  const dbBuilder = service('services/dbBuilder.js');
  const tenantContext = service('services/tenantContext.js');

  it('keeps the canonical Signal Hunt ICP loader in tenantContext', () => {
    expect(tenantContext).toContain('async function loadIcpForSignalHunt');
    expect(tenantContext).toContain('getLegacyIcpForClient(clientId');
    expect(tenantContext).toContain("agent = 'director' AND key = 'icp'");
  });

  it('does not read raw director ICP in autonomous Signal Hunt callers', () => {
    expect(autonomous).not.toMatch(/agent\s*=\s*'director'\s+AND\s+key\s*=\s*'icp'/);
    expect(autonomous).toContain('loadIcpForSignalHunt');
    for (const block of runSignalHuntBlocks(autonomous)) {
      expect(block).not.toContain('icpRows');
      expect(block).not.toContain('icpRows[0]?.content');
    }
  });

  it('returns tenant-profile blockers from scheduled kickoff ICP load to job health', () => {
    const loadIdx = autonomous.indexOf("const icp = await loadIcpForSignalHunt(clientId, { source: 'cron' })");
    const runSignalIdx = autonomous.indexOf('runSignalHunt(clientId', loadIdx);
    const preSignalBlock = autonomous.slice(loadIdx, runSignalIdx);

    expect(loadIdx).toBeGreaterThan(-1);
    expect(runSignalIdx).toBeGreaterThan(loadIdx);
    expect(preSignalBlock).toContain("source: 'loadIcpForSignalHunt'");
    expect(preSignalBlock).toContain('return {');
    expect(preSignalBlock).toContain('blocked: true');
    expect(preSignalBlock).toContain('TENANT_PROFILE_BLOCKED');
  });

  it('does not feed Director Signal Hunt from getMemory director/icp', () => {
    const signalFirstStart = agents.indexOf('signal_first_started');
    const signalFirstBlock = agents.slice(signalFirstStart - 900, agents.indexOf('diagnostics.signal_first_raw', signalFirstStart));

    expect(signalFirstBlock).toContain('loadIcpForSignalHunt');
    expect(signalFirstBlock).not.toContain("getMemory(clientId, 'director', 'icp')");
    expect(signalFirstBlock).not.toContain('icp: icpMemory');
  });

  it('leaves DB Builder Signal Hunt callers on canonical ICP', () => {
    expect(dbBuilder).toContain('async function loadCanonicalIcp');
    expect(dbBuilder).toContain('const icpMemory = await loadCanonicalIcp(clientId)');
    expect(dbBuilder).toContain('const icpMemory = await loadCanonicalIcp(client.id)');
    expect(dbBuilder).toContain('icp: icpMemory');
  });
});
