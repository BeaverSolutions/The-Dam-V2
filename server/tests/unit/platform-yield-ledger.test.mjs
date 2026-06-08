import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const platformYield = require('../../services/platformYield');
const signalHunt = require('../../services/signalHunt');
const pool = require('../../db/pool');
const originalQuery = pool.query;

afterEach(() => {
  pool.query = originalQuery;
});

const migration = readFileSync(
  resolve(__dirname, '../../db/migrations/082_platform_plans_and_yield.sql'),
  'utf-8'
).replace(/\r\n/g, '\n');
const compactMigration = migration.replace(/\s+/g, ' ');
const signalHuntSource = readFileSync(resolve(__dirname, '../../services/signalHunt.js'), 'utf-8');
const autonomousSource = readFileSync(resolve(__dirname, '../../routes/autonomous.js'), 'utf-8');
const dbBuilderSource = readFileSync(resolve(__dirname, '../../services/dbBuilder.js'), 'utf-8');

describe('platform plan yield ledger migration', () => {
  const escapeSqlPattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

  const expectColumn = (tableName, columnDefinition) => {
    const escapedDefinition = escapeSqlPattern(columnDefinition);
    expect(compactMigration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([^;]*${escapedDefinition}[^;]*\\);`));
  };

  const expectTableContains = (tableName, sqlFragment) => {
    const escapedFragment = escapeSqlPattern(sqlFragment);
    expect(compactMigration).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\([^;]*${escapedFragment}[^;]*\\);`));
  };

  const expectTenantPolicyBody = (tableName) => {
    const tenantScope = "client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID";
    const escapedTenantScope = escapeSqlPattern(tenantScope);
    expect(compactMigration).toMatch(new RegExp(
      `CREATE POLICY tenant_isolation ON ${tableName}\\s+USING \\(${escapedTenantScope}\\)\\s+WITH CHECK \\(${escapedTenantScope}\\);`
    ));
  };

  it('creates the three platform autonomy tables', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS platform_plans');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS platform_yield_events');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS platform_strategy_state');
  });

  it('enables tenant RLS for every platform autonomy table', () => {
    expect(migration).toContain('ALTER TABLE platform_plans ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE platform_yield_events ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE platform_strategy_state ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain("tablename = 'platform_plans' AND policyname = 'tenant_isolation'");
    expect(migration).toContain("tablename = 'platform_yield_events' AND policyname = 'tenant_isolation'");
    expect(migration).toContain("tablename = 'platform_strategy_state' AND policyname = 'tenant_isolation'");
    expectTenantPolicyBody('platform_plans');
    expectTenantPolicyBody('platform_yield_events');
    expectTenantPolicyBody('platform_strategy_state');
  });

  it('stores platform plan approval, hash, budget, and lifecycle controls', () => {
    expectColumn('platform_plans', 'id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expectColumn('platform_plans', 'client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE');
    expect(compactMigration).toMatch(/mode\s+TEXT\s+NOT NULL\s+CHECK \(mode IN \('proof', 'trusted_scheduled', 'impromptu'\)\)/);
    expect(compactMigration).toMatch(/status\s+TEXT\s+NOT NULL\s+DEFAULT 'preview'\s+CHECK \(status IN \('preview', 'pending_approval', 'approved', 'executed', 'blocked', 'expired'\)\)/);
    expect(migration).toContain('objective TEXT NOT NULL');
    expect(migration).toContain('requested_count INTEGER NOT NULL CHECK (requested_count > 0)');
    expect(migration).toContain('budget_cap_usd NUMERIC(10, 4) CHECK (budget_cap_usd IS NULL OR budget_cap_usd >= 0)');
    expect(migration).toContain('max_paid_queries INTEGER NOT NULL DEFAULT 0 CHECK (max_paid_queries >= 0)');
    expect(migration).toContain("stop_rule JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(migration).toContain("platform_sequence JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(migration).toContain("excluded_platforms JSONB NOT NULL DEFAULT '[]'::jsonb");
    expect(migration).toContain('query_set_hash TEXT NOT NULL');
    expect(migration).toContain('plan_hash TEXT NOT NULL');
    expect(migration).toContain('approval_required BOOLEAN NOT NULL DEFAULT TRUE');
    expect(migration).toContain('approved_by TEXT');
    expect(migration).toContain('approved_at TIMESTAMPTZ');
    expect(migration).toContain('executed_at TIMESTAMPTZ');
    expect(migration).not.toContain('executed_by UUID');
    expectTableContains('platform_plans', "CONSTRAINT platform_plans_client_id_id_key UNIQUE (client_id, id)");
    expectTableContains('platform_plans', "CONSTRAINT platform_plans_approved_by_nonblank CHECK (approved_by IS NULL OR length(trim(approved_by)) > 0)");
    expectTableContains('platform_plans', "CONSTRAINT platform_plans_executed_status_requires_executed_at CHECK (status <> 'executed' OR executed_at IS NOT NULL)");
    expectTableContains('platform_plans', "CONSTRAINT platform_plans_approval_required_state_check CHECK (approval_required = FALSE OR status NOT IN ('approved', 'executed') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))");
    expect(migration).toContain("result_summary JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(migration).toContain('blocker TEXT');
    expect(migration).toContain("created_by TEXT NOT NULL DEFAULT 'captain'");
    expect(migration).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(migration).toContain("expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')");
  });

  it('tracks query validity, source context, and full yield funnel counters', () => {
    expectColumn('platform_yield_events', 'id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expectColumn('platform_yield_events', 'client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE');
    expectColumn('platform_yield_events', 'plan_id UUID');
    expectColumn('platform_yield_events', 'directive_id UUID');
    expect(migration).not.toContain('plan_id UUID REFERENCES platform_plans(id) ON DELETE SET NULL');
    expect(migration).not.toContain('directive_id UUID REFERENCES agent_directives(id) ON DELETE SET NULL');
    expectTableContains('platform_yield_events', 'CONSTRAINT platform_yield_events_plan_tenant_fk FOREIGN KEY (client_id, plan_id) REFERENCES platform_plans(client_id, id) ON DELETE SET NULL (plan_id)');
    expectTableContains('platform_yield_events', 'CONSTRAINT platform_yield_events_directive_tenant_fk FOREIGN KEY (client_id, directive_id) REFERENCES agent_directives(client_id, id) ON DELETE SET NULL (directive_id)');
    expect(compactMigration).toMatch(/mode\s+TEXT\s+NOT NULL\s+CHECK \(mode IN \('preview', 'proof', 'trusted_scheduled', 'impromptu'\)\)/);
    expect(migration).toContain('platform TEXT NOT NULL');
    expect(migration).toContain('provider TEXT');
    expect(migration).toContain('signal_id TEXT');
    expect(migration).toContain('signal_family TEXT');
    expect(migration).toContain('source_channel TEXT');
    expect(migration).toContain('geo TEXT');
    expect(migration).toContain('query TEXT');
    expect(migration).toContain('query_hash TEXT');
    expect(migration).toContain('query_chars INTEGER NOT NULL DEFAULT 0 CHECK (query_chars >= 0)');
    expect(migration).toContain('query_words INTEGER NOT NULL DEFAULT 0 CHECK (query_words >= 0)');
    expect(migration).toContain('query_valid BOOLEAN NOT NULL DEFAULT TRUE');
    expect(migration).not.toContain('signal_type TEXT');
    expect(migration).not.toContain('source_url TEXT');
    expect(migration).not.toContain('source_title TEXT');
    expect(migration).not.toContain('source_type TEXT');
    expect(migration).not.toContain('query_text TEXT');

    [
      'paid_units',
      'raw_results',
      'raw_candidates',
      'icp_passed',
      'decision_makers_found',
      'contacts_found',
      'saved_leads',
      'approval_ready',
      'sent',
      'replies',
      'meetings'
    ].forEach((field) => {
      expect(migration).toContain(`${field} INTEGER NOT NULL DEFAULT 0 CHECK (${field} >= 0)`);
    });

    expect(migration).toContain("metadata JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(migration).toContain('blocker TEXT');
    expect(migration).toContain('error_code TEXT');
    expect(migration).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  });

  it('stores per-strategy trust state and downgrade history', () => {
    expectColumn('platform_strategy_state', 'id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expectColumn('platform_strategy_state', 'client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE');
    expect(compactMigration).toMatch(/status\s+TEXT\s+NOT NULL\s+DEFAULT 'proof'\s+CHECK \(status IN \('proof', 'trusted', 'suspended'\)\)/);
    expect(migration).toContain('strategy_key TEXT NOT NULL');
    expect(migration).toContain('signal_id TEXT');
    expect(migration).toContain('geo TEXT');
    expect(migration).toContain("platforms JSONB NOT NULL DEFAULT '[]'::jsonb");
    expectColumn('platform_strategy_state', 'last_plan_id UUID');
    expect(migration).not.toContain('last_plan_id UUID REFERENCES platform_plans(id) ON DELETE SET NULL');
    expectTableContains('platform_strategy_state', 'CONSTRAINT platform_strategy_state_last_plan_tenant_fk FOREIGN KEY (client_id, last_plan_id) REFERENCES platform_plans(client_id, id) ON DELETE SET NULL (last_plan_id)');
    expect(migration).toContain('last_plan_hash TEXT');
    expect(migration).toContain('last_yield_pct NUMERIC(6, 2) NOT NULL DEFAULT 0');
    expect(migration).toContain('last_requested_count INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('last_output_count INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('consecutive_green_runs INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('last_blocker TEXT');
    expect(migration).toContain('trusted_at TIMESTAMPTZ');
    expect(migration).toContain('trusted_by TEXT');
    expect(migration).toContain('downgraded_at TIMESTAMPTZ');
    expect(migration).toContain('downgrade_reason TEXT');
    expect(migration).toContain('updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(migration).toContain('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
    expect(migration).toContain('UNIQUE (client_id, strategy_key)');
  });

  it('adds recency and strategy indexes plus pending plan hash protection', () => {
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS idx_platform_plans_client_recent');
    expect(migration).toContain('ON platform_plans (client_id, created_at DESC)');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_plans_pending_hash');
    expect(migration).toContain('ON platform_plans (client_id, plan_hash)');
    expect(migration).toContain("WHERE status IN ('preview', 'pending_approval', 'approved')");
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_directives_client_id_id');
    expect(migration).toContain('ON agent_directives (client_id, id)');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS idx_platform_yield_events_client_recent');
    expect(migration).toContain('ON platform_yield_events (client_id, created_at DESC)');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS idx_platform_yield_events_strategy');
    expect(migration).toContain('ON platform_yield_events (client_id, platform, signal_id, geo, created_at DESC)');
  });

  it('runs as a tracked transaction migration', () => {
    expect(migration.trim().startsWith('BEGIN;')).toBe(true);
    expect(migration.trim().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain('INSERT INTO schema_migrations (version) VALUES (82) ON CONFLICT (version) DO NOTHING');
  });
});

describe('platform yield pure helpers', () => {
  it('calculates yield percentage against requested count', () => {
    expect(platformYield.calculateYieldPct({ outputCount: 2, requestedCount: 5 })).toBe(40);
    expect(platformYield.calculateYieldPct({ outputCount: 0, requestedCount: 5 })).toBe(0);
    expect(platformYield.calculateYieldPct({ outputCount: 3, requestedCount: 0 })).toBe(300);
  });

  it('classifies trust transition above 30 percent and downgrades zero output', () => {
    expect(platformYield.classifyStrategyHealth({
      requestedCount: 5,
      outputCount: 2,
      blocker: null,
    })).toEqual({
      status: 'trusted_candidate',
      yield_pct: 40,
      reason: 'yield_above_threshold',
    });

    expect(platformYield.classifyStrategyHealth({
      requestedCount: 5,
      outputCount: 0,
      blocker: 'signals_zero_after_llm_parse',
    })).toEqual({
      status: 'proof',
      yield_pct: 0,
      reason: 'signals_zero_after_llm_parse',
    });

    expect(platformYield.classifyStrategyHealth({
      requestedCount: 10,
      outputCount: 3,
      blocker: null,
    })).toEqual({
      status: 'proof',
      yield_pct: 30,
      reason: 'yield_below_threshold',
    });
  });

  it('records invalid provider queries in the platform yield ledger', async () => {
    let sql = '';
    let params = [];
    pool.query = async (query, values) => {
      sql = query;
      params = values;
      return { rows: [{ id: 'event-1' }] };
    };

    const longQuery = Array.from({ length: 60 }, (_, i) => `term${i}`).join(' ');
    const row = await platformYield.recordPlatformYield('client-1', {
      plan_id: 'plan-1',
      directive_id: 'directive-1',
      platform: 'jobstreet_my',
      provider: 'brave',
      mode: 'proof',
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'job_boards',
      geo: 'MY',
      query: longQuery,
      paid_units: 1,
      raw_results: 2,
      blocker: 'provider_query_limit_exceeded',
      metadata: { parser: 'hiring_job_board' },
    });

    expect(row.id).toBe('event-1');
    expect(sql).toContain('INSERT INTO platform_yield_events');
    expect(params[0]).toBe('client-1');
    expect(params[3]).toBe('jobstreet_my');
    expect(params[12]).toBeGreaterThan(0);
    expect(params[13]).toBe(60);
    expect(params[14]).toBe(false);
    expect(params[15]).toBe(1);
    expect(params[16]).toBe(2);
    expect(params[26]).toBe('provider_query_limit_exceeded');
    expect(JSON.parse(params[28]).parser).toBe('hiring_job_board');
  });

  it('tracks execution-time per-platform raw, extracted, vertical, and saved counts', () => {
    expect(typeof signalHunt._test.createPlatformFunnelTracker).toBe('function');
    expect(typeof signalHunt._test.platformFunnelFromSignalHuntResult).toBe('function');

    const tracker = signalHunt._test.createPlatformFunnelTracker({ mode: 'proof', planId: 'plan-1' });
    const jobstreet = {
      platform: 'jobstreet_my',
      provider: 'brave',
      signal_id: 'hiring_sales_roles',
      signal_family: 'hiring_capability_build',
      source_channel: 'job_boards',
      geo: 'MY',
      country: 'MY',
      query: 'site:my.jobstreet.com ("sales executive") Malaysia',
    };
    const hiredly = {
      ...jobstreet,
      platform: 'hiredly_my',
      source_channel: 'job_boards',
      query: 'site:hiredly.com ("sales executive") Malaysia',
    };

    tracker.recordSearch(jobstreet, [{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    tracker.recordExtraction(jobstreet, 2);
    tracker.recordSearch(hiredly, [{ title: 'D' }, { title: 'E' }, { title: 'F' }]);
    tracker.recordExtraction(hiredly, 1);
    tracker.recordVerticalVerified({ platform: 'hiredly_my', provider: 'brave' });

    const funnel = tracker.withSavedLeads([
      { metadata: { signal_package: { platform: 'hiredly_my' } } },
    ]);

    expect(funnel).toEqual(expect.arrayContaining([
      expect.objectContaining({
        platform: 'jobstreet_my',
        raw_results: 3,
        extracted_signals: 2,
        vertical_verified: 0,
        saved_leads: 0,
      }),
      expect.objectContaining({
        platform: 'hiredly_my',
        raw_results: 3,
        extracted_signals: 1,
        vertical_verified: 1,
        saved_leads: 1,
      }),
    ]));
  });

  it('records platform yield from the Signal Hunt funnel instead of reconstructing from saved leads only', () => {
    expect(typeof platformYield.recordSignalHuntPlatformFunnel).toBe('function');
    expect(autonomousSource).toContain('platformFunnelFromSignalHuntResult(leads)');
    expect(autonomousSource).toContain('recordSignalHuntPlatformFunnel(clientId');
    expect(autonomousSource).not.toContain('candidateCountForPlatform');
    expect(autonomousSource).not.toContain('raw_candidates: candidatesForPlatform');
    expect(dbBuilderSource).toContain('recordSignalHuntPlatformFunnel(client.id');
    expect(signalHuntSource).toContain('platform_funnel');
  });
});
