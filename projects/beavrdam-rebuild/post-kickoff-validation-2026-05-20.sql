-- Post-kickoff validation — 2026-05-20 (W21 Day 3)
-- Run AFTER 09:30 MYT kickoff fires.
-- Purpose: confirm Sales Beaver v3 + per-lead angle-finding (commit 6856f7f) produced
-- real, verifiable openers — not generic spam.
-- Source: NEXT-SESSION.md (locked priority for this session)
-- Tenant: Beaver Solutions (ce2fc8e5-617e-42d5-91fe-4275ceaa0030)

-- =====================================================================
-- 1) KICKOFF FUNNEL — survivors at each stage in the last 6h
-- Read: stage + status grouped counts. Watch for silent drops (e.g. all
-- leads dying at "draft" or "review" stages).
-- =====================================================================
SELECT
  stage,
  status,
  COUNT(*) AS n
FROM pipeline_traces
WHERE client_id = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
  AND created_at > NOW() - INTERVAL '6 hours'
GROUP BY 1, 2
ORDER BY 1, 2;

-- =====================================================================
-- 2) ANGLE QUALITY — did drafted leads get a real, verifiable angle?
-- Read: each row's angle column. Each must reference a real, specific fact
-- about the prospect (dated event OR true company/role observation).
-- REJECT if any read as: "I noticed you work in marketing", "saw your post",
-- or any generic vendor-pitch opener.
-- =====================================================================
SELECT
  name,
  company,
  metadata->>'signal_source' AS src,
  LEFT(metadata->>'signal', 90) AS angle,
  updated_at
FROM leads
WHERE client_id = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
  AND metadata->>'signal' IS NOT NULL
ORDER BY updated_at DESC
LIMIT 15;

-- =====================================================================
-- 3) BONUS — Captain Beaver fire count in last 2h (should be 2+ over 2h
-- before declaring GREEN per morning brief)
-- =====================================================================
SELECT
  agent,
  action,
  COUNT(*) AS n,
  MAX(created_at) AS last_fired
FROM logs
WHERE client_id = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
  AND agent = 'captain_orchestrator'
  AND created_at > NOW() - INTERVAL '2 hours'
GROUP BY 1, 2
ORDER BY 3 DESC;

-- =====================================================================
-- 4) BONUS — draft-body sampling for human eyeball check
-- Pull 10 most recent generated drafts to read the actual opener text.
-- This is the real test — SQL counts are necessary but not sufficient.
-- =====================================================================
SELECT
  l.name,
  l.company,
  m.channel,
  LEFT(m.body, 240) AS opener_preview,
  m.created_at
FROM messages m
JOIN leads l ON l.id = m.lead_id
WHERE m.client_id = 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030'
  AND m.created_at > NOW() - INTERVAL '6 hours'
  AND m.status IN ('pending_review', 'approved', 'pending_send')
ORDER BY m.created_at DESC
LIMIT 10;
