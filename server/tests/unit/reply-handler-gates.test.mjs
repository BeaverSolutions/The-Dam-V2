import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '../../services/replyHandler.js'), 'utf-8');

// Inline the deterministic reply-draft gate logic from replyHandler.js (lines 363-370).
// Same pattern as enforcer-gates.test.mjs — inline copy so tests never touch real network.
function replyDraftGates(body) {
  const gateFailures = [];
  if (/—/.test(body)) gateFailures.push('Em dash (—) found');
  if (/^[\s\t]*[-*•]/m.test(body)) gateFailures.push('Bullet points found');
  const questionCount = (body.match(/\?/g) || []).length;
  if (questionCount > 2) gateFailures.push(`${questionCount} questions (max 2 for replies)`);
  const gatesPassed = gateFailures.length === 0;
  return { gatesPassed, gateFailures };
}

describe('reply-draft server-side hard gates (inline copy from replyHandler.js)', () => {
  describe('em dash gate', () => {
    it('fails body containing em dash (U+2014)', () => {
      const { gatesPassed, gateFailures } = replyDraftGates('Thanks for reaching out — sounds good.');
      expect(gatesPassed).toBe(false);
      expect(gateFailures[0]).toMatch(/Em dash/);
    });

    it('passes body with regular hyphen', () => {
      const { gatesPassed } = replyDraftGates('Our AI-powered tool drafts follow-ups automatically.');
      expect(gatesPassed).toBe(true);
    });
  });

  describe('bullet gate', () => {
    it('fails body with bullet point (•)', () => {
      const { gatesPassed } = replyDraftGates('Here are the key points:\n• First point\n• Second point');
      expect(gatesPassed).toBe(false);
    });

    it('fails body with dash-style bullet at line start', () => {
      const { gatesPassed } = replyDraftGates('Thoughts:\n- Option A\n- Option B');
      expect(gatesPassed).toBe(false);
    });

    it('fails body with asterisk bullet', () => {
      const { gatesPassed } = replyDraftGates('Consider:\n* Item one\n* Item two');
      expect(gatesPassed).toBe(false);
    });

    it('passes dash mid-sentence (not a bullet)', () => {
      // dash NOT at line start — should not trigger
      const { gatesPassed } = replyDraftGates('Happy to connect - what works for you?');
      expect(gatesPassed).toBe(true);
    });
  });

  describe('question count gate (replies allow up to 2)', () => {
    it('passes 0 questions', () => {
      const { gatesPassed } = replyDraftGates('Happy to jump on a call.');
      expect(gatesPassed).toBe(true);
    });

    it('passes 1 question', () => {
      const { gatesPassed } = replyDraftGates('Would Tuesday 3pm MYT work for you?');
      expect(gatesPassed).toBe(true);
    });

    it('passes exactly 2 questions (replies get more latitude than cold)', () => {
      const { gatesPassed } = replyDraftGates('Does 2pm work? Or would you prefer Thursday?');
      expect(gatesPassed).toBe(true);
    });

    it('fails 3+ questions', () => {
      const { gatesPassed, gateFailures } = replyDraftGates('Does 2pm work? Or Thursday? What about Friday?');
      expect(gatesPassed).toBe(false);
      expect(gateFailures[0]).toContain('max 2 for replies');
    });
  });

  describe('word count NOT enforced for replies', () => {
    it('passes a long reply draft (>80 words)', () => {
      const longBody = 'Thanks for your reply. ' + 'This is a reply response that goes well beyond eighty words and that is fine because replies are not cold outreach and the gates are intentionally different. '.repeat(3);
      const { gatesPassed } = replyDraftGates(longBody);
      expect(gatesPassed).toBe(true);
    });
  });

  describe('multiple gate failures accumulate', () => {
    it('reports all failures when em dash AND bullets present', () => {
      const { gatesPassed, gateFailures } = replyDraftGates('Key thoughts — as follows:\n• Point one\n• Point two');
      expect(gatesPassed).toBe(false);
      expect(gateFailures.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('replyHandler source contracts — gate wiring', () => {
  it('gates-passed draft is inserted with status pending_approval', () => {
    expect(src).toContain("gatesPassed ? 'pending_approval' : 'ranger_rejected'");
  });

  it('gates-passed draft is inserted with hardcoded ranger_score=90', () => {
    expect(src).toContain("gatesPassed ? 90 : 0");
  });

  it('gates-passed draft is pushed to approvals with requested_by=director', () => {
    const approvalInsert = src.indexOf("INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'director')");
    expect(approvalInsert).toBeGreaterThanOrEqual(0);
  });

  it('word count is NOT in gateFailures (replies skip word count)', () => {
    // The cold-path enforcer has a word count check. Verify reply gate block does NOT.
    const gateBlock = src.slice(src.indexOf('gateFailures'), src.indexOf('const gatesPassed'));
    expect(gateBlock).not.toContain('wordCount');
    expect(gateBlock).not.toContain('word count');
  });

  it('em dash check uses U+2014 literal in gate block', () => {
    expect(src).toContain("if (/—/.test(draft.body)) gateFailures.push('Em dash (—) found')");
  });

  it('question cap is 2 for replies (not 1 as in cold outreach)', () => {
    expect(src).toContain('max 2 for replies');
  });

  it('is_reply metadata flag is written on INSERT', () => {
    expect(src).toContain('is_reply: true');
  });

  it('reply_to_message_id is stored in message metadata (audit trail)', () => {
    expect(src).toContain('reply_to_message_id: messageId');
  });
});

describe('replyHandler source contracts — failure observability (P0.5, 2026-05-22)', () => {
  it('exports handleReply only (no internal leakage)', () => {
    expect(src).toContain("module.exports = { handleReply }");
  });

  it('recordFailure writes reply_handler_failure to logs (DB audit trail)', () => {
    expect(src).toContain("action: 'reply_handler_failure'");
  });

  it('recordFailure queues Telegram batch (pendingFailures push)', () => {
    expect(src).toContain('pendingFailures.push(');
    expect(src).toContain('scheduleFailureFlush()');
  });

  it('Telegram batch uses 5s debounce (collapses per-tick failures)', () => {
    expect(src).toContain('setTimeout(flushFailureBatch, 5000)');
  });

  it('callAgent module-load failure calls recordFailure with reason=claude_module_unloaded', () => {
    expect(src).toContain("reason: 'claude_module_unloaded'");
  });

  it('lead_not_found calls recordFailure', () => {
    expect(src).toContain("reason: 'lead_not_found'");
  });

  it('classification_call_threw calls recordFailure', () => {
    expect(src).toContain("reason: 'classification_call_threw'");
  });

  it('classification_returned_null calls recordFailure', () => {
    expect(src).toContain("reason: 'classification_returned_null'");
  });

  it('sales_beaver_no_draft calls recordFailure', () => {
    expect(src).toContain("reason: 'sales_beaver_no_draft'");
  });

  it('outer catch calls recordFailure with reason=unexpected_exception', () => {
    expect(src).toContain("reason: 'unexpected_exception'");
  });

  it('all five early-return paths call recordFailure before returning', () => {
    // Count recordFailure calls — must be at least 5 (one per early exit site)
    const matches = src.match(/await recordFailure\(/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('does NOT call LLM Enforcer (rangerReview) on reply drafts', () => {
    // Reply drafts use server-side gates only — no rangerReview call in handleReply
    const handleReplyBody = src.slice(src.indexOf('async function handleReply'), src.indexOf('module.exports'));
    expect(handleReplyBody).not.toContain('rangerReview');
  });

  it('follow-up sequence is stopped on ANY reply sentiment (not just positive)', () => {
    expect(src).toContain("sequence_status = 'replied'");
    expect(src).toContain("status = 'cancelled'");
    // Both in same handleReply body, before the no_fit branch
    const stopIdx = src.indexOf("sequence_status = 'replied'");
    const noFitIdx = src.indexOf("sentiment === 'no_fit'");
    expect(stopIdx).toBeLessThan(noFitIdx);
  });
});
