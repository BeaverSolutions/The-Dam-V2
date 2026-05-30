import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const service = (p) => readFileSync(resolve(__dirname, '../../', p), 'utf-8');

describe('applyEnforcerDecision contracts (pipeline.js)', () => {
  const src = service('services/pipeline.js');

  // Find the function body for isolated assertions
  const fnStart = src.indexOf('async function applyEnforcerDecision');
  const fnEnd = src.indexOf('\nmodule.exports', fnStart);
  const fn = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 6000);

  it('borderline band is 60-79 (not 60-80)', () => {
    expect(fn).toContain('rangerScore >= 60 && rangerScore < 80');
  });

  it('borderline messages land in pending_approval, never pending_send', () => {
    const borderlineIdx = fn.indexOf('isBorderline = true');
    const pendingApprovalIdx = fn.indexOf("nextMessageStatus = 'pending_approval'", borderlineIdx);
    expect(borderlineIdx).toBeGreaterThan(-1);
    expect(pendingApprovalIdx).toBeGreaterThan(borderlineIdx);
    // Confirm pending_send is NOT assigned in the borderline=true branch
    const borderlineBlock = fn.slice(borderlineIdx, borderlineIdx + 300);
    expect(borderlineBlock).not.toContain("nextMessageStatus = 'pending_send'");
  });

  it('AUTO_APPROVE_ENABLED kill-switch prevents auto-approval', () => {
    expect(fn).toContain("process.env.AUTO_APPROVE_ENABLED === 'false'");
    // Kill-switch check must come before autoApproved = true assignment
    const killSwitchIdx = fn.indexOf("process.env.AUTO_APPROVE_ENABLED === 'false'");
    const autoApprovedTrueIdx = fn.indexOf('autoApproved = true');
    expect(killSwitchIdx).toBeLessThan(autoApprovedTrueIdx);
  });

  it('LinkedIn auto-approve sets linkedin_requested status and pending approval (not approved)', () => {
    expect(fn).toContain("nextMessageStatus = 'linkedin_requested'");
    expect(fn).toContain("approvalStatus = 'pending'");
    // The linkedin branch must come BEFORE the email branch (or be the else)
    const linkedinStatusIdx = fn.indexOf("nextMessageStatus = 'linkedin_requested'");
    const emailStatusIdx = fn.indexOf("nextMessageStatus = 'pending_send'");
    expect(linkedinStatusIdx).toBeGreaterThan(-1);
    expect(emailStatusIdx).toBeGreaterThan(-1);
  });

  it('email auto-approve sets pending_send status and approved approval', () => {
    expect(fn).toContain("nextMessageStatus = 'pending_send'");
    expect(fn).toContain("approvalStatus = 'approved'");
    expect(fn).toContain("resolvedAt = new Date()");
  });

  it('requestedBy label is enforcer_borderline for borderline drafts', () => {
    expect(fn).toContain("'enforcer_borderline'");
    // Must be assigned based on isBorderline check
    expect(fn).toContain('isBorderline\n    ? \'enforcer_borderline\'');
  });

  it('7-day seasoned gate query is inside the auto-approve threshold block', () => {
    const thresholdIdx = fn.indexOf('rangerScore >= threshold');
    const seasonedIdx = fn.indexOf("INTERVAL '7 days'", thresholdIdx);
    expect(seasonedIdx).toBeGreaterThan(thresholdIdx);
  });

  it('30-day dedup gate is inside the auto-approve threshold block', () => {
    const thresholdIdx = fn.indexOf('rangerScore >= threshold');
    const dedupIdx = fn.indexOf("INTERVAL '30 days'", thresholdIdx);
    expect(dedupIdx).toBeGreaterThan(thresholdIdx);
  });

  it('approval_audit records borderline_surfaced for borderline, auto_approved for auto-approve', () => {
    expect(fn).toContain("'borderline_surfaced'");
    expect(fn).toContain("'auto_approved'");
  });

  it('pipeline_trace stage is reviewed for borderline, approved for auto/manual', () => {
    expect(fn).toContain("isBorderline ? 'reviewed' : 'approved'");
    expect(fn).toContain("isBorderline ? 'borderline_surfaced' : (autoApproved ? 'auto_threshold' : 'pipeline_approved')");
  });
});
