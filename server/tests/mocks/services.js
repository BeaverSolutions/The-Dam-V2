'use strict';

const { vi } = require('vitest');

// Hunter email finder mock
const hunterService = {
  findEmail: vi.fn(async (domain, name) => ({
    email: `${name.toLowerCase().replace(/\s+/g, '.')}@${domain}`,
    score: 85,
    source: 'hunter',
  })),
  reset() {
    this.findEmail.mockClear();
  },
};

// VP enrichment mock
const vpService = {
  findVerifiedEmail: vi.fn(async (lead) => ({
    email: lead.email || `vp-found@${(lead.company || 'unknown').toLowerCase().replace(/\s+/g, '')}.com`,
    verified: true,
    source: 'vp',
  })),
  reset() {
    this.findVerifiedEmail.mockClear();
  },
};

// Pipeline trace mock — records trace calls without hitting DB
let traceCalls = [];
const pipelineTrace = {
  traceStage: vi.fn(async (clientId, payload) => {
    traceCalls.push({ clientId, ...payload });
  }),
  getCalls() {
    return traceCalls;
  },
  reset() {
    traceCalls = [];
    this.traceStage.mockClear();
  },
};

// Tenant config mock
const tenantConfig = {
  getTenantConfig: vi.fn(async (clientId) => ({
    client_id: clientId,
    auto_approve_threshold: 80,
    daily_send_cap: 50,
    enforcer_enabled: true,
    vp_credits_remaining: 100,
  })),
  chargeVpCredits: vi.fn(async () => true),
  reset() {
    this.getTenantConfig.mockClear();
    this.chargeVpCredits.mockClear();
  },
};

function resetAll() {
  hunterService.reset();
  vpService.reset();
  pipelineTrace.reset();
  tenantConfig.reset();
}

module.exports = {
  hunterService,
  vpService,
  pipelineTrace,
  tenantConfig,
  resetAll,
};
