import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '../../services/replyDetector.js'), 'utf-8').replace(/\r\n/g, '\n');

describe('replyDetector inbound vendor pitch branch', () => {
  it('routes spam:vendor_cold_pitch to inboundPitchProspecting without reply side effects', () => {
    expect(src).toContain("require('./inboundPitchProspecting')");
    expect(src).toContain("subcategory === 'vendor_cold_pitch'");
    expect(src).toContain('captureVendorColdPitch(clientId');

    const branchStart = src.indexOf("subcategory === 'vendor_cold_pitch'");
    const branchEnd = src.indexOf("if (category === 'hard_bounce')", branchStart);
    const branch = src.slice(branchStart, branchEnd);

    expect(branch).toContain("is_spam: true");
    expect(branch).not.toContain('reply_detected_at');
    expect(branch).not.toContain('handleReply');
    expect(branch).not.toContain('sendMessage');
  });
});
