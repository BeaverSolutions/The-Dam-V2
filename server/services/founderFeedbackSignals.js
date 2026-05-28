'use strict';

// Conservative classifier for feedback that is about lead selection, not copy.
// Vague draft complaints should not kill a good lead; explicit ICP/geo/source
// complaints should stop Research/Captain from selecting it again.
const LEAD_SELECTION_REJECTION_REGEX = /\b(india|wrong\s+(geo|geography|country|location|icp|lead|source|company)|outside\s+(the\s+)?(geo|geography|country|icp|target|targeting)|out\s+of\s+(geo|geography|country|icp|target)|not\s+(in|our|my)\s+(geo|geography|country|icp|target)|not\s+a\s+(fit|good\s+lead)|bad\s+lead|off[\s-]?icp|source\s+(is\s+)?wrong)\b/i;
const GEO_REJECTION_REGEX = /\b(india|wrong\s+(geo|geography|country|location)|outside\s+(the\s+)?(geo|geography|country)|out\s+of\s+(geo|geography|country)|not\s+(in|our|my)\s+(geo|geography|country)|not\s+in\s+(my|sg|us|malaysia|singapore|united\s+states))\b/i;

const LEAD_SELECTION_REJECTION_SQL =
  '(india|wrong[[:space:]]+(geo|geography|country|location|icp|lead|source|company)|outside[[:space:]]+(the[[:space:]]+)?(geo|geography|country|icp|target|targeting)|out[[:space:]]+of[[:space:]]+(geo|geography|country|icp|target)|not[[:space:]]+(in|our|my)[[:space:]]+(geo|geography|country|icp|target)|not[[:space:]]+a[[:space:]]+(fit|good[[:space:]]+lead)|bad[[:space:]]+lead|off[[:space:]-]?icp|source[[:space:]]+(is[[:space:]]+)?wrong)';

function isLeadSelectionFeedback(note) {
  return LEAD_SELECTION_REJECTION_REGEX.test(String(note || ''));
}

function isGeoSelectionFeedback(note) {
  return GEO_REJECTION_REGEX.test(String(note || ''));
}

function leadStatusForFeedback(note) {
  return isGeoSelectionFeedback(note) ? 'rejected_country' : 'rejected_persona';
}

function leadSelectionFeedbackExclusionSql(leadAlias = 'l') {
  return `AND NOT EXISTS (
          SELECT 1
            FROM founder_feedback ff
           WHERE ff.client_id = ${leadAlias}.client_id
             AND ff.lead_id = ${leadAlias}.id
             AND ff.feedback_type IN ('rejection', 'founder_note', 'borderline_skip')
             AND COALESCE(ff.rejection_reason, '') ~* '${LEAD_SELECTION_REJECTION_SQL}'
        )`;
}

module.exports = {
  LEAD_SELECTION_REJECTION_REGEX,
  LEAD_SELECTION_REJECTION_SQL,
  isLeadSelectionFeedback,
  isGeoSelectionFeedback,
  leadStatusForFeedback,
  leadSelectionFeedbackExclusionSql,
};
