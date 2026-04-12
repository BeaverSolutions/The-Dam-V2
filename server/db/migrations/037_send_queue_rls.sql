-- 037: Enable RLS on send_queue table
-- send_queue contains approved message email addresses, subjects, retry state.
-- Without RLS, a bypassed auth layer exposes all clients' outbound email data.

ALTER TABLE send_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON send_queue
  USING (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);

CREATE POLICY tenant_isolation_insert ON send_queue
  FOR INSERT
  WITH CHECK (client_id = NULLIF(current_setting('app.current_client_id', true), '')::UUID);
