'use strict';

const pool = require('../db/pool');

/**
 * Track a conversion pipeline event.
 * Auto-enriches with lead snapshot data and computes days_since_first_touch.
 * Never throws — logs errors and returns silently.
 */
async function trackEvent(clientId, {
  lead_id,
  message_id,
  event_type,
  channel,
  touch_number,
  reply_sentiment,
  objection_type,
  objection_handling,
  deal_value,
  deal_currency,
  agent,
  metadata = {},
}) {
  try {
    // Fetch lead snapshot for denormalized fields + first touch date
    const leadRes = await pool.query(
      `SELECT vertical, country, company_size, signal_tier,
              first_contacted_at, created_at
       FROM leads
       WHERE id = $1 AND client_id = $2`,
      [lead_id, clientId]
    );

    const lead = leadRes.rows[0] || {};
    const firstTouch = lead.first_contacted_at || lead.created_at;
    const daysSinceFirstTouch = firstTouch
      ? Math.floor((Date.now() - new Date(firstTouch).getTime()) / 86400000)
      : null;

    await pool.query(
      `INSERT INTO conversion_events (
        client_id, lead_id, message_id, event_type, channel, touch_number,
        vertical, country, company_size, signal_tier,
        reply_sentiment, objection_type, objection_handling,
        deal_value, deal_currency, days_since_first_touch,
        agent, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16,
        $17, $18
      )`,
      [
        clientId,
        lead_id,
        message_id || null,
        event_type,
        channel || null,
        touch_number != null ? touch_number : null,
        lead.vertical || null,
        lead.country || null,
        lead.company_size || null,
        lead.signal_tier || null,
        reply_sentiment || null,
        objection_type || null,
        objection_handling || null,
        deal_value != null ? deal_value : null,
        deal_currency || 'MYR',
        daysSinceFirstTouch,
        agent || null,
        JSON.stringify(metadata),
      ]
    );
  } catch (err) {
    console.error('conversionTracker.trackEvent failed:', err.message);
  }
}

/**
 * Upsert a deal summary row for a client+lead.
 * Auto-computes days_to_reply, days_to_meeting, days_to_close from timestamps.
 * Never throws.
 */
async function upsertDealSummary(clientId, leadId, updates = {}) {
  try {
    // Compute duration fields from timestamps
    const firstTouch = updates.first_touch_at ? new Date(updates.first_touch_at) : null;
    const firstReply = updates.first_reply_at ? new Date(updates.first_reply_at) : null;
    const meetingBooked = updates.meeting_booked_at ? new Date(updates.meeting_booked_at) : null;
    const closed = updates.closed_at ? new Date(updates.closed_at) : null;

    const daysBetween = (a, b) => {
      if (!a || !b) return null;
      return Math.floor((b.getTime() - a.getTime()) / 86400000);
    };

    const daysToReply = updates.days_to_reply != null
      ? updates.days_to_reply
      : daysBetween(firstTouch, firstReply);

    const daysToMeeting = updates.days_to_meeting != null
      ? updates.days_to_meeting
      : daysBetween(firstTouch, meetingBooked);

    const daysToClose = updates.days_to_close != null
      ? updates.days_to_close
      : daysBetween(firstTouch, closed);

    await pool.query(
      `INSERT INTO deal_summary (
        client_id, lead_id,
        company, vertical, country, company_size, signal_tier,
        first_touch_at, first_reply_at, meeting_booked_at, meeting_held_at,
        proposal_sent_at, closed_at,
        days_to_reply, days_to_meeting, days_to_close,
        total_touches, channels_used, objections_faced, objection_types,
        outcome, deal_value, deal_currency, loss_reason,
        winning_hook, winning_channel, winning_angle,
        updated_at
      ) VALUES (
        $1, $2,
        $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13,
        $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22, $23, $24,
        $25, $26, $27,
        NOW()
      )
      ON CONFLICT (client_id, lead_id) DO UPDATE SET
        company          = COALESCE(EXCLUDED.company, deal_summary.company),
        vertical         = COALESCE(EXCLUDED.vertical, deal_summary.vertical),
        country          = COALESCE(EXCLUDED.country, deal_summary.country),
        company_size     = COALESCE(EXCLUDED.company_size, deal_summary.company_size),
        signal_tier      = COALESCE(EXCLUDED.signal_tier, deal_summary.signal_tier),
        first_touch_at   = COALESCE(EXCLUDED.first_touch_at, deal_summary.first_touch_at),
        first_reply_at   = COALESCE(EXCLUDED.first_reply_at, deal_summary.first_reply_at),
        meeting_booked_at = COALESCE(EXCLUDED.meeting_booked_at, deal_summary.meeting_booked_at),
        meeting_held_at  = COALESCE(EXCLUDED.meeting_held_at, deal_summary.meeting_held_at),
        proposal_sent_at = COALESCE(EXCLUDED.proposal_sent_at, deal_summary.proposal_sent_at),
        closed_at        = COALESCE(EXCLUDED.closed_at, deal_summary.closed_at),
        days_to_reply    = COALESCE(EXCLUDED.days_to_reply, deal_summary.days_to_reply),
        days_to_meeting  = COALESCE(EXCLUDED.days_to_meeting, deal_summary.days_to_meeting),
        days_to_close    = COALESCE(EXCLUDED.days_to_close, deal_summary.days_to_close),
        total_touches    = COALESCE(EXCLUDED.total_touches, deal_summary.total_touches),
        channels_used    = COALESCE(EXCLUDED.channels_used, deal_summary.channels_used),
        objections_faced = COALESCE(EXCLUDED.objections_faced, deal_summary.objections_faced),
        objection_types  = COALESCE(EXCLUDED.objection_types, deal_summary.objection_types),
        outcome          = COALESCE(EXCLUDED.outcome, deal_summary.outcome),
        deal_value       = COALESCE(EXCLUDED.deal_value, deal_summary.deal_value),
        deal_currency    = COALESCE(EXCLUDED.deal_currency, deal_summary.deal_currency),
        loss_reason      = COALESCE(EXCLUDED.loss_reason, deal_summary.loss_reason),
        winning_hook     = COALESCE(EXCLUDED.winning_hook, deal_summary.winning_hook),
        winning_channel  = COALESCE(EXCLUDED.winning_channel, deal_summary.winning_channel),
        winning_angle    = COALESCE(EXCLUDED.winning_angle, deal_summary.winning_angle),
        updated_at       = NOW()`,
      [
        clientId,
        leadId,
        updates.company || null,
        updates.vertical || null,
        updates.country || null,
        updates.company_size || null,
        updates.signal_tier || null,
        updates.first_touch_at || null,
        updates.first_reply_at || null,
        updates.meeting_booked_at || null,
        updates.meeting_held_at || null,
        updates.proposal_sent_at || null,
        updates.closed_at || null,
        daysToReply,
        daysToMeeting,
        daysToClose,
        updates.total_touches != null ? updates.total_touches : 0,
        updates.channels_used ? JSON.stringify(updates.channels_used) : '[]',
        updates.objections_faced != null ? updates.objections_faced : 0,
        updates.objection_types ? JSON.stringify(updates.objection_types) : '[]',
        updates.outcome || 'open',
        updates.deal_value != null ? updates.deal_value : null,
        updates.deal_currency || 'MYR',
        updates.loss_reason || null,
        updates.winning_hook || null,
        updates.winning_channel || null,
        updates.winning_angle || null,
      ]
    );
  } catch (err) {
    console.error('conversionTracker.upsertDealSummary failed:', err.message);
  }
}

/**
 * Get conversion funnel stats for a client.
 * Returns counts for each funnel stage + total deal value.
 * Supports filters: vertical, country, company_size, date_from, date_to.
 * Never throws.
 */
async function getConversionFunnel(clientId, filters = {}) {
  try {
    const { vertical, country, company_size, date_from, date_to } = filters;

    const result = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE event_type = 'lead_created')     AS leads_created,
        COUNT(*) FILTER (WHERE event_type = 'message_sent')     AS messages_sent,
        COUNT(*) FILTER (WHERE event_type = 'message_replied')  AS replies,
        COUNT(*) FILTER (WHERE event_type = 'reply_positive')   AS positive_replies,
        COUNT(*) FILTER (WHERE event_type = 'meeting_booked')   AS meetings_booked,
        COUNT(*) FILTER (WHERE event_type = 'deal_won')         AS deals_won,
        COALESCE(SUM(deal_value) FILTER (WHERE event_type = 'deal_won'), 0) AS total_deal_value
      FROM conversion_events
      WHERE client_id = $1
        AND ($2::text IS NULL OR vertical = $2)
        AND ($3::text IS NULL OR country = $3)
        AND ($4::text IS NULL OR company_size = $4)
        AND ($5::timestamptz IS NULL OR created_at >= $5)
        AND ($6::timestamptz IS NULL OR created_at <= $6)`,
      [
        clientId,
        vertical || null,
        country || null,
        company_size || null,
        date_from || null,
        date_to || null,
      ]
    );

    const row = result.rows[0];
    return {
      leads_created: parseInt(row.leads_created, 10),
      messages_sent: parseInt(row.messages_sent, 10),
      replies: parseInt(row.replies, 10),
      positive_replies: parseInt(row.positive_replies, 10),
      meetings_booked: parseInt(row.meetings_booked, 10),
      deals_won: parseInt(row.deals_won, 10),
      total_deal_value: parseFloat(row.total_deal_value),
    };
  } catch (err) {
    console.error('conversionTracker.getConversionFunnel failed:', err.message);
    return {
      leads_created: 0,
      messages_sent: 0,
      replies: 0,
      positive_replies: 0,
      meetings_booked: 0,
      deals_won: 0,
      total_deal_value: 0,
    };
  }
}

module.exports = { trackEvent, upsertDealSummary, getConversionFunnel };
