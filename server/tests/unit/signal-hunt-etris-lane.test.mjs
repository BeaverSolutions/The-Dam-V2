import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const signalHunt = require('../../services/signalHunt.js');
const source = (p) => readFileSync(resolve(__dirname, '../../', p), 'utf-8');

describe('Signal Hunt ETRIS directory lane', () => {
  it('bumps parser version for the new free directory extraction lane', () => {
    expect(source('services/signalHunt.js')).toContain("SIGNAL_HUNT_PARSER_VERSION = 'universal_signal_planner_v6'");
  });

  it('builds ETRIS directory queries only for explicit MY training-provider signals', () => {
    const query = signalHunt._test.buildEtrisDirectoryQueriesFromIcp({
      active_industries: ['B2B corporate training', 'sales coaching'],
      geo: ['Malaysia'],
    }, {
      id: 'etris_registered_training_provider',
      family: 'pain_friction_evidence',
      source_channels: ['etris_directory'],
      stop_rules: { letters: ['a', 'b'], max_provider_pages: 3 },
    })[0];

    expect(query).toMatchObject({
      query: 'ETRIS training providers browse a,b',
      provider: 'etris_directory',
      platform: 'etris_directory',
      source_channel: 'etris_directory',
      cost_class: 'free_directory',
      country: 'MY',
      signal_id: 'etris_registered_training_provider',
      signal_family: 'pain_friction_evidence',
      letters: ['a', 'b'],
      max_provider_pages: 3,
    });

    expect(signalHunt._test.buildEtrisDirectoryQueriesFromIcp({
      active_industries: ['roofing contractors'],
      geo: ['United States'],
    }, {
      id: 'etris_registered_training_provider',
      source_channels: ['etris_directory'],
    })).toEqual([]);

    expect(signalHunt._test.buildEtrisDirectoryQueriesFromIcp({
      active_industries: ['B2B corporate training'],
      geo: ['Malaysia'],
    }, {
      id: 'normal_training_signal',
      source_channels: ['web_search'],
    })).toEqual([]);
  });

  it('normalizes ETRIS provider queries without converting them into paid search', () => {
    const normalized = signalHunt._test.normalizeSignalQuery({
      query: 'ETRIS training providers browse a',
      provider: 'etris_directory',
      platform: 'etris_directory',
      source_channel: 'etris_directory',
      cost_class: 'free_directory',
      country: 'MY',
      letters: ['a'],
      max_provider_pages: 2,
    });

    expect(normalized).toMatchObject({
      provider: 'etris_directory',
      platform: 'etris_directory',
      source_channel: 'etris_directory',
      cost_class: 'free_directory',
      country: 'MY',
      letters: ['a'],
      max_provider_pages: 2,
    });
  });

  it('keeps free ETRIS provider queries executable when paid discovery budget is zero', () => {
    const executable = signalHunt._test.executableDiscoveryQueriesForBudget([
      { query: 'paid web query', provider: 'brave', country: 'MY' },
      {
        query: 'ETRIS training providers browse a',
        provider: 'etris_directory',
        source_channel: 'etris_directory',
        cost_class: 'free_directory',
        country: 'MY',
      },
    ], { discovery: 0 });

    expect(executable).toEqual([{
      query: 'ETRIS training providers browse a',
      provider: 'etris_directory',
      source_channel: 'etris_directory',
      cost_class: 'free_directory',
      country: 'MY',
    }]);
  });

  it('has a Signal Hunt provider branch for ETRIS that does not consume paid query budget', () => {
    const src = source('services/signalHunt.js');
    expect(src).toContain("require('./providers/etrisDirectory')");
    expect(src).toContain('isEtrisDirectoryQuery(q)');
    expect(src).toContain('fetchEtrisSignals(q');
    expect(src).toContain('if (!isFreeSignalProviderQuery(q) && !consumePaidQuery(1))');
  });
});
