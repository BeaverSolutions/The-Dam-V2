import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const etris = require('../../services/providers/etrisDirectory.js');

const browseHtml = `
  <html><head><link rel="canonical" href="https://etris.my/training-providers/browse/a/"></head>
  <body>
    <ul>
      <li><a href="/training-provider/accordia-training/">Accordia Training &amp; Development Sdn Bhd</a><span>Selangor</span></li>
      <li><a href="/training-provider/aaa-training-consultancy-solution/">AAA Training &amp; Consultancy Solution</a></li>
      <li><a href="/not-a-provider/">Ignore Me</a></li>
      <li><a href="/training-provider/accordia-training/">Accordia Training &amp; Development Sdn Bhd</a></li>
    </ul>
  </body></html>`;

const providerHtml = `
  <html><head>
    <link rel="canonical" href="https://etris.my/training-provider/accordia-training/">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Accordia Training & Development Sdn Bhd","description":"Accordia Training & Development Sdn Bhd is an HRD Corp-registered provider for simulation and game-based corporate training in Malaysia.","email":"team@accordia.com.my","telephone":"+603 8075 0386","areaServed":[{"@type":"AdministrativeArea","name":"Selangor"}],"knowsAbout":["team building","leadership","trainer development"]}</script>
  </head><body>
    <h1>Accordia Training &amp; Development Sdn Bhd</h1>
    <span>Last verified: 12 Mar 2026</span>
    <dl>
      <dt>HRD Corp registration</dt><dd>Registered (listed in ETRIS)</dd>
      <dt>Category</dt><dd>professional services</dd>
      <dt>Location</dt><dd>Selangor, Malaysia</dd>
      <dt>ETRIS record</dt><dd>#3004</dd>
      <dt>Last verified</dt><dd>12 Mar 2026</dd>
    </dl>
    <table><tbody>
      <tr><td>Registration</td><td>872429V</td></tr>
    </tbody></table>
  </body></html>`;

describe('ETRIS directory provider', () => {
  it('parses bounded provider links from A-Z browse pages and dedupes provider URLs', () => {
    const providers = etris.parseBrowsePage(browseHtml, {
      sourceUrl: 'https://etris.my/training-providers/browse/a/',
    });

    expect(providers).toEqual([
      {
        name: 'Accordia Training & Development Sdn Bhd',
        state: 'Selangor',
        source_url: 'https://etris.my/training-provider/accordia-training/',
      },
      {
        name: 'AAA Training & Consultancy Solution',
        state: null,
        source_url: 'https://etris.my/training-provider/aaa-training-consultancy-solution/',
      },
    ]);
  });

  it('parses provider pages into compact ETRIS facts without storing the full page body', () => {
    const provider = etris.parseProviderPage(providerHtml, {
      sourceUrl: 'https://etris.my/training-provider/accordia-training/',
    });

    expect(provider).toMatchObject({
      name: 'Accordia Training & Development Sdn Bhd',
      category: 'professional services',
      state: 'Selangor',
      email: 'team@accordia.com.my',
      phone: '+603 8075 0386',
      etris_record: '3004',
      registration: '872429V',
      last_verified: '2026-03-12',
      source_url: 'https://etris.my/training-provider/accordia-training/',
      training_areas: ['team building', 'leadership', 'trainer development'],
    });
    expect(JSON.stringify(provider)).not.toContain('<dl>');
  });

  it('maps a provider page into a Signal Hunt source package for Beaver training ICP', () => {
    const provider = etris.parseProviderPage(providerHtml, {
      sourceUrl: 'https://etris.my/training-provider/accordia-training/',
    });
    const signal = etris.providerToSignal(provider, {
      signal_id: 'etris_registered_training_provider',
      signal_family: 'pain_friction_evidence',
      tier: 'P1',
    });

    expect(signal).toMatchObject({
      company: 'Accordia Training & Development Sdn Bhd',
      source_url: 'https://etris.my/training-provider/accordia-training/',
      source_channel: 'etris_directory',
      provider: 'etris_directory',
      platform: 'etris_directory',
      country: 'MY',
      tier: 'P1',
      confidence: 0.8,
      metadata: {
        etris_record: '3004',
        registration: '872429V',
        contact: {
          email: 'team@accordia.com.my',
          phone: '+603 8075 0386',
        },
      },
    });
    expect(signal.why_now).toContain('last verified 2026-03-12');
    expect(signal.raw_snippet).toContain('simulation and game-based corporate training');
  });

  it('walks browse pages politely and caps provider detail fetches', async () => {
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      status: 200,
      text: async () => String(url).includes('/browse/a/') ? browseHtml : providerHtml,
    }));

    const signals = await etris.fetchEtrisSignals({
      letters: ['a'],
      max_provider_pages: 1,
      signal_id: 'etris_registered_training_provider',
    }, { fetchImpl });

    expect(signals).toHaveLength(1);
    expect(signals[0].company).toBe('Accordia Training & Development Sdn Bhd');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toContain('BeavrDam');
  });
});
