import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const kpiSource = readFileSync(resolve(root, 'services/kpi.js'), 'utf-8').replace(/\r\n/g, '\n');

describe('KPI recount truth contract', () => {
  it('counts sends by Asia/Kuala_Lumpur day boundaries, not UTC DATE()', () => {
    expect(kpiSource).toContain("timeZone: 'Asia/Kuala_Lumpur'");
    expect(kpiSource).toContain("AT TIME ZONE 'Asia/Kuala_Lumpur'");
    expect(kpiSource).toContain('sent_at IS NOT NULL');
    expect(kpiSource).toContain('sent_at >= bounds.start_at');
    expect(kpiSource).toContain('sent_at < bounds.end_at');
    expect(kpiSource).not.toContain("new Date().toISOString().split('T')[0]");
    expect(kpiSource).not.toContain('DATE(COALESCE(sent_at, updated_at))');
  });
});
