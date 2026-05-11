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
 * Get all due follow-ups for a client with FULL lead context + previous messages.
 * Used by Captain's daily planning step — gives Sonnet enough context to propose
 * per-lead angles without making N+1 queries.
 *
 * Returns an array of { ...followup, lead: {...}, previous_messages: [...], rejection_history: [...] }
 */
async function getDueFollowUpsWithContext(clientId) {
  const today = new Date().toISOString().split('T')[0];

  // 1. Get due follow-ups joined with full lead row
  const { rows: dueRows } = await pool.query(
    `SELECT fq.*,
            l.id AS lead_id_full,
            l.name, l.title, l.email, l.company, l.linkedin_url,
            l.metadata, l.quality_score,
            l.metadata->>'industry' AS industry,
            l.metadata->>'signal' AS signal,
            l.metadata->>'notes' AS notes,
            l.sequence_status, l.sequence_touch,
            l.first_contacted_at, l.last_reply_at
     FROM followup_queue fq
     JOIN leads l ON l.id = fq.lead_id
     WHERE fq.client_id = $1
       AND fq.scheduled_for <= $2
       AND fq.status = 'pending'
       AND l.sequence_status = 'active'
       AND l.last_reply_at IS NULL
       AND l.deleted_at IS NULL
     ORDER BY fq.scheduled_for ASC`,
    [clientId, today]
  );

  if (dueRows.length === 0) return [];

  // 2. Bulk-fetch previous messages for all leads in one query
  const leadIds = dueRows.map(r => r.lead_id);
  const { rows: msgRows } = await pool.query(
    `SELECT lead_id, subject, body, channel, status, metadata, ranger_score, ranger_notes, created_at
     FROM messages
     WHERE lead_id = ANY($1::uuid[]) AND client_id = $2
     ORDER BY lead_id, created_at ASC`,
    [leadIds, clientId]
  );

  // 3. Group messages by lead_id, separate ranger-rejected for rejection history
  const messagesByLead = new Map();
  const rejectionsByLead = new Map();
  for (const m of msgRows) {
    if (m.status === 'ranger_rejected') {
      if (!rejectionsByLead.has(m.lead_id)) rejectionsByLead.set(m.lead_id, []);
      rejectionsByLead.get(m.lead_id).push({
        score: m.ranger_score,
        notes: m.ranger_notes,
        body_preview: (m.body || '').substring(0, 100),
      });
    } else if (['sent', 'pending_send', 'approved', 'delivered'].includes(m.status)) {
      if (!messagesByLead.has(m.lead_id)) messagesByLead.set(m.lead_id, []);
      messagesByLead.get(m.lead_id).push({
        subject: m.subject,
        body: m.body,
        channel: m.channel,
        metadata: m.metadata,
        sent_at: m.created_at,
      });
    }
  }

  // 4. Compose enriched rows
  return dueRows.map(fu => ({
    followup_id: fu.id,
    lead_id: fu.lead_id,
    touch_number: fu.touch_number,
    scheduled_for: fu.scheduled_for,
    lead: {
      id: fu.lead_id,
      name: fu.name,
      title: fu.title,
      email: fu.email,
      company: fu.company,
      linkedin_url: fu.linkedin_url,
      industry: fu.industry,
      signal: fu.signal,
      notes: fu.notes,
      quality_score: fu.quality_score,
      metadata: fu.metadata,
      sequence_touch: fu.sequence_touch,
      first_contacted_at: fu.first_contacted_at,
    },
    previous_messages: messagesByLead.get(fu.lead_id) || [],
    rejection_history: rejectionsByLead.get(fu.lead_id) || [],
  }));
}

/**
 * Draft a follow-up message for a specific touch.
 *
 * @param lead Lead object with context.
 * @param touchNumber 2-6.
 * @param previousMessages Array of prior message bodies/subjects.
 * @param captainAngle Optional. Captain's prescribed angle for this touch.
 *                     When present, Sales Beaver MUST follow it (no choice in angle).
 *                     When absent, Sales Beaver falls back to legacy behavior.
 */
async function draftFollowUp(lead, touchNumber, previousMessages, captainAngle = null) {
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
${lead.metadata?.signal ? `Signal: ${lead.metadata.signal}` : ''}
${lead.metadata?.notes ? `Notes: ${lead.metadata.notes}` : ''}

PREVIOUS MESSAGES (do NOT repeat any hook, angle, or pain point):
${previousSummary || 'No previous messages'}

TOUCH TYPE: ${config.type}
INSTRUCTION: ${config.instruction}
${captainAngle ? `
═══════════════════════════════════════════════════
CAPTAIN'S ANGLE DIRECTIVE (BINDING — NOT A SUGGESTION)
═══════════════════════════════════════════════════
Captain has analyzed this lead's full context, previous messages, and rejection
history. Your draft MUST follow this angle:

${captainAngle}

You may NOT choose a different angle. Your job is to write the message that
executes Captain's directive cleanly. The Enforcer will check whether your draft
follows the angle and reject it if you ignored the directive.
` : ''}
═══════════════════════════════════════════════════
THINK BEFORE YOU WRITE (mandatory reasoning step)
═══════════════════════════════════════════════════
Before drafting, answer these 4 questions in a "thinking" field:
1. What angles/hooks did I already use in previous messages to this person?
2. What do I ACTUALLY know about this specific company or person from the lead context that I haven't used yet?
3. What is my chosen angle for THIS touch, and why is it different from everything before?${captainAngle ? ' (Note: angle is BINDING per Captain directive above.)' : ''}
4. Can I write this without any fabricated facts? If not, what's missing?

${channelFormat}

Before returning, verify: word count under ${hardWordCap}? Question marks ≤ ${hardQuestionCap}? Every fact verifiable from lead context? If not, rewrite.

Return JSON only:
{"thinking":"Your 4-point analysis here","subject":${channel === 'email' ? '"..."' : 'null'},"body":"...","touch_number":${touchNumber}}`;

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

/**
 * Execute ONE approved follow-up: draft with Captain's angle, run Enforcer,
 * enqueue for send. Replaces the inline processing logic that used to live
 * in the 30-min cron (now disabled).
 *
 * Returns: { status: 'approved'|'rejected'|'skipped'|'error', message_id, score }
 */
async function executeApprovedFollowUp(clientId, followupId, captainAngle) {
  const { rangerReview } = require('./agents');
  const { enqueueMessage } = require('./sendQueueWorker');

  // 1. Load the follow-up + lead context + previous messages
  const { rows: [fu] } = await pool.query(
    `SELECT fq.*, l.name, l.title, l.email, l.company, l.linkedin_url,
            l.metadata, l.metadata->>'industry' AS industry,
            l.metadata->>'notes' AS notes, l.metadata->>'signal' AS signal
     FROM followup_queue fq
     JOIN leads l ON l.id = fq.lead_id
     WHERE fq.id = $1 AND fq.client_id = $2`,
    [followupId, clientId]
  );
  if (!fu) return { status: 'error', reason: 'followup_not_found' };
  if (fu.status !== 'pending') return { status: 'skipped', reason: `already_${fu.status}` };

  const { rows: prevMessages } = await pool.query(
    `SELECT subject, body, metadata, channel FROM messages
     WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved', 'delivered')
     ORDER BY created_at ASC`,
    [fu.lead_id, clientId]
  );
  const originalChannel = prevMessages[0]?.channel || 'email';

  // 2. Draft with Captain's angle directive
  let draft;
  try {
    draft = await draftFollowUp(fu, fu.touch_number, prevMessages, captainAngle);
  } catch (err) {
    console.warn(`[followup-exec] draft failed for ${fu.id}: ${err.message}`);
    return { status: 'error', reason: err.message };
  }

  if (draft?.status === 'needs_more_research') {
    await pool.query(`UPDATE followup_queue SET status = 'skipped' WHERE id = $1`, [fu.id]);
    return { status: 'skipped', reason: 'needs_more_research' };
  }
  if (!draft?.body) {
    return { status: 'error', reason: 'empty_draft' };
  }

  const cleanBody = draft.body.replace(/\s*—\s*/g, ', ').replace(/—/g, ' ');

  // 3. Server-side hard gates (same as old cron)
  const wordCap = fu.touch_number >= 2 ? 120 : 80;
  const questionCap = fu.touch_number >= 2 ? 2 : 1;
  const bodyText = cleanBody.replace(/^Hi\s+\w+,?\s*/i, '').replace(/\s*Regards,?\s*.*/is, '');
  const wordCount = bodyText.trim().split(/\s+/).length;
  const questionCount = (cleanBody.match(/\?/g) || []).length;
  if ((originalChannel === 'email' && wordCount > wordCap) || questionCount > questionCap) {
    await pool.query(`UPDATE followup_queue SET status = 'skipped' WHERE id = $1`, [fu.id]);
    return { status: 'skipped', reason: `over_cap:words=${wordCount}/${wordCap},q=${questionCount}/${questionCap}` };
  }

  // 4. Insert message + run Enforcer
  const followUpDay = fu.touch_number === 2 ? 2 : fu.touch_number === 3 ? 5 : fu.touch_number === 4 ? 10 : fu.touch_number === 5 ? 18 : 30;
  const { rows: [savedMsg] } = await pool.query(
    `INSERT INTO messages (client_id, lead_id, subject, body, status, metadata, channel, follow_up_day)
     VALUES ($1, $2, $3, $4, 'pending_ranger', $5, $6, $7) RETURNING id`,
    [clientId, fu.lead_id, draft.subject || null, cleanBody,
     JSON.stringify({ ...draft, is_followup: true, touch_number: fu.touch_number, captain_angle: captainAngle || null }),
     originalChannel, followUpDay]
  );

  let approved = false;
  let score = 0;
  try {
    const result = await rangerReview(clientId, {
      message_id: savedMsg.id,
      message_body: cleanBody,
      lead_context: { touch_number: fu.touch_number, is_followup: true, name: fu.name, channel: originalChannel, captain_angle: captainAngle },
    });
    approved = !!result?.approved;
    score = result?.score || 0;
    await pool.query(
      `UPDATE messages SET status = $1, ranger_score = $2, ranger_notes = $3, updated_at = NOW() WHERE id = $4`,
      [approved ? 'pending_approval' : 'ranger_rejected', score, result?.notes || (approved ? 'Enforcer approved' : `ranger_rejected:score=${score}`), savedMsg.id]
    );
  } catch (err) {
    await pool.query(`UPDATE messages SET status = 'ranger_rejected', ranger_notes = 'Enforcer unavailable', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
  }

  // 5. Auto-approval routing (only if Enforcer approved)
  if (approved) {
    const { rows: [clientRow] } = await pool.query(`SELECT auto_approve_threshold FROM clients WHERE id = $1`, [clientId]);
    const threshold = clientRow?.auto_approve_threshold;
    const autoApproved = threshold != null && score >= threshold;

    if (autoApproved) {
      const sendStatus = (originalChannel === 'email') ? 'pending_send' : 'approved';
      await pool.query(`UPDATE messages SET status = $1, updated_at = NOW() WHERE id = $2`, [sendStatus, savedMsg.id]);
      await pool.query(
        `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at) VALUES ($1, $2, 'auto_approval', 'approved', NOW())`,
        [clientId, savedMsg.id]
      );
      if (originalChannel === 'email') {
        await enqueueMessage(clientId, savedMsg.id).catch(() => {});
      }
    } else {
      await pool.query(`INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system')`, [clientId, savedMsg.id]);
    }
  }

  await pool.query(`UPDATE followup_queue SET status = $1, message_id = $2 WHERE id = $3`,
    [approved ? 'sent' : 'skipped', savedMsg.id, fu.id]);

  return { status: approved ? 'approved' : 'rejected', message_id: savedMsg.id, score };
}

module.exports = {
  scheduleFollowUps,
  stopSequence,
  pauseSequence,
  resumeSequence,
  getDueFollowUps,
  getDueFollowUpsWithContext,
  getLeadSequence,
  draftFollowUp,
  executeApprovedFollowUp,
  getStaleLeads,
  nextBusinessDay,
  MY_HOLIDAYS_2026,
  escalateChannel,
};
