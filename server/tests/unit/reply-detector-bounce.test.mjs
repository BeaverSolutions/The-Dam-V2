import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '../../services/replyDetector.js'), 'utf-8').replace(/\r\n/g, '\n');
const hardBounceBlock = src.slice(
  src.indexOf("if (category === 'hard_bounce')"),
  src.indexOf("if (category === 'soft_bounce')")
);

describe('replyDetector hard-bounce side effects', () => {
  it('marks the outbound message failed without setting reply_detected_at', () => {
    expect(hardBounceBlock).toContain("SET status = 'failed'");
    expect(hardBounceBlock).toContain("bounce_type: 'hard_bounce'");
    const messageUpdate = hardBounceBlock.slice(
      hardBounceBlock.indexOf('`UPDATE messages'),
      hardBounceBlock.indexOf('messageId, clientId')
    );
    expect(messageUpdate).not.toContain('reply_detected_at');
  });

  it('stops the follow-up sequence on hard bounce', () => {
    expect(hardBounceBlock).toContain("sequence_status = 'completed'");
    expect(hardBounceBlock).toContain('sequence_completed_at = NOW()');
    expect(hardBounceBlock).toContain('next_followup_at = NULL');
    expect(hardBounceBlock).toContain("UPDATE followup_queue");
    expect(hardBounceBlock).toContain("SET status = 'cancelled'");
    expect(hardBounceBlock).toContain("status = 'pending'");
  });
});
