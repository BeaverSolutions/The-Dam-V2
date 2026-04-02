'use strict';

const pool = require('../db/pool');
const { callAgent } = require('./claude');

/**
 * Schedule follow-up touches 2, 3, 4 when a lead is first contacted.
 */
async function scheduleFollowUps(clientId, leadId, firstContactDate) {
  const base = new Date(firstContactDate);

  const schedule = [
    { touch: 2, daysAfter: 3 },
    { touch: 3, daysAfter: 7 },
    { touch: 4, daysAfter: 14 },
  ];

  for (const { touch, daysAfter } of schedule) {
    const scheduledFor = new Date(base);
    scheduledFor.setDate(scheduledFor.getDate() + daysAfter);
    const dateStr = scheduledFor.toISOString().split('T')[0];

    await pool.query(
      `INSERT INTO followup_queue (client_id, lead_id, touch_number, scheduled_for)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lead_id, touch_number) DO NOTHING`,
      [clientId, leadId, touch, dateStr]
    );
  }

  const touch2Date = new Date(base);
  touch2Date.setDate(touch2Date.getDate() + 3);

  await pool.query(
    `UPDATE leads SET
       first_contacted_at = COALESCE(first_contacted_at, $1),
       sequence_touch = 1,
       next_followup_at = $2
     WHERE id = $3`,
    [firstContactDate, touch2Date, leadId]
  );

  console.log(`[FollowUp] Scheduled 3 follow-ups for lead ${leadId}`);
}

/**
 * Stop all pending follow-ups for a lead (on reply, meeting booked, unsubscribe).
 */
async function stopSequence(leadId, reason = 'replied') {
  await pool.query(
    `UPDATE leads SET sequence_status = $1, sequence_completed_at = NOW() WHERE id = $2`,
    [reason, leadId]
  );
  await pool.query(
    `UPDATE followup_queue SET status = 'cancelled' WHERE lead_id = $1 AND status = 'pending'`,
    [leadId]
  );
  console.log(`[FollowUp] Sequence stopped for lead ${leadId}: ${reason}`);
}

/**
 * Pause or resume a sequence.
 */
async function pauseSequence(leadId) {
  await pool.query(
    `UPDATE leads SET sequence_status = 'paused' WHERE id = $1`,
    [leadId]
  );
}

async function resumeSequence(leadId) {
  await pool.query(
    `UPDATE leads SET sequence_status = 'active' WHERE id = $1`,
    [leadId]
  );
}

/**
 * Get all follow-ups due today or earlier for a specific client.
 */
async function getDueFollowUps(clientId) {
  const today = new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT fq.*, l.name, l.company, l.email, l.title, l.industry,
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
  const touchConfig = {
    2: {
      type: 'Value Add Follow-up',
      instruction: 'Share something genuinely useful or insightful related to their business. Do NOT say "just following up" or "checking in". Lead with value — a relevant observation, a question that shows you did research, or a short insight about their industry.',
      tone: 'Helpful, no agenda',
    },
    3: {
      type: 'New Angle Follow-up',
      instruction: 'Take a completely different angle from the first two messages. Use a different pain point, mention social proof ("we helped a similar company..."), or reframe the value proposition. Never repeat any hook or opening from previous messages.',
      tone: 'Confident, specific',
    },
    4: {
      type: 'Break-up Email',
      instruction: 'This is the final message. Be honest and give them an out. Something like: "Last email from me — if the timing isn\'t right, totally understand. But if [specific pain] is something you\'re thinking about, happy to chat for 15 mins." Short, no pressure, human.',
      tone: 'Honest, warm, brief — max 50 words',
    },
  };

  const config = touchConfig[touchNumber];
  if (!config) throw new Error(`Invalid touch number: ${touchNumber}`);

  const previousSummary = (previousMessages || [])
    .map((m, i) => {
      const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata || '{}') : (m.metadata || {});
      return `Message ${i + 1}:\nSubject: ${m.subject}\nHook used: ${meta.personalization_hook || 'unknown'}\nPain targeted: ${meta.pain_point_targeted || 'unknown'}`;
    })
    .join('\n---\n');

  const prompt = `You are Sales Beaver writing Touch ${touchNumber} of 4 in a follow-up sequence.

LEAD PROFILE:
Name: ${lead.name}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company}
Industry: ${lead.industry || 'Unknown'}
Notes: ${lead.notes || 'No notes'}

PREVIOUS MESSAGES SENT TO THIS LEAD (do NOT repeat any hook, opening, or pain point from these):
${previousSummary || 'No previous messages'}

TOUCH ${touchNumber} TYPE: ${config.type}
INSTRUCTION: ${config.instruction}
TONE: ${config.tone}

Rules:
- Maximum 80 words for the email body (max 50 words for touch 4)
- NEVER repeat any hook, opening line, or pain point from previous messages
- No "just following up", "checking in", "hope this finds you well"
- Malaysian English is fine

Return JSON only — no other text:
{"subject":"...","body":"...","personalization_hook":"...","pain_point_targeted":"...","cta":"...","touch_number":${touchNumber}}`;

  return await callAgent('sales_beaver', prompt);
}

module.exports = { scheduleFollowUps, stopSequence, pauseSequence, resumeSequence, getDueFollowUps, getLeadSequence, draftFollowUp };
