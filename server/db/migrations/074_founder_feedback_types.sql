-- 074_founder_feedback_types.sql
-- The Approvals UI's "Teach the beaver" button writes feedback_type='founder_note',
-- and newer feedback paths write borderline/manual-send variants. Production still
-- allowed only ('edit','rejection'), so those writes were silently dropped by
-- non-fatal feedback capture blocks.

ALTER TABLE founder_feedback
  DROP CONSTRAINT IF EXISTS founder_feedback_feedback_type_check;

ALTER TABLE founder_feedback
  ADD CONSTRAINT founder_feedback_feedback_type_check
  CHECK (
    feedback_type IN (
      'edit',
      'rejection',
      'borderline_edit_apply',
      'borderline_apply_suggestion',
      'borderline_skip',
      'manual_ui_send_edit',
      'manual_chrome_send_edit',
      'founder_note'
    )
  );
