'use strict';

const pool = require('../db/pool');
const { AppError } = require('../utils/errors');
const logsService = require('./logs');
const { trackEvent, upsertDealSummary } = require('./conversionTracker');

async function getLeads(clientId, filters = {}, pagination = {}) {
  const { status, signal_tier, source, pipeline_stage, search } = filters;
  const { page = 1, perPage = 20 } = pagination;
  const offset = (page - 1) * perPage;

  const searchPattern = search ? `%${search}%` : null;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM leads
     WHERE client_id = $1
       AND deleted_at IS NULL
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR signal_tier = $3)
       AND ($4::text IS NULL OR source = $4)
       AND ($5::text IS NULL OR pipeline_stage = $5)
       AND ($6::text IS NULL OR name ILIKE $6 OR company ILIKE $6 OR email ILIKE $6)`,
    [clientId, status || null, signal_tier || null, source || null, pipeline_stage || null, searchPattern]
  );

  const result = await pool.query(
    `SELECT * FROM leads
     WHERE client_id = $1
       AND deleted_at IS NULL
       AND ($2::text IS NULL OR status = $2)
       AND ($3::text IS NULL OR signal_tier = $3)
       AND ($4::text IS NULL OR source = $4)
       AND ($5::text IS NULL OR pipeline_stage = $5)
       AND ($6::text IS NULL OR name ILIKE $6 OR company ILIKE $6 OR email ILIKE $6)
     ORDER BY created_at DESC
     LIMIT $7 OFFSET $8`,
    [clientId, status || null, signal_tier || null, source || null, pipeline_stage || null, searchPattern, perPage, offset]
  );

  return {
    data: result.rows,
    meta: { total: parseInt(countResult.rows[0].count, 10), page, perPage },
  };
}

async function getLead(clientId, leadId) {
  const result = await pool.query(
    `SELECT * FROM leads WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [leadId, clientId]
  );
  if (result.rows.length === 0) {
    throw new AppError('Lead not found', 404, 'NOT_FOUND');
  }
  return result.rows[0];
}

const STATUS_TO_PIPELINE = {
  new: 'prospecting',
  contacted: 'outreach',
  replied: 'qualifying',
  meeting_booked: 'booked',
  closed_won: 'closed',
  closed_lost: 'closed',
};

async function createLead(clientId, data) {
  const {
    name, email, company, title, linkedin_url, source, signal_tier,
    status = 'new', score = 0, metadata = {},
  } = data;
  const pipeline_stage = data.pipeline_stage || STATUS_TO_PIPELINE[status] || 'prospecting';

  // 2026-05-14: ICP v2 gate at the generic createLead helper. Used by Captain's
  // create_lead tool + manual /api/leads POST + import routes. Without this gate,
  // marketing-titled or off-ICP leads enter via these paths even though dbBuilder
  // (the bulk producer) catches them via Path B (commit 9f736ac). Belt + suspenders.
  // Caller can opt out for legitimate manual imports via data.skip_icp_filter = true.
  if (data.skip_icp_filter !== true) {
    const { applyIcpV2Filter } = require('./agents');
    const v2 = applyIcpV2Filter({ name, company, title, country: data.country, score, metadata });
    if (!v2.pass) {
      const { AppError } = require('../utils/errors');
      throw new AppError(
        `Lead rejected by ICP v2 filter: ${v2.reason}`,
        400,
        v2.status || 'rejected_icp_v2'
      );
    }
  }

  // Phase 2 V2 Step 6 (2026-05-08): generic createLead helper. Used by import
  // routes + miscellaneous internal callers. Default to 'lite' + NOW() because
  // we don't know the upstream context. Caller can override via data.* fields.
  const buying_signal_strength = data.buying_signal_strength
    || metadata.buying_signal_strength
    || 'lite';
  const signal_dated_at = data.signal_dated_at
    || metadata.signal_dated_at
    || new Date().toISOString();

  const result = await pool.query(
    `INSERT INTO leads (client_id, name, email, company, title, linkedin_url, source, signal_tier, status, score, pipeline_stage, metadata, buying_signal_strength, signal_dated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [clientId, name, email, company, title, linkedin_url, source, signal_tier, status, score, pipeline_stage, JSON.stringify(metadata), buying_signal_strength, signal_dated_at]
  );
  const lead = result.rows[0];

  await logsService.createLog(clientId, {
    agent: 'system',
    action: 'lead_created',
    target_type: 'lead',
    target_id: lead.id,
    metadata: { name: lead.name, company: lead.company, signal_tier: lead.signal_tier },
  });

  trackEvent(clientId, { lead_id: lead.id, event_type: 'lead_created', agent: 'system' });
  upsertDealSummary(clientId, lead.id, {
    company: lead.company, signal_tier: lead.signal_tier,
  });

  return lead;
}

async function updateLead(clientId, leadId, data) {
  const existing = await getLead(clientId, leadId); // verify exists

  // ── Reschedule tracking: auto-nurture after 2 reschedules ──
  if (data.meeting_date && existing.meeting_date && data.meeting_date !== existing.meeting_date) {
    const existingMeta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata || {});
    const rescheduleCount = (existingMeta.reschedule_count || 0) + 1;
    // Merge into data.metadata so it persists
    const dataMeta = typeof data.metadata === 'object' && data.metadata !== null ? data.metadata : {};
    data.metadata = { ...existingMeta, ...dataMeta, reschedule_count: rescheduleCount };
    if (rescheduleCount >= 2) {
      data.pipeline_stage = 'nurture';
      data.next_action = 'Auto-nurtured: prospect rescheduled 2+ times';
      await logsService.createLog(clientId, {
        agent: 'system',
        action: 'lead_auto_nurtured',
        target_type: 'lead',
        target_id: leadId,
        metadata: { reschedule_count: rescheduleCount, reason: 'two_reschedules' },
      });
    }
  }

  // Pipeline stage change requires non-empty next_action
  if (data.pipeline_stage && data.pipeline_stage !== existing.pipeline_stage) {
    if (!data.next_action && !data.metadata?.next_action) {
      const { AppError } = require('../utils/errors');
      throw new AppError('Pipeline stage change requires a next_action field', 400, 'MISSING_NEXT_ACTION');
    }
  }

  const fields = ['name', 'email', 'company', 'title', 'linkedin_url', 'source', 'signal_tier', 'status', 'score', 'pipeline_stage', 'next_action', 'metadata'];
  const updates = [];
  const values = [clientId, leadId];
  let idx = 3;

  for (const field of fields) {
    if (data[field] !== undefined) {
      updates.push(`${field} = $${idx}`);
      values.push(field === 'metadata' ? JSON.stringify(data[field]) : data[field]);
      idx++;
    }
  }

  // Auto-sync pipeline_stage when status changes
  if (data.status && !data.pipeline_stage && STATUS_TO_PIPELINE[data.status]) {
    updates.push(`pipeline_stage = $${idx}`);
    values.push(STATUS_TO_PIPELINE[data.status]);
    idx++;
  }
  if (updates.length === 0) return getLead(clientId, leadId);

  updates.push(`updated_at = NOW()`);
  const result = await pool.query(
    `UPDATE leads SET ${updates.join(', ')} WHERE client_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING *`,
    values
  );

  await logsService.createLog(clientId, {
    agent: 'system',
    action: 'lead_updated',
    target_type: 'lead',
    target_id: leadId,
    metadata: { updated_fields: Object.keys(data) },
  });

  const updated = result.rows[0];

  // Track pipeline stage transitions
  const newStage = data.pipeline_stage || (data.status && STATUS_TO_PIPELINE[data.status]);
  if (newStage && newStage !== existing.pipeline_stage) {
    const eventMap = {
      booked: 'meeting_booked',
      closed: data.status === 'closed_won' ? 'deal_won' : 'deal_lost',
      nurture: 'lead_nurtured',
    };
    const eventType = eventMap[newStage] || 'stage_changed';
    trackEvent(clientId, {
      lead_id: leadId,
      event_type: eventType,
      agent: 'system',
      deal_value: data.deal_value,
      metadata: { from_stage: existing.pipeline_stage, to_stage: newStage },
    });

    // Update deal summary on key milestones
    const summaryUpdates = {};
    if (newStage === 'booked') summaryUpdates.meeting_booked_at = new Date().toISOString();
    if (newStage === 'closed') {
      summaryUpdates.closed_at = new Date().toISOString();
      summaryUpdates.outcome = data.status === 'closed_won' ? 'won' : 'lost';
      if (data.deal_value) summaryUpdates.deal_value = data.deal_value;
      if (data.metadata?.lost_reason) summaryUpdates.loss_reason = data.metadata.lost_reason;
    }
    if (Object.keys(summaryUpdates).length > 0) {
      upsertDealSummary(clientId, leadId, summaryUpdates);
    }
  }

  return updated;
}

async function deleteLead(clientId, leadId) {
  const lead = await getLead(clientId, leadId);
  await pool.query(
    `UPDATE leads SET deleted_at = NOW() WHERE id = $1 AND client_id = $2`,
    [leadId, clientId]
  );

  await logsService.createLog(clientId, {
    agent: 'system',
    action: 'lead_deleted',
    target_type: 'lead',
    target_id: leadId,
    metadata: { name: lead.name },
  });
}

async function getStaleLeads(clientId, daysThreshold = 4) {
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.company, l.pipeline_stage, l.updated_at,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.lead_id = l.id AND m.status = 'sent') AS last_message_at
     FROM leads l
     WHERE l.client_id = $1
       AND l.deleted_at IS NULL
       AND l.pipeline_stage IN ('outreach', 'qualifying')
       AND l.updated_at < NOW() - make_interval(days => $2)
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.lead_id = l.id AND m.reply_detected_at IS NOT NULL
       )
     ORDER BY l.updated_at ASC
     LIMIT 50`,
    [clientId, daysThreshold]
  );
  return rows;
}

module.exports = { getLeads, getLead, createLead, updateLead, deleteLead, getStaleLeads };
