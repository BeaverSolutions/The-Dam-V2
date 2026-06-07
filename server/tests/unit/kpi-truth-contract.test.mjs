import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const kpiSource = readFileSync(resolve(root, 'services/kpi.js'), 'utf-8').replace(/\r\n/g, '\n');
const businessDaySource = readFileSync(resolve(root, 'utils/businessDay.js'), 'utf-8').replace(/\r\n/g, '\n');
const dayTruthFiles = [
  'index.js',
  'routes/agents.js',
  'routes/autonomous.js',
  'routes/dashboard.js',
  'services/agents.js',
  'services/beaverState.js',
  'services/captainBeaver.js',
  'services/captainOrchestrator.js',
  'services/dbBuilder.js',
  'services/followupSequence.js',
  'services/learningEngine.js',
  'services/marketSensing.js',
  'services/qualityTuner.js',
  'services/research.js',
  'services/researchEnrichment.js',
];

describe('KPI recount truth contract', () => {
  it('counts sends by Asia/Kuala_Lumpur day boundaries, not UTC DATE()', () => {
    expect(businessDaySource).toContain("timeZone: MALAYSIA_TIME_ZONE");
    expect(businessDaySource).toContain("const MALAYSIA_TIME_ZONE = 'Asia/Kuala_Lumpur'");
    expect(kpiSource).toContain('todayInMalaysia');
    expect(kpiSource).toContain("AT TIME ZONE 'Asia/Kuala_Lumpur'");
    expect(kpiSource).toContain('sent_at IS NOT NULL');
    expect(kpiSource).toContain('sent_at >= bounds.start_at');
    expect(kpiSource).toContain('sent_at < bounds.end_at');
    expect(kpiSource).not.toContain("new Date().toISOString().split('T')[0]");
    expect(kpiSource).not.toContain('DATE(COALESCE(sent_at, updated_at))');
  });

  it('excludes manual proof messages from autonomous output recounts', () => {
    expect(kpiSource).toContain('autonomousSentMessageFilter');
    expect(kpiSource).toContain("COALESCE(metadata->>'manual_proof', 'false') <> 'true'");
    expect(kpiSource).toContain("COALESCE(metadata->>'source', '') <> 'manual_proof'");
    expect(kpiSource).toContain("COALESCE(metadata->>'send_source', '') <> 'manual_proof'");
    expect(kpiSource).toContain("COALESCE(metadata->>'autonomous_output', 'true') <> 'false'");
  });

  it('keeps active business-day paths off UTC date shortcuts', () => {
    const forbiddenPatterns = [
      /new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/,
      /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
      /now\.toISOString\(\)\.split\('T'\)\[0\]/,
      /nowIso\.split\('T'\)\[0\]/,
      /DATE\(sent_at\)/,
      /DATE\(COALESCE\(sent_at/,
      /DATE\(created_at\)/,
      /created_at::date\s*=\s*CURRENT_DATE/,
      /\bCURRENT_DATE\b/,
    ];

    for (const file of dayTruthFiles) {
      const source = readFileSync(resolve(root, file), 'utf-8').replace(/\r\n/g, '\n');
      for (const pattern of forbiddenPatterns) {
        expect(source, `${file} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
