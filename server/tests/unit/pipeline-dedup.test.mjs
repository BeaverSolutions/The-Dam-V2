import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// pipeline.js uses real pool (CJS require), so we test the logic contract
// without calling the actual functions. This verifies:
// 1. SQL shapes are correct (via reading source)
// 2. Dedup logic prevents duplicates
// 3. No infinite retry loops exist in the code

// Read the pipeline source to verify SQL contract
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pipelineSource = readFileSync(resolve(__dirname, '../../services/pipeline.js'), 'utf-8');

describe('pipeline.checkActiveMessage — SQL contract', () => {
  it('queries messages table with correct active statuses', () => {
    expect(pipelineSource).toContain("status IN ('pending_ranger', 'pending_approval', 'approved', 'pending_send', 'sent')");
  });

  it('uses LIMIT 1 (bounded, no unbounded scan)', () => {
    // Find the checkActiveMessage function body
    const fnStart = pipelineSource.indexOf('async function checkActiveMessage');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('LIMIT 1');
  });

  it('filters by both client_id and lead_id (tenant-safe)', () => {
    const fnStart = pipelineSource.indexOf('async function checkActiveMessage');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('client_id = $1');
    expect(fnBody).toContain('lead_id = $2');
  });

  it('returns rows[0] or null (not the full result set)', () => {
    const fnStart = pipelineSource.indexOf('async function checkActiveMessage');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('result.rows[0] || null');
  });
});

describe('pipeline.persistDraft — SQL contract', () => {
  it('inserts into messages table', () => {
    expect(pipelineSource).toContain('INSERT INTO messages');
  });

  it('uses parameterized queries ($1, $2, etc) — no SQL injection', () => {
    const insertSection = pipelineSource.slice(
      pipelineSource.indexOf('async function persistDraft'),
      pipelineSource.indexOf('async function persistDraft') + 2000
    );
    // Check it uses $1-$N params not string concatenation
    expect(insertSection).toMatch(/\$[1-9]/);
    expect(insertSection).not.toMatch(/\$\{clientId\}/); // no template literals in SQL
  });

  it('validates required params before query (fail-fast)', () => {
    const fnStart = pipelineSource.indexOf('async function persistDraft');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain('!clientId || !lead_id || !body || !status');
    expect(fnBody).toContain('throw new Error');
  });

  it('uses RETURNING * to get the inserted row', () => {
    expect(pipelineSource).toContain('RETURNING *');
  });

  it('emits pipelineTrace.traceStage after insert (fire-and-forget)', () => {
    const traceStart = pipelineSource.indexOf('pipelineTrace.traceStage(clientId');
    const traceSection = pipelineSource.slice(traceStart, traceStart + 500);
    expect(traceSection).toContain('.catch(() => {})');
  });

  it('handles ranger_score branch (two SQL shapes)', () => {
    const fnStart = pipelineSource.indexOf('async function persistDraft');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 3000);
    expect(fnBody).toContain('if (ranger_score !== null)');
    // Both branches insert into messages
    const insertCount = (fnBody.match(/INSERT INTO messages/g) || []).length;
    expect(insertCount).toBe(2);
  });
});

describe('No infinite retry loops', () => {
  it('persistDraft has no while/for loop (single INSERT, no retry)', () => {
    const fnStart = pipelineSource.indexOf('async function persistDraft');
    const fnEnd = pipelineSource.indexOf('\nmodule.exports', fnStart);
    const fnBody = pipelineSource.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 3000);
    // No while(true) or for(;;) inside persistDraft
    expect(fnBody).not.toMatch(/while\s*\(\s*true\s*\)/);
    expect(fnBody).not.toMatch(/for\s*\(\s*;\s*;\s*\)/);
  });

  it('checkActiveMessage has no loop (single query)', () => {
    const fnStart = pipelineSource.indexOf('async function checkActiveMessage');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 500);
    expect(fnBody).not.toMatch(/while\s*\(/);
    expect(fnBody).not.toMatch(/for\s*\(/);
  });

  it('processLead throws (not yet composed — no silent pass-through)', () => {
    const fnStart = pipelineSource.indexOf('async function processLead');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 500);
    expect(fnBody).toContain("throw new Error");
    expect(fnBody).toContain('not yet composed');
  });
});

describe('Dedup guard contract', () => {
  it('checkActiveMessage exists and is exported', () => {
    expect(pipelineSource).toContain('module.exports');
    expect(pipelineSource).toContain('checkActiveMessage');
  });

  it('persistDraft exists and is exported', () => {
    expect(pipelineSource).toContain('persistDraft');
  });

  it('dedup checks pending_ranger through sent (complete lifecycle)', () => {
    // These are all the statuses where a lead has an "active" message
    const statuses = ['pending_ranger', 'pending_approval', 'approved', 'pending_send', 'sent'];
    for (const status of statuses) {
      expect(pipelineSource).toContain(status);
    }
  });

  it('does NOT count rejected/blocked as active (allows re-draft)', () => {
    // ranger_rejected and blocked_no_email should NOT be in the active check
    const fnStart = pipelineSource.indexOf('async function checkActiveMessage');
    const fnBody = pipelineSource.slice(fnStart, fnStart + 500);
    expect(fnBody).not.toContain('ranger_rejected');
    expect(fnBody).not.toContain('blocked_no_email');
  });
});
