import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (path) => readFileSync(resolve(__dirname, '../../', path), 'utf-8');

const spendGuardSource = src('services/spendGuard.js');
const autonomousSource = src('routes/autonomous.js');
const hourlyReportSource = readFileSync(resolve(__dirname, '../../../scripts/hourly-report.mjs'), 'utf-8');
const platformHealthSource = readFileSync(resolve(__dirname, '../../../scripts/platform-health.mjs'), 'utf-8');
const indexSource = src('index.js');

describe('provider credit visibility and public health boundary', () => {
  it('builds internal provider snapshots from provider_usage logs and configured caps', () => {
    expect(spendGuardSource).toContain('async function providerUsageTotal(provider, clientId = null)');
    expect(spendGuardSource).toContain('async function providerCreditSnapshot(provider, clientId = null)');
    expect(spendGuardSource).toContain('async function providerCreditSnapshots(clientId = null');
    expect(spendGuardSource).toContain("metadata->>'provider' = $1");
    expect(spendGuardSource).toContain('trial_cap');
    expect(spendGuardSource).toContain('remaining_total');
  });

  it('exposes provider snapshots only on internal system-health', () => {
    expect(autonomousSource).toContain('provider_usage: await spendGuard.providerCreditSnapshots(c.id)');
    expect(autonomousSource).toContain("'anymail'");
    expect(autonomousSource).toContain("'icypeas'");
    expect(indexSource).toContain('/health is unauthenticated');
    expect(indexSource).not.toContain('providerCreditSnapshot');
    expect(indexSource).not.toContain('provider_usage');
  });

  it('surfaces low provider capacity in hourly and platform health reports', () => {
    expect(hourlyReportSource).toContain('providerUsageLines');
    expect(hourlyReportSource).toContain('low provider capacity');
    expect(platformHealthSource).toContain('provider_usage');
    expect(platformHealthSource).toContain('remaining_total');
    expect(platformHealthSource).toContain('provider capacity low');
  });
});
