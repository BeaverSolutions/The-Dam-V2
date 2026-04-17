-- Migration 046: Official launch reset for beaver-solutions
--
-- Clears all test-run data for beaver-solutions EXCEPT the 14 LinkedIn
-- connection requests already sent (status = 'linkedin_requested').
--
-- What is reset:
--   - Messages: delete all EXCEPT linkedin_requested ones
--   - Approvals: delete all linked to non-keeper messages
--   - Send queue: clear non-keeper entries
--   - Follow-up queue: clear for non-keeper leads
--   - Plans: clear old kickoff plans
--   - daily_kpi: clear so dashboard starts from zero
--   - weekly_learnings: clear test-run summaries
--   - shared agent_memory (wins/mistakes/campaign_trend): clear test noise
--   - Lead pipeline stage: reset to 'prospecting' for leads with no keeper messages
--
-- What is NOT touched:
--   - The 14 linkedin_requested messages + their leads
--   - logs (audit trail preserved)
--   - agent_memory ICP, db_builder_config, schema_facts
--   - clients, users, integrations, secrets

DO $$
DECLARE
  v_client_id UUID;
  v_keeper_lead_ids UUID[];
  v_deleted_messages INT;
  v_deleted_approvals INT;
  v_reset_leads INT;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'beaver-solutions';
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'beaver-solutions client not found';
  END IF;

  -- Collect the lead IDs we must keep (linked to the 14 LinkedIn pending)
  SELECT ARRAY(
    SELECT DISTINCT lead_id
    FROM messages
    WHERE client_id = v_client_id
      AND status = 'linkedin_requested'
      AND lead_id IS NOT NULL
  ) INTO v_keeper_lead_ids;

  RAISE NOTICE 'Keeper leads (linkedin_requested): %', array_length(v_keeper_lead_ids, 1);

  -- 1. Delete approvals for non-keeper messages
  DELETE FROM approvals
  WHERE client_id = v_client_id
    AND NOT EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = approvals.message_id
        AND m.status = 'linkedin_requested'
    );
  GET DIAGNOSTICS v_deleted_approvals = ROW_COUNT;

  -- 2. Delete send_queue entries for non-keeper messages
  DELETE FROM send_queue
  WHERE client_id = v_client_id
    AND NOT EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = send_queue.message_id
        AND m.status = 'linkedin_requested'
    );

  -- 3. Delete follow-up queue entries for non-keeper leads
  DELETE FROM followup_queue
  WHERE client_id = v_client_id
    AND (lead_id IS NULL OR lead_id != ALL(v_keeper_lead_ids));

  -- 4. Delete non-keeper messages (NOT linkedin_requested)
  DELETE FROM messages
  WHERE client_id = v_client_id
    AND status != 'linkedin_requested';
  GET DIAGNOSTICS v_deleted_messages = ROW_COUNT;

  -- 5. Reset pipeline stage + status for leads with no remaining messages
  UPDATE leads
  SET
    pipeline_stage = 'prospecting',
    status        = 'new',
    updated_at    = NOW()
  WHERE client_id = v_client_id
    AND (id != ALL(v_keeper_lead_ids))
    AND deleted_at IS NULL;
  GET DIAGNOSTICS v_reset_leads = ROW_COUNT;

  -- 6. Clear daily_kpi (dashboard counters start from zero)
  DELETE FROM daily_kpi WHERE client_id = v_client_id;

  -- 7. Clear weekly_learnings (test-run summaries)
  DELETE FROM weekly_learnings WHERE client_id = v_client_id;

  -- 8. Clear old kickoff plans
  DELETE FROM plans WHERE client_id = v_client_id;

  -- 9. Clear shared agent_memory noise from test runs
  --    (wins, mistakes, campaign_trend, daily reflections)
  --    Keep: icp, db_builder_config, schema_facts, any 'director' keys
  DELETE FROM agent_memory
  WHERE client_id = v_client_id
    AND agent = 'shared';

  DELETE FROM agent_memory
  WHERE client_id = v_client_id
    AND agent = 'captain_beaver'
    AND key LIKE 'weekly_review_%';

  -- 10. Clear conversion_events and hook_performance test data
  DELETE FROM conversion_events WHERE client_id = v_client_id;
  DELETE FROM hook_performance   WHERE client_id = v_client_id;
  DELETE FROM kpi_snapshots      WHERE client_id = v_client_id;

  RAISE NOTICE 'Reset complete — deleted % messages, % approvals, reset % leads. % keeper leads untouched.',
    v_deleted_messages, v_deleted_approvals, v_reset_leads, array_length(v_keeper_lead_ids, 1);
END
$$;
