'use strict';

const pool = require('../db/pool');
const { callAgent } = require('./claude');
const { addDaysToDateKey, nextBusinessDate, todayInMalaysia } = require('../utils/businessDay');

// 2026-05-23: post-process strip duplicated from agents.js (lines 110-118)
// to avoid circular require. Sales Beaver writes drafts that often include
// "Regards, / Michael Jerry" even when the prompt forbids it on LinkedIn.
// Without this strip in the FU path (draftFollowUp at line ~537), the bad
// sign-off survives to Enforcer → hard reject. Cold path (salesGenerate)
// already strips at line 894-901. This brings FU to parity.
const FU_SIGNOFF_STRIP_REGEX = /\n*\s*(regards|best(\s+regards)?|cheers|kind\s+regards|sincerely|warm\s+regards|thanks|thank\s+you|talk\s+soon|speak\s+soon|looking\s+forward(\s+to[\s\S]{0,40}?)?|chat\s+soon|all\s+the\s+best|yours(\s+truly|\s+sincerely)?|see\s+you\s+soon)[,!.\s]*[\r\n]+[\s\S]*$/i;
const FU_AGENT_NAME_STRIP_REGEX = /\n+\s*[—–-]*\s*(bryan(\s+beaver)?|enforcer(\s+beaver)?|sales(\s+beaver)?|captain(\s+beaver)?|ranger(\s+beaver)?|director(\s+beaver)?|research(\s+beaver)?|the\s+beaver(\s+(team|crew|solutions))?|the\s+team\s+at\s+beaver(\s+solutions)?|baver\s+solutions|beaver\s+solutions|the\s+beavrdam(\s+team)?|bobby(\s+beaver)?|bitton)[\s.!]*$/i;
function fuStripEmDashes(text) {
  if (!text) return text;
  return text.replace(/\s*—\s*/g, ', ').replace(/—/g, ' ').replace(/\s*–\s*/g, ', ').replace(/–/g, ' ');
}

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
  const dateKey = typeof date === 'string' ? date.slice(0, 10) : todayInMalaysia(date);
  return new Date(`${nextBusinessDate(dateKey, holidaySet)}T00:00:00.000Z`);
}

/**
 * Schedule follow-up touches 2-6 when a lead is first contacted.
 *
 * GUARD (2026-05-11, tightened 2026-05-13):
 *   Refuses to schedule unless touch 1 has actual delivery proof.
 *   - Email: any prior message with gmail_message_id OR agentmail_message_id populated
 *   - LinkedIn / Instagram: any prior message with status='sent' AND sent_at NOT NULL
 *                           AND NOT auto_sweep_graduated.
 *
 * Why the auto_sweep_graduated exclusion (2026-05-13):
 *   The disabled sweepStaleLinkedInRequests cron used to flip linkedin_requested →
 *   sent after 3 days *without proof of acceptance*. Even though that auto-graduate
 *   is now disabled (server/index.js line 1259), ~84 historic phantom-graduated
 *   rows survived in the DB and were triggering Day 2 follow-ups every night.
 *   Today's 9 visible phantom follow-ups were the symptom. The DM Sent button
 *   (markConnectionAccepted in approvals.js) is the only canonical proof: it
 *   sets status='sent' without ever stamping auto_sweep_graduated. So filtering
 *   that flag out lets real DM-sent messages pass while killing every phantom.
 *
 * Background: 33 leads were infected with phantom follow-ups (linkedin_requested,
 * simulated-sent email, ranger_rejected cold) because scheduleFollowUps was called
 * before the cold message actually went out. Day 2 follow-ups would then draft on
 * leads who never received touch 1 — breaking the conversation logic and wasting
 * Sonnet drafts. Guard prevents recurrence.
 */
async function scheduleFollowUps(clientId, leadId, firstContactDate) {
  // ─── Delivery-proof guard ────────────────────────────────────────────
  const { rows: proof } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE channel = 'email'
                          AND (gmail_message_id IS NOT NULL OR agentmail_message_id IS NOT NULL))
         AS email_delivered,
       COUNT(*) FILTER (WHERE channel IN ('linkedin', 'instagram')
                          AND status = 'sent'
                          AND sent_at IS NOT NULL
                          AND COALESCE((metadata->>'auto_sweep_graduated')::boolean, false) = false)
         AS manual_send_confirmed
     FROM messages
     WHERE lead_id = $1 AND client_id = $2`,
    [leadId, clientId]
  );
  const emailDelivered = parseInt(proof[0]?.email_delivered || 0, 10);
  const manualSent = parseInt(proof[0]?.manual_send_confirmed || 0, 10);

  if (emailDelivered === 0 && manualSent === 0) {
    console.warn(
      `[FollowUp] REFUSED to schedule for lead ${leadId}: no delivery proof for touch 1. ` +
      `email_delivered=${emailDelivered}, manual_send_confirmed=${manualSent}. ` +
      `Caller should only invoke scheduleFollowUps AFTER the cold message has actually been delivered.`
    );
    return { scheduled: false, reason: 'no_delivery_proof_for_touch_1' };
  }

  const firstContact = firstContactDate ? new Date(firstContactDate) : new Date();
  const baseDate = todayInMalaysia(Number.isNaN(firstContact.getTime()) ? new Date() : firstContact);

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

  let previousDate = null;
  for (const { touch, daysAfter } of schedule) {
    const scheduledFor = addDaysToDateKey(baseDate, daysAfter);
    let dateStr = nextBusinessDate(scheduledFor, holidaySet);
    while (previousDate && dateStr <= previousDate) {
      dateStr = nextBusinessDate(addDaysToDateKey(previousDate, 1), holidaySet);
    }
    previousDate = dateStr;

    await pool.query(
      `INSERT INTO followup_queue (client_id, lead_id, touch_number, scheduled_for)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lead_id, touch_number) DO NOTHING`,
      [clientId, leadId, touch, dateStr]
    );
  }

  const touch2Date = nextBusinessDate(addDaysToDateKey(baseDate, 2), holidaySet);

  await pool.query(
    `UPDATE leads SET
       first_contacted_at = COALESCE(first_contacted_at, $1),
       sequence_touch = 1,
       next_followup_at = $2
     WHERE id = $3`,
    [firstContactDate, touch2Date, leadId]
  );

  console.log(`[FollowUp] Scheduled ${schedule.length} follow-ups for lead ${leadId} (Day 2/5/10/18/30)`);
  return { scheduled: true, count: schedule.length };
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

// ─── Daily follow-up draft cap ──────────────────────────────────
// A backlog of due follow-ups must not burst-draft in a single autonomous run.
// 2026-05-30: 119 due → 101 drafted in 70 min, which consumed the ENTIRE daily
// LLM budget BEFORE cold outreach got a turn (the autonomous run drafts
// follow-ups first, in routes/autonomous.js). This caps how many follow-ups the
// autonomous fetchers return per MYT business day, net of those already drafted
// today, so a backlog drains at a bounded rate instead of all at once.
// Env-overridable. Manual/admin single-draft endpoints don't call these
// fetchers, so they're unaffected.
const FOLLOWUP_DAILY_DRAFT_CAP = Number(process.env.FOLLOWUP_DAILY_DRAFT_CAP) || 25;

// Count follow-up messages already drafted today (MYT business day). Only real
// follow-up touches count toward this cap; channel escalations are separate and
// are capped in autonomous.js.
async function followUpsDraftedToday(clientId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM messages
      WHERE client_id = $1
        AND follow_up_day IS NOT NULL
        AND follow_up_day > 0
        AND COALESCE(metadata->>'is_channel_escalation', 'false') <> 'true'
        AND created_at >= date_trunc('day', (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) AT TIME ZONE 'Asia/Kuala_Lumpur'`,
    [clientId]
  );
  return rows[0]?.n || 0;
}

// Remaining follow-up drafts allowed for the current MYT day = cap − already drafted.
async function remainingFollowUpCapacity(clientId) {
  const drafted = await followUpsDraftedToday(clientId);
  return Math.max(0, FOLLOWUP_DAILY_DRAFT_CAP - drafted);
}

/**
 * Get all follow-ups due today or earlier for a specific client.
 * Hard-capped at the remaining daily follow-up draft allowance — the autonomous
 * run drafts everything this returns, so the LIMIT here is the ceiling on
 * follow-up drafts/day.
 */
async function getDueFollowUps(clientId) {
  const today = todayInMalaysia();
  const capRemaining = await remainingFollowUpCapacity(clientId);
  if (capRemaining <= 0) {
    console.warn(`[FollowUp] Daily draft cap reached for client ${clientId} (cap=${FOLLOWUP_DAILY_DRAFT_CAP}); deferring remaining due follow-ups to tomorrow.`);
    return [];
  }
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
       AND l.last_reply_at IS NULL
       AND l.deleted_at IS NULL
     ORDER BY fq.scheduled_for ASC
     LIMIT $3`,
    [clientId, today, capRemaining]
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
  const today = todayInMalaysia();

  // Daily cap (see getDueFollowUps): plan only what can still be drafted today,
  // net of follow-ups already drafted, so Captain doesn't propose angles for a
  // backlog the drafter won't reach.
  const capRemaining = await remainingFollowUpCapacity(clientId);
  if (capRemaining <= 0) return [];

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
     ORDER BY fq.scheduled_for ASC
     LIMIT $3`,
    [clientId, today, capRemaining]
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

  // PER-TOUCH ROLE per BEAVER_FOLLOWUP_FORMAT.md v1.0 (2026-05-12).
  // Each touch must ALSO satisfy the 4-part structure enforced in FOLLOW-UP RULES below.
  // MIRROR OF MJxClaude/sales-assets/BEAVER_FOLLOWUP_FORMAT.md — keep in sync.
  const touchConfig = {
    2: {
      type: 'FU2 Day 2 — New angle, reference touch 1',
      instruction: 'Reference touch 1 SPECIFICALLY — name the point you made. Then offer a different angle on the same outbound pain. The diagnostic question must be NARROWER than the one in touch 1.',
      maxWords: 70,
    },
    3: {
      type: 'FU3 Day 5 — Pattern interrupt with new trigger',
      instruction: 'Pattern interrupt. Reference a NEW verifiable signal about them from the last 7-14 days (their LinkedIn post, hire, talk, milestone). Do NOT reference touch 1. New angle, new ask.',
      maxWords: 60,
    },
    4: {
      type: 'FU4 Day 10 — Contrarian observation',
      instruction: 'Share one contrarian or non-obvious observation about their industry, role, or growth stage. Peer voice, not vendor. Soft diagnostic question. Do NOT reference any prior message.',
      maxWords: 70,
    },
    5: {
      type: 'FU5 Day 18 — Soft break-up',
      instruction: 'Honest break-up. "Last note from me for now." Door-open clause referencing their specific situation from lead context. No pressure. Still has all 4 parts (reference, insight, ask, opt-out).',
      maxWords: 50,
    },
    6: {
      type: 'FU6 Day 30 — Re-awaken with new context',
      instruction: 'Come back referencing a NEW verifiable trigger from the last 30 days (LinkedIn post, hire, milestone, vertical shift). Must feel like a fresh conversation, not "touch 6 of 6". One specific question.',
      maxWords: 70,
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

  // Channel-specific format instructions per BEAVER_FOLLOWUP_FORMAT.md sign-off rules
  const channelFormat = channel === 'email'
    ? `FORMAT (email follow-up):
Hi ${lead.name?.split(' ')[0] || 'there'},

{body — max ${config.maxWords} words. Must contain all 4 parts: reference/trigger, insight, 1-3-word-answerable diagnostic Q, opt-out clause.}

Regards,
Michael Jerry

HARD RULES: No em dashes (—). Max 1 question mark. No bullets. Email ALWAYS closes with "Regards," on one line then "Michael Jerry" on the next line, exactly as shown above.`
    : `FORMAT (${channel} DM follow-up):
{body — max ${config.maxWords} words. Must contain all 4 parts: reference/trigger, insight, 1-3-word-answerable diagnostic Q, opt-out clause. Casual tone. No greeting line. Name "Michael" only if natural at end.}

HARD RULES: No em dashes (—). Max 1 question mark. No bullets. NO formal sign-off ("Regards,", "Best,", "Cheers,").`;

  // Per-touch word cap from config (BEAVER_FOLLOWUP_FORMAT.md v1.0).
  // Retry path: if caller passed _retry_constraint, tighten the caps further.
  const retryConstraint = lead?._retry_constraint;
  const hardWordCap = retryConstraint?.wordCap ?? config.maxWords;
  const hardQuestionCap = retryConstraint?.questionCap ?? 1;

  const prompt = `You are Sales Beaver writing Touch ${touchNumber} of 6 in a follow-up sequence on ${channel}.

PRE-GATE CONSTRAINT (server rejects drafts that violate these — NON-NEGOTIABLE):
- Body must be under ${hardWordCap} words. Count the words in your draft before returning.
- Body must contain AT MOST ${hardQuestionCap} question mark. Zero or one. Never two.
- No em dashes. No bullet points.

FOLLOW-UP RULES (v1.0 — these override cold-DM rules for follow-ups):

THE 4-PART STRUCTURE (mandatory — every follow-up must have all four):
1. REFERENCE OR NEW TRIGGER (exactly one): Either name a specific point from a previous touch in this sequence ("Sent you a note Tuesday on [specific thing]...") OR cite a NEW verifiable event from the last 7-30 days about them (LinkedIn post, hire, talk, milestone). Never both, never neither.
2. INSIGHT: One non-obvious observation tied to their specific situation. Peer voice, not vendor. NOT a pitch, NOT a stat, NOT generic industry commentary.
3. NARROWER ASK: A diagnostic question answerable in 1-3 words. Each touch the question gets MORE specific. NEVER "does this make sense?" / "any thoughts?" / "wdyt?" / "want to chat?" — those are qualification frames, not questions.
4. OPT-OUT: One graceful exit clause. e.g. "If timing's off, happy to close the loop." / "If this isn't on your plate, no worries — I'll move on." NEVER absent.

BANNED PHRASES (instant regenerate — case-insensitive):
- "still thinking" / "just thinking" / "still wondering"
- "just checking in" / "circling back" / "following up on" / "touching base"
- "does X make sense" (qualification frame)
- "for [Company] right now?" (template tell)
- "any thoughts" / "wdyt" / "let me know your thoughts"
- "Most founders" / "Most [role]s I talk to" / "Most [persona] I come across" (cold-tell)
- "quick favor" / "quick ask"
- "Hope this finds you well" / "Hope you're doing well" / "Hope all is well"
${channel === 'email' ? '- Sign-off: the email close is "Regards," then "Michael Jerry" (see FORMAT above). No other closing words.' : '- Formal sign-offs: "Regards,", "Best regards,", "Sincerely,", "Cheers," (DM follow-ups end on the question, no sign-off)'}

OTHER HARD RULES:
- ANTI-FABRICATION: Every company name, product, role, or fact MUST come from LEAD context or PREVIOUS MESSAGES. Lead context "Unknown" → return needs_more_research.
- ANTI-ABSTRACTION (2026-05-23): When PART 1 references a prior message, you MUST quote a specific phrase or fact verbatim from PREVIOUS MESSAGES (e.g., "your note about hiring senior talent", "the SeekSocial positioning point"). Generic abstractions like "growth", "momentum", "positioning", "scaling", "success", "expansion" are NOT references — they are fabrications. If the prior message did not state the exact fact you want to reference, switch to PART 1 = new trigger instead. The Enforcer will reject any reference that paraphrases or generalizes the prior message's specifics.
- NO STATS OR NUMBERS: No percentage, statistic, or numeric benchmark in follow-ups. The cold message owned the stat — follow-ups don't repeat them.
- ANTI-REPETITION: NEVER reuse a hook, angle, pain point, or phrase from PREVIOUS MESSAGES. Each touch is a new thought, not a rephrased version of the last.
- SENDER IDENTITY: ${channel === 'email' ? 'The email closes with "Regards," then "Michael Jerry" (see FORMAT).' : 'Sign as "Michael" only if natural at the end, otherwise end on the question.'} Never "The Team", never "Sales Beaver", never the lead's name, never the abbreviation "MJ".
- If you cannot write a non-fabricated follow-up with the context provided, return: {"status":"needs_more_research","missing_fields":["<what's missing>"],"reason":"Insufficient context for non-fabricated follow-up."}

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
THINK BEFORE YOU WRITE (mandatory reasoning + self-check)
═══════════════════════════════════════════════════
Before drafting, fill out this self-check in your "thinking" field. ALL 8 items must pass. If any fail, regenerate or return needs_more_research.

1. PART 1 (Reference OR new trigger): Quote the exact phrase you'll use. Confirm: (a) it's either a reference to a prior touch OR a NEW verifiable signal, not both, not neither. (b) IF a reference: the exact specific phrase you reference MUST appear verbatim or near-verbatim in PREVIOUS MESSAGES above — quote that source phrase too. Generic abstractions ("growth", "momentum", "positioning", "scaling", "success", "expansion") are NOT valid references — they are fabrications.
2. PART 2 (Insight): Quote it. Confirm: not a stat, not a pitch, not generic industry commentary.
3. PART 3 (1-3-word-answerable diagnostic Q): Quote it. Confirm: not "does this make sense?" / "any thoughts?" / "want to chat?".
4. PART 4 (Opt-out clause): Quote it.
5. Anti-repetition: List the hooks/angles used in PREVIOUS MESSAGES. Confirm yours is DIFFERENT.
6. Banned-phrase scan: Walk the banned list above. Confirm zero hits in your draft.
7. Word count: count the body. Confirm under ${hardWordCap}.
8. Question count: confirm ≤ ${hardQuestionCap} question mark.
${captainAngle ? '\n9. Captain angle compliance: confirm your draft follows the BINDING directive above.\n' : ''}
${channelFormat}

Before returning, re-verify the 8-item self-check above. If any item fails, rewrite.

Return JSON only:
{"thinking":"Your 8-item self-check here, each item on its own line","subject":${channel === 'email' ? '"..."' : 'null'},"body":"...","touch_number":${touchNumber}}`;

  // 2026-05-23: post-process strip+append parity with salesGenerate cold path
  // (agents.js:894-901). Sales Beaver writes "Regards, Michael Jerry" on
  // LinkedIn FU drafts despite the prompt forbidding it; without this strip,
  // the bad sign-off survives to Enforcer → hard reject. Today: 14 of 23
  // rejects today were this exact pattern. Hardcoded "Michael Jerry" matches
  // the existing hardcode in the email FORMAT block at line ~442.
  const result = await callAgent('sales_beaver', prompt, { clientId, channel, mode: 'followup' });
  if (result && typeof result.body === 'string' && result.body.length > 0) {
    let stripped = fuStripEmDashes(result.body)
      .replace(FU_SIGNOFF_STRIP_REGEX, '').replace(/\s+$/, '')
      .replace(FU_AGENT_NAME_STRIP_REGEX, '').replace(/\s+$/, '');
    result.body = (channel === 'email')
      ? `${stripped}\n\nRegards,\nMichael Jerry`
      : stripped;
  }
  return result;
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
    `SELECT id, name, company, email, linkedin_url, sequence_status, sequence_touch, last_reply_at, metadata
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
  // linkedin_url lives in the leads COLUMN (VP/Research Beaver write it there);
  // metadata is a legacy fallback. Reading metadata only silently killed touch-3
  // escalation for every lead whose linkedin_url is column-only (e.g. all VP imports).
  const hasLinkedin = !!(lead.linkedin_url || meta.linkedin_url || meta.linkedin);
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
async function executeApprovedFollowUp(clientId, followupId, captainAngle, angleTemplateId, opts = {}) {
  const { safeMode = false } = opts;
  // safeMode=true: skip auto-approval routing. Drafts land in pending_approval
  // (or ranger_rejected if Enforcer fails). MJ reviews in UI. NO auto-send.
  // Use during validation runs when you don't want emails to actually fire.
  const { rangerReview } = require('./agents');
  const { enqueueMessage } = require('./sendQueueWorker');
  const { postFollowUpOutcome } = require('./learningEngine');

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
     WHERE lead_id = $1 AND client_id = $2 AND status IN ('sent', 'pending_send', 'approved', 'delivered', 'linkedin_requested', 'awaiting_accept')
     ORDER BY created_at ASC`,
    [fu.lead_id, clientId]
  );

  // Orphan guard (2026-05-13). If prevMessages is empty, the follow-up has no
  // real touch 1 to anchor against. Sales Beaver will fabricate a prior touch
  // and Enforcer will correctly reject as fabrication — 100% wasted Sonnet
  // spend, 100% reject rate. Cancel the row and log. The trust boundary at
  // scheduleFollowUps (lines 99-106) catches this at schedule time; this guard
  // catches rows that bypassed scheduleFollowUps (direct INSERT, captain
  // directives, migrations, prior-bug fallout).
  if (!prevMessages || prevMessages.length === 0) {
    console.warn(`[FollowUp] ORPHAN: lead ${fu.lead_id} has no prior touches — cancelling follow-up ${followupId}`);
    await pool.query(
      `UPDATE followup_queue SET status='cancelled' WHERE id=$1 AND client_id=$2`,
      [followupId, clientId]
    );
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, metadata, created_at)
       VALUES ($1, 'system', 'followup_cancelled_orphan', 'followup_queue', $2, NOW())`,
      [clientId, JSON.stringify({ followup_id: followupId, lead_id: fu.lead_id, touch_number: fu.touch_number, reason: 'no_prior_touches' })]
    );
    return { status: 'cancelled', reason: 'orphan_no_prior_touches' };
  }

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
    console.warn(`[followup-exec] needs_more_research for ${fu.id} (lead ${fu.lead_id}) — missing: ${(draft.missing_fields || []).join(', ')}. Lead dropped from sequence.`);
    await pool.query(`UPDATE followup_queue SET status = 'skipped', updated_at = NOW() WHERE id = $1`, [fu.id]);
    await pool.query(
      `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata, created_at)
       VALUES ($1, 'followup_scheduler', 'needs_more_research', 'lead', $2, $3::jsonb, NOW())`,
      [fu.client_id, fu.lead_id, JSON.stringify({ followup_id: fu.id, missing: draft.missing_fields || [], touch: fu.touch_number })]
    ).catch(err => console.warn('[followup-exec] failed to log needs_more_research:', err.message));
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
  let rejectReason = null;
  try {
    // Build previous_messages_summary so Enforcer can verify "Sent you a note..."
    // references aren't fabricated. v1.0 follow-up format calls for these references;
    // without summary in lead_context, Enforcer gate #9 (FABRICATION) flagged every one.
    const previousMessagesSummary = (prevMessages || []).map((m, i) =>
      `[Touch ${i + 1} (${m.channel || 'email'}): ${(m.body || '').substring(0, 200).replace(/\n+/g, ' ')}]`
    ).join(' ');

    const result = await rangerReview(clientId, {
      message_id: savedMsg.id,
      message_body: cleanBody,
      lead_context: {
        touch_number: fu.touch_number, is_followup: true, name: fu.name, channel: originalChannel, captain_angle: captainAngle,
        company: fu.company, title: fu.title, signal: fu.signal || fu.metadata?.signal, angle: fu.metadata?.angle, why_now: fu.metadata?.why_now,
        previous_messages_summary: previousMessagesSummary,
      },
    });
    approved = !!result?.approved;
    score = result?.score || 0;
    rejectReason = approved ? null : (result?.reject_reason || result?.notes || `ranger_rejected:score=${score}`);
    await pool.query(
      `UPDATE messages SET status = $1, ranger_score = $2, ranger_notes = $3, updated_at = NOW() WHERE id = $4`,
      [approved ? 'pending_approval' : 'ranger_rejected', score, result?.notes || (approved ? 'Enforcer approved' : rejectReason), savedMsg.id]
    );
  } catch (err) {
    await pool.query(`UPDATE messages SET status = 'ranger_rejected', ranger_notes = 'Enforcer unavailable', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
    rejectReason = 'enforcer_unavailable';
  }

  // Phase 4: capture outcome to learning store
  await postFollowUpOutcome(clientId, {
    messageId: savedMsg.id,
    leadId: fu.lead_id,
    company: fu.company,
    industry: fu.industry,
    touch_number: fu.touch_number,
    channel: originalChannel,
    angle_template_id: angleTemplateId || null,
    captain_angle_preview: captainAngle ? captainAngle.substring(0, 80) : null,
    enforcer_score: score,
    enforcer_passed: approved,
    enforcer_rejection_reason: rejectReason,
    mj_action: null,
    mj_override: false,
    reply_outcome: null,
  }).catch(() => {});

  // 5. Auto-approval routing (only if Enforcer approved)
  if (approved) {
    if (safeMode) {
      // Validation-run path: skip ALL auto-routing. Always land in pending_approval
      // so MJ reviews every draft in UI. NO auto-send, even for email above threshold.
      await pool.query(`INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system_safe_mode')`, [clientId, savedMsg.id]);
    } else {
      const { rows: [clientRow] } = await pool.query(`SELECT auto_approve_threshold FROM clients WHERE id = $1`, [clientId]);
      const threshold = clientRow?.auto_approve_threshold;
      const autoApproved = threshold != null && score >= threshold;

      if (autoApproved) {
        if (originalChannel === 'email') {
          await pool.query(`UPDATE messages SET status = 'pending_send', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by, status, resolved_at) VALUES ($1, $2, 'auto_approval', 'approved', NOW())`,
            [clientId, savedMsg.id]
          );
          await enqueueMessage(clientId, savedMsg.id).catch(() => {});
        } else {
          // LinkedIn: route to "Ready to Send" tab. MJ sends DM manually, then clicks "DM Sent".
          await pool.query(`UPDATE messages SET status = 'linkedin_requested', updated_at = NOW() WHERE id = $1`, [savedMsg.id]);
          await pool.query(
            `INSERT INTO approvals (client_id, message_id, requested_by, status, notes) VALUES ($1, $2, 'auto_approval', 'pending', 'linkedin_requested')`,
            [clientId, savedMsg.id]
          );
        }
      } else {
        await pool.query(`INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'system')`, [clientId, savedMsg.id]);
      }
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
  followUpsDraftedToday,
  remainingFollowUpCapacity,
  FOLLOWUP_DAILY_DRAFT_CAP,
};
