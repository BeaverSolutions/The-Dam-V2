import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Import the real module — it has no external deps (no pool, no claude)
const { evaluateLeadQuality } = require('../../utils/leadQuality');

describe('Lead Quality Gate', () => {
  describe('valid leads pass', () => {
    it('passes normal company + name', () => {
      const result = evaluateLeadQuality({ name: 'Ahmad Razak', company: 'Kingdom Digital' });
      expect(result.ok).toBe(true);
    });

    it('passes company with numbers', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'Agency360' });
      expect(result.ok).toBe(true);
    });
  });

  describe('rejects placeholder companies', () => {
    const placeholders = [
      'Independent', 'Self-Employed', 'Stealth', 'Stealth Mode',
      'Confidential', 'N/A', 'Unknown', 'Agency', 'TBD',
      'AI Startup', 'B2B Sales', 'B2B Consulting',
    ];

    for (const company of placeholders) {
      it(`rejects "${company}"`, () => {
        const result = evaluateLeadQuality({ name: 'Test Person', company });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('placeholder_company');
      });
    }
  });

  describe('rejects prefix patterns', () => {
    it('rejects "Freelance Marketing"', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'Freelance Marketing' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('placeholder_prefix');
    });

    it('rejects "Freelancer Design"', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'Freelancer Design Studio' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('placeholder_prefix');
    });
  });

  describe('rejects suffix patterns', () => {
    it('rejects "Penang Agency" (hits exact placeholder match)', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'Penang Agency' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('placeholder_company');
    });

    it('rejects "KL Marketing Agency"', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'KL Marketing Agency' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('placeholder_suffix');
    });
  });

  describe('rejects slash-separated with placeholder', () => {
    it('rejects "Avion School / Independent"', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'Avion School / Independent' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('slash_with_placeholder');
    });
  });

  describe('rejects name equals company (freelancer pattern)', () => {
    it('rejects "John Smith" at "John Smith"', () => {
      const result = evaluateLeadQuality({ name: 'John Smith', company: 'John Smith' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('name_equals_company');
    });
  });

  describe('rejects missing company', () => {
    it('rejects null company', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: null });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no_company');
    });

    it('rejects empty string company', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: '' });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('no_company');
    });
  });

  describe('rejects invalid input', () => {
    it('rejects null lead', () => {
      const result = evaluateLeadQuality(null);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('lead_not_object');
    });

    it('rejects undefined lead', () => {
      const result = evaluateLeadQuality(undefined);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('lead_not_object');
    });
  });

  describe('legitimate companies pass despite similar names', () => {
    it('passes "Kingdom Digital" (real agency)', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'Kingdom Digital' });
      expect(result.ok).toBe(true);
    });

    it('passes "LOCUS-T Creative" (real agency)', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'LOCUS-T Creative' });
      expect(result.ok).toBe(true);
    });

    it('passes "GoViral Lab" (real agency)', () => {
      const result = evaluateLeadQuality({ name: 'Test', company: 'GoViral Lab' });
      expect(result.ok).toBe(true);
    });
  });
});
