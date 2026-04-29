'use strict';

const pool = require('../db/pool');
const { callAgent } = require('./claude');

/**
 * Malaysian public holidays 2026 (YYYY-MM-DD).
 * Islamic dates are estimates — update when gazette is published.
 */
const MY_HOLIDAYS_2026 = [
  '2026-01-01', // New Year
  '2026-01-29', // Thaipusam
  '2026-02-17', // Chinese New Year
  '2026-02-18', // Chinese New Year Day 2
  '2026-03-17', // Nuzul Al-Quran (estimate)
  '2026-03-29', // Hari Raya Aidilfitri (estimate)
  '2026-03-30', // Hari Raya Aidilfitri Day 2 (estimate)
  '2026-05-01', // Labour Day
  '2026-05-13', // Vesak Day
  '2026-06-05', // Hari Raya Haji (estimate)
  '2026-06-06', // Agong Birthday
  '2026-06-26', // Awal Muharram (estimate)
  '2026-08-31', // Merdeka Day
  '2026-09-04', // Mawlid (estimate)
  '2026-09-16', // Malaysia Day
  '2026-10-20', // Deepavali (estimate)
  '2026-12-25', // Christmas
];

const holidaySet = new Set(MY_HOLIDAYS_2026);

/**
 * Advance a date to the next business day (skips weekends + MY public holidays).
 * Mutates nothing — returns a new Date.
 */
function nextBusinessDay(date) {
  const d = new Date(date);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const day = d.getDay();
    if (day === 6) d.setDate(d.getDate() + 2);      // Saturday → Monday
    else if (day === 0) d.setDate(d.getDate() + 1);  // Sunday  → Monday

    const iso = d.toISOString().split('T')[0];
    if (holidaySet.has(iso)) {
      d.setDate(d.getDate() + 1); // skip holiday, re-check
      continue;
    }
    break;
  }
  return d;
}

/**
 * Schedule follow-up touches 2, 3, 4 when a lead is first contacted.
 */
async function scheduleFollowUps(clientId, leadId, firstContactDate) {
  const base = new Date(firstContactDate);

  // Extended cadence (Day 0 = initial, not scheduled here):
  // Day 2  — FU1: different angle on same pain
  // Day 5  — FU2: one-line social proof
  // Day 10 — FU3: final bump / easy out
  // Day 18 — FU4: break-up with new framing (nurture mode)
  // Day 30 — FU5: re-awaken — new signal/angle (long-tail, often converts)
  const schedule = [
    { touch: 2, daysAfter: 2 },
    { touch: 3, daysAfter: 5 },
    { touch: 4, daysAfter: 10 },
    { touch: 5, daysAfter: 18 },
    { touch: 6, daysAfter: 30 },
  ];

  for (const { touch, daysAfter } of schedule) {
    const scheduledFor = new Date(base);
    scheduledFor.setDate(scheduledFor.getDate() + daysAfter);
    const adjusted = nextBusinessDay(scheduledFor);
    const dateStr = adjusted.toISOString().split('T')[0];

    await pool.query(
      `INSERT INTO followup_queue (client_id, lead_id, touch_number, scheduled_for)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lead_id, touch_number) DO NOTHING`,
      [clientId, leadId, touch, dateStr]
    );
  }

  const touch2Date = nextBusinessDay(
    new Date(base.getTime() + 2 * 86400000)
  );

  await pool.query(
    `UPDATE leads SET
       first_contacted_at = COALESCE(first_contacted_at, $1),
       sequence_touch = 1,
       next_followup_at = $2
     WHERE id = $3`,
    [firstContactDate, touch2Date, leadId]
  );

  console.log(`[FollowUp] Scheduled ${schedule.length} follow-ups for lead ${leadId} (Day 2/5/10/18/30)`);
}

/**
 * Stop all pending follow-ups for a lead (on reply, meeting booked, unsubscribe).
 */
async function stopSequence(leadId, reason = 'replied', clientId = null) {
  const params = clientId
    ? [reason, leadId, clientId]
    : [reason, leadId];
  const clientFilter = clientId ? ' AND client_id = $3' : '';
  await pool.query(
    `UPDATE leads SET sequence_status = $1, sequence_completed_at = NOW() WHERE id = $2${clientFilter}`,
    params
  );
  const fqParams = clientId ? [leadId, clientId] : [leadId];
  const fqFilter = clientId ? ' AND client_id = $2' : '';
  await pool.query(
    `UPDATE followup_queue SET status = 'cancelled' WHERE lead_id = $1 AND status = 'pending'${fqFilter}`,
    fqParams
  );
  console.log(`[FollowUp] Sequence stopped for lead ${leadId}: ${reason}`);
}

/**
 * Pause or resume a sequence.
 */
async function pauseSequence(leadId, clientId = null) {
  const params = clientId ? [leadId, clientId] : [leadId];
  const clientFilter = clientId ? ' AND client_id = $2' : '';
  await pool.query(
    `UPDATE leads SET sequence_status = 'paused' WHERE id = $1${clientFilter}`,
    params
  );
}

async function resumeSequence(leadId, clientId = null) {
  const params = clientId ? [leadId, clientId] : [leadId];
  const clientFilter = clientId ? ' AND client_id = $2' : '';
  await pool.query(
    `UPDATE leads SET sequence_status = 'active' WHERE id = $1${clientFilter}`,
    params
  );
}

/**
 * Get all follow-ups due today or earlier for a specific client.
 */
async function getDueFollowUps(clientId) {
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT fq.*, l.name, l.company, l.email, l.title,
            l.metadata->>'industry' AS industry,
            l.metadata->>'notes' AS notes, l.metadata
     FROM followup_queue fq
     JOIN leads l ON l.id = fq.lead_id
     WHERE fq.client_id = $1
       AND fq.scheduled_for <= $2
       AND fq.status = 'pending'
       AND l.sequence_status = 'active'
     ORDER BY fq.scheduled_for ASC`,
    [clientId, today]
  );
  return rows;
}

/**
 * Get the sequence status + all touchpoints for a lead.
 */
async function getLeadSequence(clientId, leadId) {
  const { rows: [lead] } = await pool.query(
    `SELECT sequence_status, sequence_touch, first_contacted_at, next_followup_at, sequence_completed_at
     FROM leads WHERE id = $1 AND client_id = $2`,
    [leadId, clientId]
  );

  const { rows: touches } = await pool.query(
    `SELECT fq.touch_number, fq.scheduled_for, fq.status AS queue_status,
            m.status AS message_status, m.id AS message_id, m.subject
     FROM followup_queue fq
     LEFT JOIN messages m ON m.id = fq.message_id
     WHERE fq.lead_id = $1 AND fq.client_id = $2
     ORDER BY fq.touch_number ASC`,
    [leadId, clientId]
  );

  // Also look up touch 1 (the original message)
  const { rows: [touch1] } = await pool.query(
    `SELECT id AS message_id, subject, status AS message_status, created_at AS scheduled_for
     FROM messages
     WHERE lead_id = $1 AND client_id = $2
     ORDER BY created_at ASC LIMIT 1`,
    [leadId, clientId]
  );

  const allTouches = [
    touch1
      ? { touch_number: 1, scheduled_for: touch1.scheduled_for, queue_status: 'sent', message_status: touch1.message_status, message_id: touch1.message_id, subject: touch1.subject }
      : null,
    ...touches,
  ].filter(Boolean);

  return {
    sequence_status: lead?.sequence_status || 'active',
    sequence_touch: lead?.sequence_touch || 0,
    first_contacted_at: lead?.first_contacted_at,
    touches: allTouches,
  };
}

/**
 * Draft a follow-up message for a specific touch.
 */
async function draftFollowUp(lead, touchNumber, previousMessages) {
  // ICP+channel patches per MJ direction 2026-04-29
  // Email-first sequence. Touch 1 + 2 always inherit (or default to 'email' for new sequences).
  // Touch 3 (D+7) is the FIRST point where LinkedIn becomes valid as an escalation, and only
  // if (a) the previous channel was email, (b) the lead has a linkedin_url, and (c) no reply yet.
  const previousChannel = previousMessages?.[0]?.channel || 'email';
  let channel = previousChannel;
  if (touchNumber === 3 && previousChannel === 'email' && lead.linkedin_url) {
    channel = 'linkedin';
    console.log(`[followup] Touch 3 escalation for lead ${lead.id}: email → linkedin`);
  }

  const touchConfig = {
    2: {
      type: 'FU1 Day 2 — Different angle on same pain',
      instruction: 'Write from a completely different angle than the Day 0 message. Do NOT say "just following up" or "checking in". Lead with a new observation or insight about their business. One question at the end.',
      maxWords: 80,
    },
    3: {
      type: 'FU2 Day 5 — One-line social proof',
      instruction: 'One specific result or social proof. Under 20 words for the core line. Example: "We helped a similar property company go from 0 to 12 meetings in 3 weeks." Then one soft question.',
      maxWords: 40,
    },
    4: {
      type: 'FU3 Day 10 — Bump with new framing',
      instruction: 'Reframe the value prop from a completely new angle. Do NOT sound like a follow-up. Short, punchy. One question.',
      maxWords: 40,
    },
    5: {
      type: 'FU4 Day 18 — Easy out / break-up',
      instruction: 'Honest break-up. "Last one from me for now. If timing is off, happy to leave it here. But if {specific pain} is on your mind, the door\'s open." Under 40 words. No CTA pressure.',
      maxWords: 40,
    },
    6: {
      type: 'FU5 Day 30 — Re-awaken with new trigger',
      instruction: 'Come back with a SPECIFIC new angle or signal. Reference something different from every prior message. This is the "nurture wake-up" message. Often converts because it feels fresh, not like a sequence. One question.',
      maxWords: 60,
    },
  };

  const config = touchConfig[touchNumber];
  if (!config) throw new Error(`Invalid touch number: ${touchNumber}`);

  const previousSummary = (previousMessages || [])
    .map((m, i) => {
      const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata || '{}') : (m.metadata || {});
      return `Message ${i + 1} (${m.channel || 'email'}):\nSubject: ${m.subject || 'N/A'}\nBody preview: ${(m.body || '').substring(0, 150)}`;
    })
    .join('\n---\n');

  // Channel-specific format instructions
  const channelFormat = channel === 'email'
    ? `FORMAT (email follow-up):
Hi ${lead.name?.split(' ')[0] || 'there'},

{body — max ${config.maxWords} words}

Regards,
{use sender name from previous messages or "The Team"}

HARD RULES: No em dashes (—). Max 1 question mark. No bullets.`
    : `FORMAT (${channel} DM follow-up):
{body — max ${config.maxWords} words. No greeting, no sign-off. Casual tone.}

HARD RULES: No em dashes (—). Max 1 question mark. No bullets. No "Regards,".`;

  const prompt = `You are Sales Beaver writing Touch ${touchNumber} of 6 in a follow-up sequence on ${channel}.

LEAD:
Name: ${lead.name}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company}
Industry: ${lead.industry || lead.metadata?.industry || 'Unknown'}

PREVIOUS MESSAGES (do NOT repeat any hook, angle, or pain point):
${previousSummary || 'No previous messages'}

TOUCH TYPE: ${config.type}
INSTRUCTION: ${config.instruction}

${channelFormat}

Return JSON only:
{"subject":${channel === 'email' ? '"..."' : 'null'},"body":"...","touch_number":${touchNumber}}`;

  return await callAgent('sales_beaver', prompt);
}

/**
 * Find stale leads: active sequence, no reply, first contacted > 5 days ago.
 * Returns leads with their last message info for daily surfacing.
 */
async function getStaleLeads(clientId) {
  const { rows } = await pool.query(
    `SELECT
       l.id            AS lead_id,
       l.name          AS lead_name,
       l.company       AS lead_company,
       l.title         AS lead_title,
       l.email         AS lead_email,
       l.status        AS lead_status,
       l.sequence_touch,
       l.first_contacted_at,
       l.metadata->>'industry' AS industry,
       l.metadata->>'signal'   AS signal,
       m.id            AS last_message_id,
       m.subject       AS last_message_subject,
       m.body          AS last_message_body,
       m.sent_at       AS last_message_sent_at,
       m.channel       AS last_message_channel
     FROM leads l
     LEFT JOIN LATERAL (
       SELECT id, subject, body, sent_at, channel
       FROM messages
       WHERE messages.lead_id = l.id AND messages.client_id = $1
       ORDER BY created_at DESC
       LIMIT 1
     ) m ON true
     WHERE l.client_id = $1
       AND l.sequence_status = 'active'
       AND l.last_reply_at IS NULL
       AND l.first_contacted_at < NOW() - INTERVAL '5 days'
       AND l.deleted_at IS NULL
     ORDER BY l.first_contacted_at ASC`,
    [clientId]
  );
  return rows;
}

/**
 * Channel escalation: after FU2 (Day 4) with no reply, recommend a different channel.
 * Returns escalation info or null if not ready / no alternate channel available.
 */
async function escalateChannel(clientId, leadId) {
  // 1. Check lead has active sequence, no reply, and FU2 is done (touch >= 3)
  const { rows: [lead] } = await pool.query(
    `SELECT id, name, company, email, sequence_status, sequence_touch, last_reply_at, metadata
     FROM leads
     WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [leadId, clientId]
  );

  if (!lead) return null;
  if (lead.sequence_touch < 3) return null;
  if (lead.last_reply_at !== null) return null;
  if (lead.sequence_status !== 'active') return null;

  // 2. Find original channel from first message
  const { rows: [firstMsg] } = await pool.query(
    `SELECT channel FROM messages
     WHERE lead_id = $1 AND client_id = $2
     ORDER BY created_at ASC LIMIT 1`,
    [leadId, clientId]
  );

  if (!firstMsg || !firstMsg.channel) return null;
  const originalChannel = firstMsg.channel;

  // 3. Pick next channel
  const hasEmail = !!(lead.email && lead.email.trim());
  const meta = typeof lead.metadata === 'string' ? JSON.parse(lead.metadata || '{}') : (lead.metadata || {});
  const hasLinkedin = !!(meta.linkedin_url || meta.linkedin);
  const hasInstagram = !!(meta.instagram_url || meta.instagram);

  let newChannel = null;

  if (originalChannel === 'email') {
    if (hasLinkedin) newChannel = 'linkedin';
  } else if (originalChannel === 'linkedin') {
    if (hasEmail) newChannel = 'email';
    else if (hasInstagram) newChannel = 'instagram';
  } else if (originalChannel === 'instagram') {
    if (hasEmail) newChannel = 'email';
    else if (hasLinkedin) newChannel = 'linkedin';
  }

  if (!newChannel) return null;

  // 4. Return escalation recommendation (caller handles drafting)
  return {
    lead_id: lead.id,
    original_channel: originalChannel,
    new_channel: newChannel,
    lead_name: lead.name,
    lead_company: lead.company,
    lead,
  };
}

module.exports = { scheduleFollowUps, stopSequence, pauseSequence, resumeSequence, getDueFollowUps, getLeadSequence, draftFollowUp, getStaleLeads, nextBusinessDay, MY_HOLIDAYS_2026, escalateChannel };
