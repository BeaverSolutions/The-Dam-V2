import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isLeadSelectionFeedback,
  isGeoSelectionFeedback,
  leadStatusForFeedback,
  leadSelectionFeedbackExclusionSql,
} = require('../../services/founderFeedbackSignals.js');

describe('founder feedback signal classifier', () => {
  it('treats wrong-geo teach notes as lead-selection feedback', () => {
    const note = 'India lead, outside ICP geography';

    expect(isLeadSelectionFeedback(note)).toBe(true);
    expect(isGeoSelectionFeedback(note)).toBe(true);
    expect(leadStatusForFeedback(note)).toBe('rejected_country');
  });

  it('treats wrong-ICP/source notes as lead-selection feedback without assuming geography', () => {
    const note = 'Wrong source and not our ICP';

    expect(isLeadSelectionFeedback(note)).toBe(true);
    expect(isGeoSelectionFeedback(note)).toBe(false);
    expect(leadStatusForFeedback(note)).toBe('rejected_persona');
  });

  it('does not kill good leads for copy-only feedback', () => {
    const note = 'opener is too long, lead with the trigger';

    expect(isLeadSelectionFeedback(note)).toBe(false);
    expect(isGeoSelectionFeedback(note)).toBe(false);
  });

  it('generates an eligibility exclusion predicate for DB-first selectors', () => {
    const sql = leadSelectionFeedbackExclusionSql('l');

    expect(sql).toContain('founder_feedback ff');
    expect(sql).toContain('ff.lead_id = l.id');
    expect(sql).toContain("'founder_note'");
    expect(sql).toContain('COALESCE(ff.rejection_reason');
  });
});
