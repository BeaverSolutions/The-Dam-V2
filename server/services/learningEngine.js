'use strict';

/**
 * Learning Engine — Captain Beaver's self-improvement system.
 *
 * Writes structured observations to agent_memory after each session,
 * campaign, and reply event. Generates weekly summaries. Injects
 * accumulated learnings as context at the start of each conversation.
 *
 * All storage goes through agent_memory (client_id, agent, key) so it
 * survives Railway redeploys and is readable by any agent in the crew.
 */

const pool = require('../db/pool');
const { callAgent } = require('./claude');
const logger = require('../utils/logger');

// ─── Memory upsert helper ──────────────────────────────────────────────────

async function setMemory(clientId, agent, key, content) {
  await pool.query(
    `INSERT INTO agent_memory (client_id, agent, key, content, memory_type, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, 'journal', NOW())
     ON CONFLICT (client_id, agent, key)
     DO UPDATE SET content = $4::jsonb, updated_at = NOW()`,
    [clientId, agent, key, JSON.stringify(content)]
  );
}

async function getMemory(clientId, agent, key) {
  try {
    const { rows } = await pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = $2 AND key = $3 LIMIT 1`,
      [clientId, agent, key]
    );
    return rows[0]?.content || null;
  } catch {
    return null;
  }
}

// ─── Shared memory (Phase 1: capture — populates data for Phase 2 strategy) ─
// All agents read/write under agent='shared'. Used so Captain's weekly review
// (Phase 2) has cross-agent signal to synthesize strategy from. No agent
// READS from shared/ yet — this is pure capture.
//
// Keys in use:
//   shared/wins                   — positive replies with hook + industry + signal
//   shared/mistakes               — Enforcer rejections with reason + score + excerpt
//   shared/campaign_trend         — per-campaign metrics + pass/reply rates
//   shared/daily_<agent>_<date>   — per-agent daily reflection (Phase 1.5)
//   shared/daily_<agent>_log      — rolling 30-day list of reflections per agent

async function appendSharedMemory(clientId, key, entry, maxEntries = 50) {
  try {
    const existing = await getMemory(clientId, 'shared', key);
    const list = Array.isArray(existing) ? existing : [];
    list.unshift({ ts: new Date().toISOString(), ...entry });
    await setMemory(clientId, 'shared', key, list.slice(0, maxEntries));
  } catch (err) {
    logger.warn({ msg: 'appendSharedMemory failed', key, err: err.message });
  }
}

/**
 * Capture an Enforcer rejection so Phase 2 strategy can see rejection patterns.
 * Called from rangerReview when it returns approved=false.
 */
async function postRangerRejection(clientId, { messageBody, notes, score, channel, leadIndustry }) {
  await appendSharedMemory(clientId, 'mistakes', {
    type: 'enforcer_rejection',
    excerpt: typeof messageBody === 'string' ? messageBody.slice(0, 240) : null,
    notes: typeof notes === 'string' ? notes.slice(0, 400) : null,
    score: typeof score === 'number' ? score : null,
    channel: channel || null,
    industry: leadIndustry || null,
  });
}

// ─── Phase 1.5: Daily agent self-reflection ────────────────────────────────
// Each agent reviews today's activity from the logs table and writes a short
// reflection (did_well / went_wrong / focus_tomorrow) to shared memory.
// Activity-gated: skips silently if the agent took fewer than MIN_ACTIVITY
// actions today, so slow days don't pollute memory with vague summaries.

const DAILY_REFLECTION_MIN_ACTIVITY = 3;

async function generateAgentDailySummary(clientId, agent) {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Idempotent: skip if today's reflection for this agent is already written
    const existing = await getMemory(clientId, 'shared', `daily_${agent}_${today}`);
    if (existing) return { skipped: 'already_ran' };

    // Pull today's activity for this agent from the logs table
    const { rows: activity } = await pool.query(
      `SELECT action, metadata, created_at
         FROM logs
        WHERE client_id = $1
          AND agent = $2
          AND created_at >= CURRENT_DATE
        ORDER BY created_at ASC
        LIMIT 100`,
      [clientId, agent]
    );

    if (activity.length < DAILY_REFLECTION_MIN_ACTIVITY) {
      return { skipped: 'below_threshold', count: activity.length };
    }

    // Compact activity summary for the reflection prompt
    const activitySummary = activity
      .map(a => {
        const note = a.metadata?.notes || a.metadata?.reason || a.metadata?.feedback;
        return note ? `${a.action} (${String(note).slice(0, 60)})` : a.action;
      })
      .join(', ');

    const prompt = `You are the ${agent} for The Dam outbound sales system. Here is what you did today (${activity.length} actions):

${activitySummary}

Reflect in 2-3 sentences covering specifically: one concrete thing that went well, one concrete friction or mistake (if any — skip if none), and one specific focus for tomorrow. Be specific to what you actually did. No vague self-congratulation. No hedging. Return {"summary": "your reflection"}.`;

    const result = await callAgent('brief_writer', prompt, { clientId });
    const reflection = (result?.summary || '').trim();

    // Empty or unparseable reflection → don't pollute memory
    if (!reflection || reflection.length < 20) {
      return { skipped: 'empty_reflection' };
    }

    const entry = {
      ts: new Date().toISOString(),
      agent,
      date: today,
      activity_count: activity.length,
      reflection,
    };

    // Date-keyed per-agent record for point-in-time lookup
    await setMemory(clientId, 'shared', `daily_${agent}_${today}`, entry);
    // Rolling log capped at 30 days so Phase 2 strategist has a week-of-history window
    await appendSharedMemory(clientId, `daily_${agent}_log`, entry, 30);

    return entry;
  } catch (err) {
    logger.warn({ msg: 'generateAgentDailySummary failed', agent, err: err.message });
    return { error: err.message };
  }
}

// ─── Telegram history (DB-backed, cap 6 turns × 4000 chars) ───────────────

async function getTelegramHistory(clientId, chatId) {
  const data = await getMemory(clientId, 'captain', `telegram_history_${chatId}`);
  return Array.isArray(data) ? data : [];
}

async function saveTelegramHistory(clientId, chatId, history) {
  // Cap at 6 turns, each content string at 4000 chars
  const capped = history
    .slice(-6)
    .map(msg => ({
      ...msg,
      content: typeof msg.content === 'string'
        ? msg.content.slice(0, 4000)
        : msg.content,
    }));
  await setMemory(clientId, 'captain', `telegram_history_${chatId}`, capped);
}

// ─── Post-session learning ─────────────────────────────────────────────────

/**
 * Called after every Captain Beaver conversation turn (chat or Telegram).
 * Appends a compact session record keyed by date so we can see what the
 * captain was asked and what tools it used, over time.
 */
async function postSessionLearning(clientId, { command, toolsUsed = [], outcome = 'ok' }) {
  try {
    const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const existing = await getMemory(clientId, 'captain', `chat_sessions_${dateKey}`);
    const sessions = Array.isArray(existing) ? existing : [];

    sessions.push({
      ts: new Date().toISOString(),
      command: command?.slice(0, 200),
      tools: toolsUsed,
      outcome,
    });

    // Keep last 50 sessions per day
    await setMemory(clientId, 'captain', `chat_sessions_${dateKey}`, sessions.slice(-50));
  } catch (err) {
    logger.warn({ msg: 'postSessionLearning failed', err: err.message });
  }
}

// ─── Post-campaign debrief ─────────────────────────────────────────────────

/**
 * Called at the end of directorExecute(). Writes campaign metrics to
 * agent_memory so future runs can see what worked (high Enforcer pass rate,
 * industries, etc.) and adjust.
 */
async function postCampaignDebrief(clientId, {
  planId,
  leadsFound = 0,
  messagesDrafted = 0,
  enforcerPassed = 0,
  enforcerFailed = 0,
}) {
  try {
    const passRate = messagesDrafted > 0
      ? Math.round((enforcerPassed / messagesDrafted) * 100)
      : null;

    const entry = {
      ts: new Date().toISOString(),
      plan_id: planId,
      leads_found: leadsFound,
      messages_drafted: messagesDrafted,
      enforcer_passed: enforcerPassed,
      enforcer_failed: enforcerFailed,
      pass_rate: passRate,
    };

    await setMemory(clientId, 'director', `campaign_${planId}`, entry);

    // Also append to rolling campaign log for weekly review
    const existing = await getMemory(clientId, 'director', 'campaign_log');
    const log = Array.isArray(existing) ? existing : [];
    log.push({ planId, passRate, leadsFound, messagesDrafted, ts: entry.ts });
    await setMemory(clientId, 'director', 'campaign_log', log.slice(-30)); // last 30 campaigns

    // Shared capture — Phase 2 weekly strategy will read campaign_trend
    await appendSharedMemory(clientId, 'campaign_trend', {
      type: 'campaign_complete',
      plan_id: planId,
      leads_found: leadsFound,
      messages_drafted: messagesDrafted,
      enforcer_passed: enforcerPassed,
      enforcer_failed: enforcerFailed,
      pass_rate: passRate,
    }, 30);
  } catch (err) {
    logger.warn({ msg: 'postCampaignDebrief failed', err: err.message });
  }
}

// ─── Reply pattern learning ────────────────────────────────────────────────

/**
 * Called by replyDetector after classifying each incoming reply.
 * Tracks what angles, industries, and signals get positive responses.
 */
async function postReplyLearning(clientId, {
  sentiment,
  leadIndustry,
  angleUsed,
  companySignal,
}) {
  try {
    const existing = await getMemory(clientId, 'sales_beaver', 'reply_patterns');
    const patterns = existing || {
      positive: [],
      neutral: [],
      objection: [],
      no_fit: [],
      updated_at: null,
    };

    const entry = {
      ts: new Date().toISOString(),
      industry: leadIndustry,
      angle: angleUsed,
      signal: companySignal,
    };

    const bucket = patterns[sentiment] || [];
    bucket.unshift(entry);
    patterns[sentiment] = bucket.slice(0, 20); // keep last 20 per sentiment
    patterns.updated_at = new Date().toISOString();

    await setMemory(clientId, 'sales_beaver', 'reply_patterns', patterns);

    // Shared capture — winning hooks go into shared/wins for Phase 2 strategy.
    // Only positive replies count as wins (neutral/objection/no_fit don't
    // validate the hook). Non-positive outcomes still go into the sales_beaver
    // reply_patterns above for full classification visibility.
    if (sentiment === 'positive') {
      await appendSharedMemory(clientId, 'wins', {
        type: 'positive_reply',
        industry: leadIndustry,
        angle: angleUsed,
        signal: companySignal,
      });
    }
  } catch (err) {
    logger.warn({ msg: 'postReplyLearning failed', err: err.message });
  }
}

// ─── Phase 4: Captain-led follow-up learning (2026-05-11) ──────────────────
// Unified outcome capture for follow-ups. Every event (Enforcer decision,
// MJ approval/rejection/edit, reply detection, 7-day silence) writes a row
// to shared/followup_learnings. Each beaver reads this dataset before their
// work:
//   - Captain → biases angle template selection toward winners
//   - Sales Beaver → adapts tone/length based on what passed Enforcer + got replies
//   - Enforcer → calibrates threshold based on MJ override rate + reply rate
//   - Research Beaver → prioritizes signal types that produced replies
//
// Schema (each entry in shared/followup_learnings array):
// {
//   ts: ISO timestamp,
//   message_id: uuid,
//   lead_id: uuid,
//   company: string,
//   industry: string,
//   touch_number: 2-6,
//   channel: 'email'|'linkedin',
//   angle_template_id: 1-10 (from Captain's plan),
//   captain_angle_preview: 80-char snippet,
//   enforcer_score: 0-100,
//   enforcer_passed: boolean,
//   enforcer_rejection_reason: string|null,
//   mj_action: 'approved'|'rejected'|'edited'|'pending'|null,
//   mj_override: boolean (true when MJ disagreed with Enforcer),
//   reply_outcome: 'positive'|'neutral'|'objection'|'no_fit'|'no_reply_7d'|null,
//   reply_at: ISO|null,
// }

/**
 * Record an outcome event for a follow-up message. Idempotent on message_id —
 * subsequent calls with the same message_id update the same entry (rather than
 * creating duplicates as the message moves through stages).
 *
 * Called at multiple lifecycle points:
 *   - After Enforcer review: { messageId, leadId, ... enforcerScore, enforcerPassed }
 *   - After MJ approval/rejection: { messageId, mjAction, mjOverride }
 *   - After reply detected: { messageId, replyOutcome, replyAt }
 *   - After 7-day silence: { messageId, replyOutcome: 'no_reply_7d' }
 */
async function postFollowUpOutcome(clientId, update) {
  if (!update?.messageId) return;
  try {
    const existing = await getMemory(clientId, 'shared', 'followup_learnings');
    const list = Array.isArray(existing) ? existing : [];

    const idx = list.findIndex(e => e.message_id === update.messageId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...update, message_id: update.messageId, updated_at: new Date().toISOString() };
    } else {
      list.unshift({
        ts: new Date().toISOString(),
        message_id: update.messageId,
        ...update,
      });
    }
    // Keep most-recent 200 (~30 days at 7 follow-ups/day average)
    await setMemory(clientId, 'shared', 'followup_learnings', list.slice(0, 200));
  } catch (err) {
    logger.warn({ msg: 'postFollowUpOutcome failed', err: err.message });
  }
}

/**
 * Record an MJ override event. Called when MJ approves a ranger_rejected
 * message OR rejects a pending_approval (Enforcer approved). This is the
 * primary signal for Enforcer self-calibration.
 */
async function recordMJOverride(clientId, { messageId, originalDecision, mjDecision, mjEditedBody }) {
  await postFollowUpOutcome(clientId, {
    messageId,
    mj_action: mjDecision,
    mj_override: originalDecision !== mjDecision,
    mj_edited: !!mjEditedBody,
  });
}

/**
 * Summarize follow-up learnings for Captain's planning prompt.
 * Returns a compact text block that Captain reads before proposing angles.
 *
 * Surfaces:
 *   - Winning angle templates (most replies in last 30 entries)
 *   - Losing angle templates (most Enforcer rejections)
 *   - MJ override patterns (where MJ disagreed with Enforcer)
 */
async function summarizeFollowUpLearnings(clientId, opts = {}) {
  try {
    const list = await getMemory(clientId, 'shared', 'followup_learnings');
    if (!Array.isArray(list) || list.length === 0) {
      return 'No follow-up learnings yet — this is a cold-start day. Use templates per the angle library defaults.';
    }

    const recent = list.slice(0, opts.lookback || 100);

    // Tally by angle_template_id
    const tally = new Map();
    for (const e of recent) {
      const id = e.angle_template_id;
      if (!id) continue;
      const row = tally.get(id) || { template_id: id, count: 0, passed: 0, rejected: 0, positive_reply: 0, neutral_reply: 0, no_reply: 0 };
      row.count++;
      if (e.enforcer_passed) row.passed++; else row.rejected++;
      if (e.reply_outcome === 'positive') row.positive_reply++;
      else if (e.reply_outcome === 'neutral' || e.reply_outcome === 'objection') row.neutral_reply++;
      else if (e.reply_outcome === 'no_reply_7d') row.no_reply++;
      tally.set(id, row);
    }

    const winners = [...tally.values()].filter(r => r.positive_reply > 0)
      .sort((a, b) => (b.positive_reply / Math.max(1, b.count)) - (a.positive_reply / Math.max(1, a.count)))
      .slice(0, 3);
    const losers = [...tally.values()].filter(r => r.rejected >= 3 && r.passed === 0)
      .sort((a, b) => b.rejected - a.rejected)
      .slice(0, 3);

    // MJ override patterns
    const overrides = recent.filter(e => e.mj_override).length;
    const overrideRate = recent.length > 0 ? Math.round(100 * overrides / recent.length) : 0;

    const lines = [`Follow-up learnings (last ${recent.length} outcomes):`];
    if (winners.length > 0) {
      lines.push('WINNING ANGLES (bias toward these when applicable):');
      winners.forEach(w => {
        const rate = Math.round(100 * w.positive_reply / w.count);
        lines.push(`  - Template #${w.template_id}: ${w.positive_reply}/${w.count} positive replies (${rate}%)`);
      });
    }
    if (losers.length > 0) {
      lines.push('LOSING ANGLES (avoid unless context dictates):');
      losers.forEach(l => {
        lines.push(`  - Template #${l.template_id}: ${l.rejected} rejections, 0 passes`);
      });
    }
    lines.push(`MJ override rate: ${overrideRate}% (${overrides}/${recent.length}). ${overrideRate > 20 ? 'Enforcer threshold may need adjustment.' : 'Calibration in band.'}`);

    return lines.join('\n');
  } catch (err) {
    logger.warn({ msg: 'summarizeFollowUpLearnings failed', err: err.message });
    return '';
  }
}

/**
 * Compute Enforcer's self-calibration recommendation.
 * Weighted signal: 30% MJ override rate (fast) + 70% reply rate (slow ground truth).
 *
 * Returns:
 *   {
 *     current_threshold_estimate: number,
 *     mj_override_rate_pct: number,
 *     reply_rate_pct: number,
 *     reply_sample_size: number,
 *     recommendation: 'increase'|'decrease'|'hold',
 *     adjustment_points: -5..+5,
 *     reasoning: string,
 *   }
 */
async function computeEnforcerCalibration(clientId) {
  try {
    const list = await getMemory(clientId, 'shared', 'followup_learnings');
    if (!Array.isArray(list) || list.length < 10) {
      return { recommendation: 'hold', reasoning: 'Insufficient data — need 10+ outcomes to calibrate.' };
    }

    // 7-day override window
    const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const window7d = list.filter(e => new Date(e.ts).getTime() > cutoff7d);
    const overrideRate = window7d.length > 0
      ? Math.round(100 * window7d.filter(e => e.mj_override).length / window7d.length)
      : 0;

    // 30-day reply window
    const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const window30d = list.filter(e => new Date(e.ts).getTime() > cutoff30d);
    const replied = window30d.filter(e => e.reply_outcome && e.reply_outcome !== 'no_reply_7d');
    const replyRate = window30d.length > 0
      ? Math.round(100 * replied.length / window30d.length)
      : null;

    // Decision matrix
    let recommendation = 'hold';
    let adjustmentPoints = 0;
    let reasoning = '';

    if (overrideRate > 30 && replyRate !== null && replyRate < 3) {
      recommendation = 'increase';
      adjustmentPoints = 5;
      reasoning = `Override rate ${overrideRate}% AND reply rate ${replyRate}% — Enforcer is too LENIENT (approving slop). Raise threshold +5.`;
    } else if (overrideRate >= 20 && overrideRate <= 30) {
      // Within auto-calibrate band
      recommendation = 'decrease';
      adjustmentPoints = -5;
      reasoning = `Override rate ${overrideRate}% in 20-30% band — MJ approving Enforcer's rejections. Loosen threshold -5.`;
    } else if (overrideRate < 20 && replyRate !== null && replyRate >= 5) {
      recommendation = 'hold';
      reasoning = `Override rate ${overrideRate}%, reply rate ${replyRate}%. Calibration in band — no change.`;
    } else if (overrideRate > 30) {
      recommendation = 'alert_mj';
      reasoning = `Override rate ${overrideRate}% >30% threshold drift requires MJ manual decision.`;
    }

    return {
      mj_override_rate_pct: overrideRate,
      reply_rate_pct: replyRate,
      reply_sample_size: window30d.length,
      override_sample_size: window7d.length,
      recommendation,
      adjustment_points: adjustmentPoints,
      reasoning,
    };
  } catch (err) {
    logger.warn({ msg: 'computeEnforcerCalibration failed', err: err.message });
    return { recommendation: 'hold', reasoning: `Error: ${err.message}` };
  }
}

// ─── Weekly review generator ───────────────────────────────────────────────

/**
 * Generates a weekly review using Haiku and writes to:
 *   1. weekly_learnings table (director_notes, best_hooks, ranger_top_rejections)
 *   2. agent_memory key `weekly_review_{weekLabel}` for in-conversation access
 *
 * Returns the brief text so callers can send it via Telegram.
 */
async function generateWeeklyReview(clientId) {
  try {
    // 1. Pull 7-day stats from DB
    const statsRes = await pool.query(
      `SELECT
         COUNT(DISTINCT m.id) FILTER (WHERE m.sent_at >= NOW() - INTERVAL '7 days') AS sent_7d,
         COUNT(DISTINCT m.id) FILTER (WHERE m.sent_at >= NOW() - INTERVAL '7 days' AND m.replied_at IS NOT NULL) AS replies_7d,
         COUNT(DISTINCT l.id) FILTER (WHERE l.created_at >= NOW() - INTERVAL '7 days') AS new_leads_7d,
         COUNT(DISTINCT l.id) FILTER (WHERE l.pipeline_stage = 'meeting_booked') AS meetings_total
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.client_id = $1`,
      [clientId]
    );
    const stats = statsRes.rows[0] || {};

    // 2. Pull enforcer rejection patterns from logs
    const rejectRes = await pool.query(
      `SELECT metadata->>'notes' AS note
         FROM logs
        WHERE client_id = $1
          AND action = 'enforcer_reject'
          AND created_at >= NOW() - INTERVAL '7 days'
        LIMIT 20`,
      [clientId]
    );
    const rejectNotes = rejectRes.rows.map(r => r.note).filter(Boolean);

    // 3. Pull campaign log from memory
    const campaignLog = await getMemory(clientId, 'director', 'campaign_log') || [];
    const recentCampaigns = campaignLog.slice(-7);

    // 4. Pull reply patterns
    const replyPatterns = await getMemory(clientId, 'sales_beaver', 'reply_patterns') || {};

    // 5. Generate with Haiku (cheap)
    const prompt = `You are Captain Beaver writing a weekly performance review. Be specific, actionable, concise.

Stats this week:
- Sent: ${stats.sent_7d || 0}
- Replies: ${stats.replies_7d || 0}
- New leads added: ${stats.new_leads_7d || 0}
- Total meetings booked: ${stats.meetings_total || 0}
- Reply rate: ${stats.sent_7d > 0 ? ((stats.replies_7d / stats.sent_7d) * 100).toFixed(1) : 0}%
- Campaigns run: ${recentCampaigns.length}
- Avg Enforcer pass rate: ${recentCampaigns.length > 0 ? Math.round(recentCampaigns.reduce((a, c) => a + (c.passRate || 0), 0) / recentCampaigns.length) : 'N/A'}%

Top Enforcer rejection reasons this week:
${rejectNotes.slice(0, 5).join('\n') || 'None logged'}

Positive reply signals:
${JSON.stringify((replyPatterns.positive || []).slice(0, 3))}

Return JSON only:
{
  "director_notes": "2-3 sentence honest assessment. What moved, what stalled, one thing to fix next week.",
  "best_hooks": ["hook 1", "hook 2"],
  "ranger_top_rejections": ["rejection reason 1", "rejection reason 2"],
  "telegram_brief": "3-5 line Telegram message for MJ. Punchy. Include reply rate and one win, one focus area."
}`;

    const raw = await callAgent('brief_writer', prompt);
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      parsed = {
        director_notes: raw.slice(0, 500),
        best_hooks: [],
        ranger_top_rejections: rejectNotes.slice(0, 3),
        telegram_brief: raw.slice(0, 300),
      };
    }

    // 6. Write to weekly_learnings table
    const weekStart = getWeekStart();
    await pool.query(
      `INSERT INTO weekly_learnings
         (client_id, week_start, director_notes, best_hooks, ranger_top_rejections,
          total_outreach, total_replies, reply_rate, total_meetings)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
       ON CONFLICT (client_id, week_start) DO UPDATE SET
         director_notes = EXCLUDED.director_notes,
         best_hooks = EXCLUDED.best_hooks,
         ranger_top_rejections = EXCLUDED.ranger_top_rejections,
         total_outreach = EXCLUDED.total_outreach,
         total_replies = EXCLUDED.total_replies,
         reply_rate = EXCLUDED.reply_rate,
         total_meetings = EXCLUDED.total_meetings,
         updated_at = NOW()`,
      [
        clientId,
        weekStart,
        parsed.director_notes || '',
        JSON.stringify(parsed.best_hooks || []),
        JSON.stringify(parsed.ranger_top_rejections || []),
        parseInt(stats.sent_7d) || 0,
        parseInt(stats.replies_7d) || 0,
        stats.sent_7d > 0 ? parseFloat(((stats.replies_7d / stats.sent_7d) * 100).toFixed(2)) : 0,
        parseInt(stats.meetings_total) || 0,
      ]
    );

    // 7. Write to agent_memory for in-conversation recall
    const weekLabel = weekStart.toISOString().slice(0, 10);
    await setMemory(clientId, 'captain', `weekly_review_${weekLabel}`, {
      ...parsed,
      stats,
      generated_at: new Date().toISOString(),
    });

    return parsed.telegram_brief || parsed.director_notes || 'Weekly review complete.';
  } catch (err) {
    logger.error({ msg: 'generateWeeklyReview failed', err: err.message });
    return null;
  }
}

// ─── Phase 2: Weekly Strategic Synthesis (Sonnet) ─────────────────────────
// Reads the shared memory pool + daily reflections + 7-day DB stats and
// produces a structured strategic directive the on-ground agents will
// follow next week. Data-gated: skips silently if the shared pool is too
// sparse to synthesize meaningfully (protects against noise strategy).
//
// Writes to shared/weekly_strategy_<weekLabel>. Cross-agent readable so
// Phase 3 (apply-to-prompts) can pick it up without coordination.

const STRATEGY_MIN_EVENTS = 5;

async function generateWeeklyStrategy(clientId) {
  try {
    // 1. Pull 7-day shared pool
    const wins     = await getMemory(clientId, 'shared', 'wins')           || [];
    const mistakes = await getMemory(clientId, 'shared', 'mistakes')       || [];
    const trend    = await getMemory(clientId, 'shared', 'campaign_trend') || [];

    const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const withinWeek = entry => {
      const ts = entry?.ts ? new Date(entry.ts).getTime() : 0;
      return ts >= weekAgoMs;
    };
    const recentWins     = wins.filter(withinWeek);
    const recentMistakes = mistakes.filter(withinWeek);
    const recentTrend    = trend.filter(withinWeek);

    // 2. Pull last 7 days of daily agent reflections (from Phase 1.5)
    const AGENTS = ['research_beaver', 'sales_beaver', 'ranger', 'captain_beaver'];
    const reflections = {};
    for (const agent of AGENTS) {
      const log = await getMemory(clientId, 'shared', `daily_${agent}_log`) || [];
      reflections[agent] = log.filter(withinWeek).slice(0, 7);
    }

    // 3. Data-sufficiency gate — protect against noise synthesis on empty pool
    const totalEvents = recentWins.length + recentMistakes.length + recentTrend.length;
    if (totalEvents < STRATEGY_MIN_EVENTS) {
      logger.info({
        msg: 'Phase 2 weekly strategy skipped — shared pool too sparse',
        total_events: totalEvents,
        threshold: STRATEGY_MIN_EVENTS,
        wins: recentWins.length,
        mistakes: recentMistakes.length,
        campaigns: recentTrend.length,
      });
      return { skipped: 'insufficient_data', total_events: totalEvents, threshold: STRATEGY_MIN_EVENTS };
    }

    // 4. Pull 7-day DB stats to ground the strategy in real outcome numbers
    const { rows: [stats] } = await pool.query(
      `SELECT
         COUNT(DISTINCT m.id) FILTER (WHERE m.sent_at >= NOW() - INTERVAL '7 days') AS sent_7d,
         COUNT(DISTINCT m.id) FILTER (WHERE m.sent_at >= NOW() - INTERVAL '7 days' AND m.replied_at IS NOT NULL) AS replies_7d,
         COUNT(DISTINCT l.id) FILTER (WHERE l.pipeline_stage = 'meeting_booked' AND l.updated_at >= NOW() - INTERVAL '7 days') AS meetings_7d
       FROM messages m
       JOIN leads l ON l.id = m.lead_id
       WHERE m.client_id = $1`,
      [clientId]
    );
    const sent    = parseInt(stats?.sent_7d    || 0, 10);
    const replies = parseInt(stats?.replies_7d || 0, 10);
    const meetings = parseInt(stats?.meetings_7d || 0, 10);
    const replyRatePct = sent > 0 ? +((replies / sent) * 100).toFixed(1) : 0;

    // 5. Build compact context for Sonnet — trim fields to what the strategist needs
    const reflectionsSummary = Object.entries(reflections)
      .map(([agent, log]) => log.length === 0
        ? null
        : `${agent}:\n${log.map(d => `  ${d.date || d.ts?.slice(0, 10)}: ${d.reflection}`).join('\n')}`)
      .filter(Boolean)
      .join('\n\n') || 'No agent reflections logged this week.';

    const prompt = `Analyse the past 7 days of outbound performance for The Dam. Produce your strategic directive for next week.

== OVERALL STATS (7 days) ==
Sent: ${sent}
Replies: ${replies}
Reply rate: ${replyRatePct}%
Meetings booked: ${meetings}
Total shared-memory events: ${totalEvents}

== WINS (${recentWins.length} positive replies) ==
${recentWins.length === 0 ? 'None.' : JSON.stringify(recentWins.slice(0, 10))}

== MISTAKES (${recentMistakes.length} Enforcer rejections) ==
${recentMistakes.length === 0 ? 'None.' : JSON.stringify(recentMistakes.slice(0, 10).map(m => ({ notes: m.notes, score: m.score, industry: m.industry, excerpt: m.excerpt?.slice(0, 120) })))}

== CAMPAIGN TREND (${recentTrend.length} runs) ==
${recentTrend.length === 0 ? 'None.' : JSON.stringify(recentTrend.slice(0, 7))}

== DAILY AGENT REFLECTIONS ==
${reflectionsSummary}

Return your directive in the exact JSON schema from your system prompt. No prose wrapper.`;

    // 6. Sonnet call — JSON output
    const raw = await callAgent('weekly_strategist', prompt, { clientId });

    // callAgent may return a parsed object or a raw string — handle both
    let parsed = null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw;
    } else if (typeof raw === 'string') {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : raw);
      } catch (err) {
        logger.warn({ msg: 'Phase 2 strategy JSON parse failed', err: err.message, raw_preview: raw.slice(0, 200) });
      }
    }

    if (!parsed || !parsed.director_notes) {
      logger.warn({ msg: 'Phase 2 strategy returned no usable output' });
      return { error: 'empty_or_invalid_output' };
    }

    // 7. Write to shared memory — cross-agent readable for Phase 3
    const weekLabel = getWeekStart().toISOString().slice(0, 10);
    const strategyRecord = {
      ts: new Date().toISOString(),
      week_label: weekLabel,
      stats: { sent_7d: sent, replies_7d: replies, reply_rate_pct: replyRatePct, meetings_7d: meetings },
      total_events: totalEvents,
      top_industries: parsed.top_industries || [],
      top_hooks: parsed.top_hooks || [],
      dead_patterns: parsed.dead_patterns || [],
      continue: parsed.continue || [],
      pivot: parsed.pivot || [],
      test: parsed.test || [],
      director_notes: parsed.director_notes || '',
      telegram_brief: parsed.telegram_brief || parsed.director_notes || '',
    };
    await setMemory(clientId, 'shared', `weekly_strategy_${weekLabel}`, strategyRecord);

    logger.info({
      msg: 'Phase 2 weekly strategy generated',
      week_label: weekLabel,
      total_events: totalEvents,
      reply_rate_pct: replyRatePct,
    });

    return strategyRecord;
  } catch (err) {
    logger.error({ msg: 'generateWeeklyStrategy failed', err: err.message, stack: err.stack });
    return { error: err.message };
  }
}

// ─── Memory context injection ──────────────────────────────────────────────

/**
 * Loads recent captain/director memories and returns a formatted string
 * for prepending to the user command in handleChat(). This gives Captain
 * Beaver persistent awareness of what's been happening without bloating
 * the conversation history.
 */
async function injectMemoryContext(clientId) {
  try {
    const lines = [];

    // Most recent weekly review
    const weekLabel = getWeekStart().toISOString().slice(0, 10);
    const weeklyReview = await getMemory(clientId, 'captain', `weekly_review_${weekLabel}`);
    if (weeklyReview?.director_notes) {
      lines.push(`[Weekly review (${weekLabel})]: ${weeklyReview.director_notes}`);
    }

    // Recent reply patterns summary
    const replyPatterns = await getMemory(clientId, 'sales_beaver', 'reply_patterns');
    if (replyPatterns?.positive?.length > 0) {
      const latest = replyPatterns.positive[0];
      lines.push(`[Latest positive signal]: ${latest.angle} angle, ${latest.industry} industry, trigger: ${latest.signal}`);
    }

    // Recent campaign log summary
    const campaignLog = await getMemory(clientId, 'director', 'campaign_log');
    if (Array.isArray(campaignLog) && campaignLog.length > 0) {
      const last = campaignLog[campaignLog.length - 1];
      lines.push(`[Last campaign]: ${last.messagesDrafted} drafted, ${last.passRate ?? '?'}% Enforcer pass rate`);
    }

    // Director mistakes to avoid
    const mistakes = await getMemory(clientId, 'director', 'mistakes');
    if (Array.isArray(mistakes) && mistakes.length > 0) {
      const latest = mistakes[0];
      lines.push(`[Avoid]: ${latest.new_rule}`);
    }

    if (lines.length === 0) return '';
    return `\n[Memory context]\n${lines.join('\n')}\n`;
  } catch (err) {
    logger.warn({ msg: 'injectMemoryContext failed', err: err.message });
    return '';
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const diff = now.getUTCDate() - day;
  const monday = new Date(now);
  monday.setUTCDate(diff + 1); // Monday
  monday.setUTCHours(0, 0, 0, 0);
  return monday;
}

/**
 * Phase 4 of rebuild plan (2026-05-12) — execution-to-sourcing feedback loop.
 *
 * postFeedbackEvent writes a row to feedback_events for any lifecycle event
 * that should inform future sourcing + drafting. Write-only foundation; the
 * consumer (weekly cron biasing Research + Sales Beaver) lands next sprint.
 *
 * Call sites:
 *   - rangerReview (agents.js)           — event_type='enforcer_rejected'
 *   - resolveApproval (approvals.js)     — event_type='manually_rejected' or 'sent'
 *   - replyHandler (replyHandler.js)     — event_type='replied'
 *   - sendQueueWorker (sendQueueWorker)  — event_type='sent' (email auto-send path)
 *
 * All writes are fire-and-forget — failures log a warning but never block the
 * caller. The table is observable but not in the critical path.
 */
async function postFeedbackEvent(clientId, event) {
  const {
    leadId = null,
    messageId = null,
    eventType,
    signalStrengthAtTime = null,
    sourceStrategy = null,
    segment = null,
    channel = null,
    touchNumber = null,
    scoreDelta = null,
    rangerScore = null,
    notes = null,
    payload = {},
  } = event;

  if (!eventType) {
    logger.warn({ msg: 'postFeedbackEvent called without eventType — skipping' });
    return;
  }

  // Enforce constraint allowlist client-side too — catches typos before SQL.
  const validTypes = new Set(['enforcer_rejected', 'manually_rejected', 'sent', 'replied', 'meeting_booked']);
  if (!validTypes.has(eventType)) {
    logger.warn({ msg: `postFeedbackEvent: invalid eventType "${eventType}"` });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO feedback_events (
         client_id, lead_id, message_id, event_type,
         signal_strength_at_time, source_strategy, segment, channel, touch_number,
         score_delta, ranger_score, notes, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        clientId,
        leadId,
        messageId,
        eventType,
        signalStrengthAtTime,
        sourceStrategy,
        segment,
        channel,
        touchNumber,
        scoreDelta,
        rangerScore,
        typeof notes === 'string' ? notes.slice(0, 500) : null,
        JSON.stringify(payload || {}),
      ]
    );
  } catch (err) {
    logger.warn({ msg: 'postFeedbackEvent write failed', eventType, err: err.message });
  }
}

module.exports = {
  getTelegramHistory,
  saveTelegramHistory,
  postSessionLearning,
  postCampaignDebrief,
  postReplyLearning,
  postRangerRejection,
  generateAgentDailySummary,
  generateWeeklyReview,
  generateWeeklyStrategy,
  injectMemoryContext,
  // Phase 4: Captain-led follow-up learning (2026-05-11)
  postFollowUpOutcome,
  recordMJOverride,
  summarizeFollowUpLearnings,
  computeEnforcerCalibration,
  setMemory,
  getMemory,
  // Phase 4 rebuild plan (2026-05-12): execution-to-sourcing feedback loop
  postFeedbackEvent,
};
