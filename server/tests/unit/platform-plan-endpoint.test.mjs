import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '../../routes/autonomous.js'), 'utf-8').replace(/\r\n/g, '\n');

function routeBody(path) {
  const start = src.indexOf(`router.post('${path}'`);
  if (start === -1) return '';
  const next = src.indexOf('\nrouter.', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('platform plan endpoint contracts', () => {
  it('has a no-spend preview route before execution', () => {
    const body = routeBody('/platform-plan/preview');

    expect(body).toContain('buildPlatformPlan');
    expect(body).toContain('dry_run: true');
    expect(body).not.toContain('runSignalHunt(');
    expect(body).not.toContain('saveSignalLeads(');
  });

  it('requires plan hash confirmation and plan hash integrity before approval', () => {
    const body = routeBody('/platform-plan/approve');

    expect(body).toContain('confirm_plan_hash');
    expect(body).toContain('PLATFORM_PLAN_CONFIRMATION_MISMATCH');
    expect(body).toContain('verifyPlatformPlanHash(plan)');
    expect(body).toContain('PLATFORM_PLAN_HASH_INVALID');
    expect(body).toContain('MISSING_PLAN_HASH');
    expect(body).toContain('MISSING_QUERY_SET_HASH');
    expect(body).toContain('PLATFORM_PLAN_APPROVAL_FAILED');
    expect(body).toContain("status = 'approved'");
  });
});
