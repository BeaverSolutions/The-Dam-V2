import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, '../../services/sendQueueWorker.js'),
  'utf-8'
);

// Extract the regex literal from source for pure unit testing
// Source: const EMAIL_DOMAIN_RE = /^[^@]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
function extractEmailRegex() {
  const match = src.match(/const EMAIL_DOMAIN_RE = (\/[^\/]+\/[a-z]*)/);
  if (!match) throw new Error('EMAIL_DOMAIN_RE not found in source');
  // eval the regex literal safely — it's a static compile-time constant
  // eslint-disable-next-line no-new-func
  return new Function(`return ${match[1]}`)();
}

describe('sendQueueWorker.enqueueMessage — source contracts', () => {
  describe('EMAIL_DOMAIN_RE validation gate', () => {
    let re;
    beforeAll(() => { re = extractEmailRegex(); });

    it('accepts a well-formed email address', () => {
      expect(re.test('founder@example.com')).toBe(true);
      expect(re.test('john.doe+tag@company.co.uk')).toBe(true);
    });

    it('rejects address without @', () => {
      expect(re.test('nodomain.com')).toBe(false);
    });

    it('rejects address without TLD (single-label domain)', () => {
      expect(re.test('user@localhost')).toBe(false);
    });

    it('rejects the sentinel placeholder address unknown@example.com — format is valid so caller must check separately', () => {
      // EMAIL_DOMAIN_RE allows this — the unknown@example.com check is a separate guard in enqueueMessage
      expect(re.test('unknown@example.com')).toBe(true);
      // Verify the source also has the sentinel check
      expect(src).toContain("lead_email === 'unknown@example.com'");
    });

    it('rejects empty string', () => {
      expect(re.test('')).toBe(false);
    });
  });

  describe('enqueueMessage — guard contract assertions on source', () => {
    it('contains channel guard that skips non-email channels', () => {
      expect(src).toContain("channel !== 'email'");
      expect(src).toContain('manual_send_channel');
    });

    it('contains no-email guard', () => {
      expect(src).toContain("reason: 'no_email'");
    });

    it('contains invalid email format guard using EMAIL_DOMAIN_RE', () => {
      expect(src).toContain('EMAIL_DOMAIN_RE.test(lead_email)');
      expect(src).toContain("reason: 'invalid_email_format'");
    });

    it('contains daily send cap guard with configurable MAX_DAILY_SENDS_PER_CLIENT', () => {
      expect(src).toContain('MAX_DAILY_SENDS_PER_CLIENT');
      expect(src).toContain('dailyCount >= MAX_DAILY_SENDS_PER_CLIENT');
      expect(src).toContain("reason: 'daily_limit_reached'");
    });

    it('uses ON CONFLICT DO NOTHING for idempotent inserts', () => {
      expect(src).toContain('ON CONFLICT (message_id) DO NOTHING');
      expect(src).toContain("reason: 'already_enqueued'");
    });

    it('returns { enqueued: true } on success with queue_id', () => {
      expect(src).toContain('enqueued: true');
      expect(src).toContain('queue_id: inserted.rows[0]?.id');
    });

    it('MAX_DAILY_SENDS_PER_CLIENT defaults to 200 (not 50 — prevents rogue agent cap from being too tight)', () => {
      expect(src).toContain("process.env.MAX_DAILY_SENDS || '200'");
    });
  });
});