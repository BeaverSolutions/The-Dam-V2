import { createRequire } from 'module';
import { vi, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const poolMock = vi.hoisted(() => ({
  rows: [],
  query: vi.fn(),
  withTenant: vi.fn(),
}));

poolMock.withTenant.mockImplementation(async (clientId, fn) => {
  poolMock.query = vi.fn().mockResolvedValue({ rows: poolMock.rows });
  return fn({ query: poolMock.query });
});

const poolPath = require.resolve('../../db/pool.js');
const tenantContextPath = require.resolve('../../services/tenantContext.js');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: poolMock,
};
delete require.cache[tenantContextPath];

const tenantContext = require('../../services/tenantContext.js');
const {
  createAuthContext,
  getLegacyIcpForClient,
  getTenantContext,
} = tenantContext;

function activeProfile(profile) {
  poolMock.rows = [{
    schema_version: 1,
    content_version: 5,
    status: 'active',
    profile,
  }];
}

function baseProfile(overrides = {}) {
  const icp = {
    verticals: ['B2B agencies', 'corporate training'],
    personas: ['Founder', 'CEO', 'Head of Sales'],
    geo: ['MY', 'SG'],
    exclusions: ['enterprise brands'],
    competitor_offers: ['lead generation', 'cold email', 'sales automation', 'AI outbound', 'SDR-as-a-service'],
    ...(overrides.icp || {}),
  };
  return {
    identity: {
      company: 'Beaver Solutions',
      founder: { name: 'MJ', role: 'Founder', linkedin_url: null },
      sender_persona: { name: 'Michael Jerry', title: 'Founder', email: 'mj@beaver.solutions' },
      brand_voice: 'direct and specific',
    },
    offer: {
      product: 'BeavrDam',
      services: ['AI outbound team'],
      pricing: { tiers: [] },
      positioning: 'Agentic outbound team for founder-led B2B companies',
    },
    icp,
    proof: [],
    voice: {
      tone: ['plainspoken'],
      do: ['be specific'],
      dont: ['sound generic'],
      examples: {
        good: ['good one', 'good two', 'good three'],
        bad: ['bad one', 'bad two'],
      },
    },
    constraints: {
      word_cap_by_channel: { email: 90, linkedin_dm: 80, linkedin_invite: 280 },
      banned_phrases: [],
      signoff_by_channel: { email: 'Regards,\nMichael Jerry', linkedin_dm: null, linkedin_invite: null },
      max_links: 1,
      allow_emoji: false,
    },
    documents: [],
    ...overrides,
    icp,
  };
}

describe('tenant context buying signal runtime contract', () => {
  beforeEach(() => {
    poolMock.rows = [];
    poolMock.withTenant.mockClear();
  });

  it('blocks active tenant context when buying signals are missing', async () => {
    activeProfile(baseProfile({ buying_signals: [] }));

    const ctx = await getTenantContext(
      createAuthContext({ clientId: 'client-1', source: 'service' }),
      { role: 'research' }
    );

    expect(ctx).toMatchObject({
      active: false,
      reason: 'tenant_buying_signals_missing',
      content_version: 5,
    });
  });

  it('returns an explicit blocker from the legacy ICP bridge instead of fallback defaults', async () => {
    activeProfile(baseProfile({ buying_signals: [] }));

    const icp = await getLegacyIcpForClient('client-1', {
      source: 'service',
      fallback: {
        industries: 'digital agency, recruitment agency',
        buying_signals: [{ id: 'legacy-default', enabled: true }],
      },
    });

    expect(icp).toMatchObject({
      blocked: true,
      blocker: 'tenant_buying_signals_missing',
      reason: 'tenant_buying_signals_missing',
      source: 'tenant_profiles',
      content_version: 5,
    });
    expect(icp.buying_signals).toEqual([]);
  });

  it('projects active tenant geo as both array and legacy string for Signal Hunt callers', async () => {
    activeProfile(baseProfile({
      icp: {
        active_industries: ['roofing'],
        verticals: ['roofing_contractor'],
        personas: ['Owner', 'Founder'],
        geo: ['United States', 'Canada'],
      },
      buying_signals: [
        {
          id: 'roofing_hiring_sales_ops',
          family: 'hiring_capability_build',
          enabled: true,
          priority: 1,
          query_terms: ['roofing company hiring sales rep'],
          source_channels: ['linkedin_jobs', 'web_search'],
          evidence_required: ['company', 'role', 'source_url'],
          decision_maker_strategy: ['company_website_team_page'],
          stop_rules: { max_queries: 8, max_candidates: 15, stop_if_zero_after: 4 },
          reject_rules: { exclusions: [], competitor_offers: [] },
        },
      ],
    }));

    const icp = await getLegacyIcpForClient('client-1', { source: 'service' });

    expect(icp).toMatchObject({
      source: 'tenant_profiles',
      geo: ['United States', 'Canada'],
      geographies: 'United States, Canada',
      active_industries: ['roofing'],
    });
  });
});
