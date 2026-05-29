import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { gatePendingMessage } = require('../../services/autoApprovalRecovery.js');

const baseRow = {
  ranger_score: 85,
  auto_approve_threshold: 80,
  client_is_seasoned: true,
  recent_sent_count: 0,
  audit_gate_fail: null,
  channel: 'email',
  lead_email: 'founder@example.com',
  email_verified: true,
  email_source: 'vibe_csv',
};

describe('auto approval recovery gates', () => {
  it('passes a seasoned high-score verified email with no recent send', async () => {
    const prior = process.env.AUTO_APPROVE_ENABLED;
    process.env.AUTO_APPROVE_ENABLED = 'true';
    try {
      await expect(gatePendingMessage(baseRow)).resolves.toEqual({ pass: true, reason: null });
    } finally {
      if (prior === undefined) delete process.env.AUTO_APPROVE_ENABLED;
      else process.env.AUTO_APPROVE_ENABLED = prior;
    }
  });

  it('requires AUTO_APPROVE_ENABLED to be explicitly true', async () => {
    const prior = process.env.AUTO_APPROVE_ENABLED;
    delete process.env.AUTO_APPROVE_ENABLED;
    try {
      await expect(gatePendingMessage(baseRow)).resolves.toEqual({
        pass: false,
        reason: 'AUTO_APPROVE_ENABLED not true (manual approval required)',
      });
    } finally {
      if (prior === undefined) delete process.env.AUTO_APPROVE_ENABLED;
      else process.env.AUTO_APPROVE_ENABLED = prior;
    }
  });

  it('blocks below-threshold and fresh-client messages', async () => {
    const prior = process.env.AUTO_APPROVE_ENABLED;
    process.env.AUTO_APPROVE_ENABLED = 'true';
    try {
      await expect(gatePendingMessage({ ...baseRow, ranger_score: 79 })).resolves.toMatchObject({ pass: false, reason: 'below_auto_approve_threshold' });
      await expect(gatePendingMessage({ ...baseRow, client_is_seasoned: false })).resolves.toMatchObject({ pass: false, reason: 'client onboarded <7 days ago' });
    } finally {
      if (prior === undefined) delete process.env.AUTO_APPROVE_ENABLED;
      else process.env.AUTO_APPROVE_ENABLED = prior;
    }
  });

  it('blocks duplicate, gate-failed, unsupported, and unverified email sends', async () => {
    const prior = process.env.AUTO_APPROVE_ENABLED;
    process.env.AUTO_APPROVE_ENABLED = 'true';
    try {
      await expect(gatePendingMessage({ ...baseRow, recent_sent_count: 1 })).resolves.toMatchObject({ pass: false });
      await expect(gatePendingMessage({ ...baseRow, audit_gate_fail: 'manual gate' })).resolves.toMatchObject({ pass: false, reason: 'manual gate' });
      await expect(gatePendingMessage({ ...baseRow, channel: 'sms' })).resolves.toMatchObject({ pass: false, reason: 'unsupported channel: sms' });
      await expect(gatePendingMessage({ ...baseRow, email_verified: false, email_source: null })).resolves.toMatchObject({ pass: false, reason: 'email channel without verified email' });
    } finally {
      if (prior === undefined) delete process.env.AUTO_APPROVE_ENABLED;
      else process.env.AUTO_APPROVE_ENABLED = prior;
    }
  });

  it('allows LinkedIn recovery without email but still through manual requested state', async () => {
    const prior = process.env.AUTO_APPROVE_ENABLED;
    process.env.AUTO_APPROVE_ENABLED = 'true';
    try {
      await expect(gatePendingMessage({ ...baseRow, channel: 'linkedin', lead_email: null, email_verified: false, email_source: null })).resolves.toEqual({ pass: true, reason: null });
    } finally {
      if (prior === undefined) delete process.env.AUTO_APPROVE_ENABLED;
      else process.env.AUTO_APPROVE_ENABLED = prior;
    }
  });
});
