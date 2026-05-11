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
  let guard = 0;
  while (guard++ < 365) {
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
  if (guard >= 365) throw new Error(`nextBusinessDay: exceeded 365 iterations from ${date}`);
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
  // v1.0 thin-context guard (2026-05-07): if lead context is too thin to write
  // a non-hallucinated follow-up, return needs_more_research instead of fabricating.
  const companyName = (lead.company || '').trim();
  const thinCompany = !companyName || /^(unknown|independent|n\/a|self[- ]?employed|freelanc|stealth|confidential|-)$/i.test(companyName);
  const thinTitle = !lead.title || /^(unknown|n\/a|-)$/i.test((lead.title || '').trim());
  if (thinCompany && thinTitle) {
    console.log(`[followup] Thin-context guard: lead ${lead.id} (${lead.name}) has no company or title — returning needs_more_research`);
    return {
      status: 'needs_more_research',
      missing_fields: [thinCompany ? 'company_name' : null, thinTitle ? 'title' : null].filter(Boolean),
      reason: 'Follow-up thin-context guard: lead has no verifiable company or title. Cannot draft without fabricating.',
    };
  }

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
      type: 'FU1 Day 2 — Genuine question about their business',
      instruction: 'Ask a genuine question about their business that shows you looked at their company. Do NOT reuse any pain point, stat, or angle from the Day 0 message. No numbers, no percentages. Just a short, curious question about how they handle outbound or pipeline today.',
      maxWords: 60,
    },
    3: {
      type: 'FU2 Day 5 — Timing check (one sentence)',
      instruction: 'Reference the core idea from message 1 in one clause, then ask if timing is better now. Entire message must be ONE or TWO sentences. No stats, no proof, no pitch. Example tone: "Still thinking about whether automating outreach makes sense for [company] right now?"',
      maxWords: 30,
    },
    4: {
      type: 'FU3 Day 10 — Contrarian observation',
      instruction: 'Share one contrarian or non-obvious observation about their industry or role. No pitch, no CTA beyond a soft question. The goal is to sound like a peer sharing an insight, not a seller following up. Do NOT reference any prior message.',
      maxWords: 40,
    },
    5: {
      type: 'FU4 Day 18 — Easy out / break-up',
      instruction: 'Honest break-up. "Last one from me for now. If timing is off, happy to leave it here. But if [reference their specific situation from lead context] changes, the door is open." Under 30 words. No pressure.',
      maxWords: 30,
    },
    6: {
      type: 'FU5 Day 30 — Re-awaken with new context',
      instruction: 'Come back referencing something NEW about the lead — a LinkedIn post they made, a job they posted, a company milestone, or a market shift in their vertical. If no new context is available from lead data, reference a general trend in their industry. Must feel like a fresh conversation, not touch 6 of a sequence. One question.',
      maxWords: 50,
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
Michael

HARD RULES: No em dashes (—). Max 1 question mark. No bullets.`
    : `FORMAT (${channel} DM follow-up):
{body — max ${config.maxWords} words. No greeting, no sign-off. Casual tone.}

HARD RULES: No em dashes (—). Max 1 question mark. No bullets. No "Regards,".`;

  // 2026-05-06 fix: explicit pre-gate constraint at the top of the prompt.
  // The downstream cron pre-gate enforces wordCap=120 (FU) and questionCap=2.
  // 174 historical drafts were silently skipped because Sales Beaver wrote 130+
  // word emails or stacked 3+ questions. Stating the cap up front + repeating
  // it as a hard rule prevents the regeneration loop.
  // Retry path: if caller passed _retry_constraint, tighten the caps further.
  const retryConstraint = lead?._retry_constraint;
  const hardWordCap = retryConstraint?.wordCap ?? Math.min(config.maxWords, 110);
  const hardQuestionCap = retryConstraint?.questionCap ?? 1;

  const prompt = `You are Sales Beaver writing Touch ${touchNumber} of 6 in a follow-up sequence on ${channel}.

PRE-GATE CONSTRAINT (server rejects drafts that violate these — NON-NEGOTIABLE):
- Body must be under ${hardWordCap} words. Count the words in your draft before returning.
- Body must contain AT MOST ${hardQuestionCap} question mark. Zero or one. Never two.
- No em dashes. No bullet points. No "checking in" / "just following up".

FOLLOW-UP RULES (these override cold-DM rules for follow-ups):
- ANTI-FABRICATION (HARD GATE): Every company name, product, role, or fact you mention MUST come from the LEAD context or PREVIOUS MESSAGES below. If the lead context says Company: "Unknown" or Title: "Unknown", do NOT invent a company name, product, or role. Work only with what you have.
- NO STATS OR NUMBERS: Do NOT use any percentage, statistic, or numeric benchmark in follow-ups. No "X% reply rate", no "Y hours/week", no "Z DMs/week". Follow-ups are conversational, not pitches. If a previous message already cited a number, do NOT repeat it.
- ANTI-REPETITION: Your draft must NOT reuse any hook, angle, pain point, or phrase from PREVIOUS MESSAGES below. Each touch must feel like a new thought, not a rephrased version of the last one.
- BREVITY: Follow-ups should read like a quick text from a peer, not a sales email. Shorter is always better.
- SENDER IDENTITY: Always sign as "Michael". Never "The Team", never "Sales Beaver", never the lead's name.
- If you cannot write a genuine, non-fabricated follow-up with the context provided, return: {"status":"needs_more_research","missing_fields":["<what's missing>"],"reason":"Insufficient context for non-fabricated follow-up."}

LEAD:
Name: ${lead.name}
Title: ${lead.title || 'Unknown'}
Company: ${lead.company || 'Unknown'}
Industry: ${lead.industry || lead.metadata?.industry || 'Unknown'}

PREVIOUS MESSAGES (do NOT repeat any hook, angle, or pain point):
${previousSummary || 'No previous messages'}

TOUCH TYPE: ${config.type}
INSTRUCTION: ${config.instruction}

${channelFormat}

Before returning, verify: word count under ${hardWordCap}? Question marks ≤ ${hardQuestionCap}? Every fact verifiable from lead context? If not, rewrite.

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
