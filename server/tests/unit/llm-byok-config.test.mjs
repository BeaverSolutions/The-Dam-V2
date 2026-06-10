import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const llmConfig = require('../../services/llmConfig');

// Injected secrets store — llmConfig._test seam (repo pattern: agents._test).
const secrets = {
  getClientSecret: vi.fn(),
  setClientSecret: vi.fn().mockResolvedValue(undefined),
  deleteClientSecret: vi.fn().mockResolvedValue(undefined),
};

const BEAVER_ID = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';
const TENANT_ID = 'c332844d-1291-425a-8a42-75ecf0724c9a';

const ENV_KEYS = ['LLM_PROVIDER', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'BEAVER_SOLUTIONS_CLIENT_ID'];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  secrets.getClientSecret.mockReset();
  secrets.setClientSecret.mockClear();
  secrets.deleteClientSecret.mockClear();
  llmConfig._test.setSecretsStore(secrets);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  llmConfig._test.resetSecretsStore();
});

describe('llmConfig.getConfig — tenant key wins', () => {
  it('returns the tenant llm_config secret when present', async () => {
    secrets.getClientSecret.mockResolvedValue({ provider: 'openai', key: 'sk-tenant' });

    const config = await llmConfig.getConfig(TENANT_ID);

    expect(secrets.getClientSecret).toHaveBeenCalledWith(TENANT_ID, 'system', 'llm_config');
    expect(config).toEqual({ provider: 'openai', key: 'sk-tenant', tenant_key: true });
  });

  it('tenant secret wins even for the Beaver client', async () => {
    process.env.OPENAI_API_KEY = 'sk-platform';
    secrets.getClientSecret.mockResolvedValue({ provider: 'anthropic', key: 'sk-ant-tenant' });

    const config = await llmConfig.getConfig(BEAVER_ID);

    expect(config).toEqual({ provider: 'anthropic', key: 'sk-ant-tenant', tenant_key: true });
  });

  it('rejects a tenant secret with an unknown provider', async () => {
    secrets.getClientSecret.mockResolvedValue({ provider: 'gemini', key: 'whatever' });

    const config = await llmConfig.getConfig(TENANT_ID);

    expect(config).toBeNull();
  });
});

describe('llmConfig.getConfig — Beaver-only env fallback', () => {
  it('Beaver client falls back to env keys when no tenant secret exists', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    secrets.getClientSecret.mockResolvedValue(null);

    const config = await llmConfig.getConfig(BEAVER_ID);

    expect(config).toEqual({ provider: 'openai', key: 'sk-platform', tenant_key: false });
  });

  it('Beaver env fallback resolves anthropic when LLM_PROVIDER is anthropic', async () => {
    process.env.LLM_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';
    secrets.getClientSecret.mockResolvedValue(null);

    const config = await llmConfig.getConfig(BEAVER_ID);

    expect(config).toEqual({ provider: 'anthropic', key: 'sk-ant-platform', tenant_key: false });
  });

  it('Beaver env fallback defaults to openai when OPENAI_API_KEY is set without LLM_PROVIDER', async () => {
    process.env.OPENAI_API_KEY = 'sk-platform';
    secrets.getClientSecret.mockResolvedValue(null);

    const config = await llmConfig.getConfig(BEAVER_ID);

    expect(config).toEqual({ provider: 'openai', key: 'sk-platform', tenant_key: false });
  });

  it('external tenant NEVER falls back to env keys', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'sk-platform';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-platform';
    secrets.getClientSecret.mockResolvedValue(null);

    const config = await llmConfig.getConfig(TENANT_ID);

    expect(config).toBeNull();
  });

  it('returns null for a null clientId', async () => {
    process.env.OPENAI_API_KEY = 'sk-platform';

    const config = await llmConfig.getConfig(null);

    expect(config).toBeNull();
    expect(secrets.getClientSecret).not.toHaveBeenCalled();
  });
});

describe('llmConfig.requireConfig — hard block for unkeyed external tenants', () => {
  it('throws LLM_TENANT_KEY_MISSING for an external tenant without a key', async () => {
    process.env.OPENAI_API_KEY = 'sk-platform';
    secrets.getClientSecret.mockResolvedValue(null);

    await expect(llmConfig.requireConfig(TENANT_ID)).rejects.toMatchObject({
      code: 'LLM_TENANT_KEY_MISSING',
      status: 400,
    });
  });

  it('returns the config when the tenant has a key', async () => {
    secrets.getClientSecret.mockResolvedValue({ provider: 'openai', key: 'sk-tenant' });

    const config = await llmConfig.requireConfig(TENANT_ID);

    expect(config.key).toBe('sk-tenant');
  });
});

describe('llmConfig.getStatus — never leaks the key', () => {
  it('reports tenant key connected without exposing the key', async () => {
    secrets.getClientSecret.mockResolvedValue({ provider: 'openai', key: 'sk-tenant' });

    const status = await llmConfig.getStatus(TENANT_ID);

    expect(status.connected).toBe(true);
    expect(status.tenant_key).toBe(true);
    expect(status.platform_fallback).toBe(false);
    expect(status.provider).toBe('openai');
    expect(JSON.stringify(status)).not.toContain('sk-tenant');
  });

  it('reports platform fallback for Beaver without a tenant key', async () => {
    process.env.OPENAI_API_KEY = 'sk-platform';
    secrets.getClientSecret.mockResolvedValue(null);

    const status = await llmConfig.getStatus(BEAVER_ID);

    expect(status.connected).toBe(true);
    expect(status.tenant_key).toBe(false);
    expect(status.platform_fallback).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-platform');
  });

  it('reports not configured for an unkeyed external tenant', async () => {
    process.env.OPENAI_API_KEY = 'sk-platform';
    secrets.getClientSecret.mockResolvedValue(null);

    const status = await llmConfig.getStatus(TENANT_ID);

    expect(status.connected).toBe(false);
    expect(status.tenant_key).toBe(false);
    expect(status.platform_fallback).toBe(false);
  });
});

describe('llmConfig.setConfig / deleteConfig', () => {
  it('stores provider + key as the llm_config secret', async () => {
    await llmConfig.setConfig(TENANT_ID, 'openai', 'sk-new');

    expect(secrets.setClientSecret).toHaveBeenCalledWith(
      TENANT_ID, 'system', 'llm_config', { provider: 'openai', key: 'sk-new' }
    );
  });

  it('rejects an invalid provider', async () => {
    await expect(llmConfig.setConfig(TENANT_ID, 'gemini', 'sk-new')).rejects.toMatchObject({
      code: 'LLM_PROVIDER_INVALID',
    });
    expect(secrets.setClientSecret).not.toHaveBeenCalled();
  });

  it('rejects an empty key', async () => {
    await expect(llmConfig.setConfig(TENANT_ID, 'openai', '  ')).rejects.toMatchObject({
      code: 'LLM_KEY_INVALID',
    });
    expect(secrets.setClientSecret).not.toHaveBeenCalled();
  });

  it('deletes the llm_config secret', async () => {
    await llmConfig.deleteConfig(TENANT_ID);

    expect(secrets.deleteClientSecret).toHaveBeenCalledWith(TENANT_ID, 'system', 'llm_config');
  });
});

describe('llmConfig.isConfigured', () => {
  it('true when tenant key exists', async () => {
    secrets.getClientSecret.mockResolvedValue({ provider: 'openai', key: 'sk-tenant' });
    expect(await llmConfig.isConfigured(TENANT_ID)).toBe(true);
  });

  it('false for unkeyed external tenant even with platform env keys', async () => {
    process.env.OPENAI_API_KEY = 'sk-platform';
    secrets.getClientSecret.mockResolvedValue(null);
    expect(await llmConfig.isConfigured(TENANT_ID)).toBe(false);
  });
});
