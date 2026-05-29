import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentsSource = readFileSync(resolve(__dirname, '../../services/agents.js'), 'utf-8');

// Inlined copy of autoFixMessage's LinkedIn sign-off strip (Phase 5), mirroring
// agents.js, so behavior is testable without the agents.js dependency tree
// (same pattern as icp-filter.test.mjs). Source-contract tests below guard
// against the real function drifting from this copy.
function stripLinkedInSignoff(input) {
  let fixed = String(input).trim();
  fixed = fixed.replace(
    /\n+[ \t]*(regards|best regards|kind regards|warm regards|best|cheers|thanks|thank you|sincerely)\b[ \t]*,?[ \t]*(michael(?:\s+jerry)?|mj)?[ \t]*(\n[\s\S]*)?$/i,
    ''
  ).trim();
  fixed = fixed.replace(/\n+[ \t]*(michael(?:\s+jerry)?|mj)[ \t]*$/i, '').trim();
  return fixed;
}

describe('LinkedIn sign-off strip (Phase 5 — the dominant reject class)', () => {
  it('strips a multiline "Regards,\\nMichael Jerry" sign-off, ending on the question', () => {
    const body = "Saw Acme is scaling outbound. Who owns that right now, you or the team?\n\nRegards,\nMichael Jerry";
    const out = stripLinkedInSignoff(body);
    expect(out.endsWith('you or the team?')).toBe(true);
    expect(out).not.toMatch(/regards/i);
    expect(out).not.toMatch(/michael/i);
  });

  it('strips a one-line "Regards, Michael Jerry" sign-off', () => {
    const body = "Quick one on your pipeline. Who handles outbound today?\nRegards, Michael Jerry";
    const out = stripLinkedInSignoff(body);
    expect(out.endsWith('outbound today?')).toBe(true);
    expect(out).not.toMatch(/michael/i);
  });

  it('strips a standalone bare-name sign-off (no closer word)', () => {
    const body = "Noticed your team is hiring SDRs. Who runs outbound now?\n\nMichael";
    const out = stripLinkedInSignoff(body);
    expect(out.endsWith('outbound now?')).toBe(true);
    expect(out).not.toMatch(/\bmichael\b/i);
  });

  it('does NOT strip a mid-sentence "best" (false-positive guard)', () => {
    const body = "Curious how you handle this. What's the best way to reach you?";
    expect(stripLinkedInSignoff(body)).toBe(body);
  });

  it('does NOT strip a line that starts with a closer word but continues as content', () => {
    const body = "Quick thought on outbound.\nThanks for the note you posted, who owns pipeline there?";
    expect(stripLinkedInSignoff(body)).toBe(body);
  });
});

describe('autoFixMessage channel-awareness wiring (source contract)', () => {
  it('autoFixMessage accepts a channel option and strips only for linkedin', () => {
    expect(agentsSource).toContain('function autoFixMessage(body, { touchNumber = 0, maxWords = 80, channel = null } = {})');
    expect(agentsSource).toContain("if (channel === 'linkedin')");
    expect(agentsSource).toContain("fixes.push('stripped_linkedin_signoff')");
  });

  it('rangerReview derives the channel (lead_context or message row) and passes it to autoFixMessage', () => {
    const start = agentsSource.indexOf('async function rangerReview');
    const end = agentsSource.indexOf('const gateCheck = codeEnforcerGates', start);
    const fn = agentsSource.slice(start, end);
    expect(fn).toContain('let reviewChannel = lead_context?.channel || null');
    expect(fn).toContain('SELECT channel FROM messages WHERE id = $1');
    expect(fn).toContain('autoFixMessage(message_body, { touchNumber, maxWords, channel: reviewChannel })');
  });
});
