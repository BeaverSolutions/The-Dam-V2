import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = path => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const directivesSrc = read('../../services/directives.js');
const dbBuilderSrc = read('../../services/dbBuilder.js');
const signalHuntSrc = read('../../services/signalHunt.js');
const platformPlanSrc = read('../../services/platformPlan.js');

describe('platform execution gates', () => {
  it('defines approved platform plan directive builder', () => {
    expect(directivesSrc).toContain('buildExecuteApprovedPlatformPlanDirective');
    expect(directivesSrc).toContain("directive_type: 'execute_approved_platform_plan'");
    expect(directivesSrc).toContain('send_allowed: false');
  });

  it('loads only unexpired approved platform plans for execution', () => {
    expect(platformPlanSrc).toContain('async function loadApprovedPlatformPlan');
    expect(platformPlanSrc).toContain("AND status = 'approved'");
    expect(platformPlanSrc).toContain('AND expires_at > NOW()');
    expect(platformPlanSrc).toContain('platform_plan_required');
  });

  it('does not execute run_signal_playbook without an approved platform plan or explicit legacy override', () => {
    expect(dbBuilderSrc).toContain('execute_approved_platform_plan');
    expect(dbBuilderSrc).toContain('loadApprovedPlatformPlan');
    expect(dbBuilderSrc).toContain('platform_plan_required');
    expect(dbBuilderSrc).toContain('allow_legacy_paid_signal_playbook');
  });

  it('validates query constraints before searchOpenWeb is called', () => {
    const validateIdx = signalHuntSrc.indexOf('validateQuery(');
    const searchIdx = signalHuntSrc.indexOf('searchOpenWeb(q.query');

    expect(validateIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeLessThan(searchIdx);
    expect(signalHuntSrc).toContain('provider_query_limit_exceeded');
  });
});
