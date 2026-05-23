'use strict';

/**
 * Reply classifier — Contract 1 implementation.
 *
 * Pure module: no DB, no LLM, no network. Given an inbound message envelope,
 * returns one of six categories with the matched pattern. Deterministic regex
 * matching only; LLM disambiguation stub reserved for v2.
 *
 * Source of truth for category → action mapping:
 *   MJxClaude/memory/preferences.md 2026-05-21 "Reply pipeline — locked
 *   system contracts (two non-negotiables)".
 *
 * Caller is responsible for executing the system action (DB writes, Telegram,
 * pipeline transitions). This module classifies only.
 *
 * v1 cuts: spam category deferred (high false-positive risk, low fire rate).
 * v1 cuts: auto-reply re-check scheduling deferred (return-date parsing is
 * separate infra).
 */

const HARD_BOUNCE_FROM = /(^|<)(mailer-daemon|postmaster|noreply|no-reply|bounces?|notification|delivery)@/i;
const HARD_BOUNCE_SUBJECT = /undeliverable|delivery (status notification|failure|failed)|mail delivery failed|returned mail|address not found|mail delivery subsystem|failure notice|delivery has failed/i;
const HARD_BOUNCE_BODY = /couldn'?t be delivered|wasn'?t found at|recipient (address rejected|unknown|not found)|no such (user|mailbox)|550[ -][0-9]\.[0-9]\.[0-9]|user unknown|address (does not exist|not found|rejected)/i;

const SOFT_BOUNCE_BODY = /mailbox (full|over quota)|over quota|temporarily unavailable|try again later|4(?:21|52)[ -]/i;

const AUTO_REPLY_SUBJECT = /^(auto[- ]?reply|automatic reply|out[- ]of[- ]office|away from (office|the office)|on (vacation|leave|holiday))/i;
const AUTO_REPLY_BODY = /currently (out|away|on leave)|back on \w+|i'?m on (leave|vacation|holiday)|out of (the )?office until|auto[- ]?reply|away from my desk|limited access to email/i;

const UNSUBSCRIBE_BODY = /\bunsubscribe\b|\bremove me\b|\bstop emailing\b|\bdo not contact\b|\bopt[- ]out\b|\btake me off\b/i;

const CATEGORIES = {
  HARD_BOUNCE: 'hard_bounce',
  SOFT_BOUNCE: 'soft_bounce',
  AUTO_REPLY: 'auto_reply',
  UNSUBSCRIBE: 'unsubscribe',
  REAL_REPLY: 'real_reply',
};

/**
 * Classify an inbound message into one of five categories (spam deferred to v2).
 *
 * Priority order: hard_bounce > soft_bounce > auto_reply > unsubscribe > real_reply.
 * The order matters — an unsubscribe-style phrase inside a bounce body must
 * resolve as bounce, not unsubscribe.
 *
 * @param {object} envelope
 * @param {string} [envelope.from='']   - Full From header (e.g. "Mail Delivery Subsystem <mailer-daemon@google.com>")
 * @param {string} [envelope.subject=''] - Subject header
 * @param {string} [envelope.body='']    - Body OR snippet (snippet is fine — most bounce/OOO signals are in first ~120 chars)
 * @returns {{ category: string, reason: string, matched_pattern: string|null }}
 */
function classify({ from = '', subject = '', body = '' } = {}) {
  const f = String(from || '');
  const s = String(subject || '');
  const b = String(body || '');

  // 1. Hard bounce — From + Subject + Body each independently sufficient.
  if (HARD_BOUNCE_FROM.test(f)) {
    return { category: CATEGORIES.HARD_BOUNCE, reason: 'mailer-daemon-class sender', matched_pattern: 'from:' + (f.match(HARD_BOUNCE_FROM)?.[0] || 'mailer-daemon') };
  }
  const subjBounce = s.match(HARD_BOUNCE_SUBJECT);
  if (subjBounce) {
    return { category: CATEGORIES.HARD_BOUNCE, reason: 'NDR subject', matched_pattern: 'subject:' + subjBounce[0] };
  }
  const bodyBounce = b.match(HARD_BOUNCE_BODY);
  if (bodyBounce) {
    return { category: CATEGORIES.HARD_BOUNCE, reason: 'NDR body marker', matched_pattern: 'body:' + bodyBounce[0] };
  }

  // 2. Soft bounce — body markers only (quota / temporary unavailability).
  const soft = b.match(SOFT_BOUNCE_BODY) || s.match(SOFT_BOUNCE_BODY);
  if (soft) {
    return { category: CATEGORIES.SOFT_BOUNCE, reason: 'soft bounce marker', matched_pattern: soft[0] };
  }

  // 3. Auto-reply / OOO — subject first (cheap), then body.
  const autoSubj = s.match(AUTO_REPLY_SUBJECT);
  if (autoSubj) {
    return { category: CATEGORIES.AUTO_REPLY, reason: 'OOO subject', matched_pattern: 'subject:' + autoSubj[0] };
  }
  const autoBody = b.match(AUTO_REPLY_BODY);
  if (autoBody) {
    return { category: CATEGORIES.AUTO_REPLY, reason: 'OOO body marker', matched_pattern: 'body:' + autoBody[0] };
  }

  // 4. Unsubscribe — only after bounce/OOO ruled out (a bounce body that
  // happens to contain "unsubscribe" boilerplate must still resolve as bounce).
  const unsub = b.match(UNSUBSCRIBE_BODY) || s.match(UNSUBSCRIBE_BODY);
  if (unsub) {
    return { category: CATEGORIES.UNSUBSCRIBE, reason: 'opt-out request', matched_pattern: unsub[0] };
  }

  // 5. Real reply — default. Caller proceeds to existing reply_detected_at +
  // sentiment classification + handleReply flow.
  return { category: CATEGORIES.REAL_REPLY, reason: 'no system pattern matched', matched_pattern: null };
}

module.exports = { classify, CATEGORIES };
