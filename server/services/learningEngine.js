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
//   shared/wins           — positive replies with hook + industry + signal
//   shared/mistakes       — Enforcer rejections with reason + score + excerpt
//   shared/campaign_trend — per-campaign metrics + pass/reply rates

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

module.exports = {
  getTelegramHistory,
  saveTelegramHistory,
  postSessionLearning,
  postCampaignDebrief,
  postReplyLearning,
  postRangerRejection,
  generateWeeklyReview,
  injectMemoryContext,
};
