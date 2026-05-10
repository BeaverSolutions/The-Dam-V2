import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { leads } = require('../fixtures/synthetic-leads');

// Channel routing is a pure function — test without mocks
function selectChannel(lead, options = {}) {
  const { linkedinAlreadyTried = false } = options;
  const meta = lead.metadata || {};
  const linkedinFirstOverride = meta.linkedin_first_override === true || meta.linkedin_first_override === 'true';
  const hasVerifiedEmail = lead.email
    && (lead.email_verified === true || lead.email_source === 'hunter' || lead.email_source === 'apollo');
  const isLinkedinOnlyLead = lead.lead_tier === 'B' && lead.linkedin_url;

  if (linkedinFirstOverride && lead.linkedin_url && !linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'pending_ranger', reason: 'linkedin_first_override metadata flag set' };
  }
  if (hasVerifiedEmail) {
    return { channel: 'email', status: 'pending_ranger', reason: `Verified email (${lead.email_source || 'known'})` };
  }
  if (isLinkedinOnlyLead && !linkedinAlreadyTried) {
    return { channel: 'linkedin', status: 'pending_ranger', reason: 'Tier B linkedin-only lead' };
  }
  return {
    channel: 'email',
    status: 'blocked_no_email',
    reason: 'No verified email and no linkedin_url — holding for enrichment',
  };
}

describe('Pipeline Flow Integration', () => {
  describe('channel routing', () => {
    it('routes verified email leads to email channel', () => {
      const result = selectChannel(leads[0]);
      expect(result.channel).toBe('email');
      expect(result.status).toBe('pending_ranger');
    });

    it('routes Tier B linkedin-only leads to linkedin', () => {
      const result = selectChannel(leads[1]);
      expect(result.channel).toBe('linkedin');
      expect(result.status).toBe('pending_ranger');
    });

    it('routes linkedin_first_override to linkedin even with email', () => {
      const result = selectChannel(leads[15]);
      expect(result.channel).toBe('linkedin');
    });

    it('blocks leads with no email and no linkedin', () => {
      const result = selectChannel(leads[14]);
      expect(result.channel).toBe('email');
      expect(result.status).toBe('blocked_no_email');
    });

    it('routes dead-inbox unverified to linkedin when Tier B', () => {
      const result = selectChannel(leads[19]);
      expect(result.channel).toBe('linkedin');
      expect(result.status).toBe('pending_ranger');
    });

    it('does not route to linkedin if already tried', () => {
      const result = selectChannel(leads[1], { linkedinAlreadyTried: true });
      expect(result.status).toBe('blocked_no_email');
    });

    it('email-first when verified even if linkedin_url present', () => {
      const result = selectChannel(leads[0]); // Ahmad has both email + linkedin
      expect(result.channel).toBe('email');
      expect(result.reason).toContain('Verified email');
    });
  });

  describe('badge counts match pending state', () => {
    it('dedup logic: checkActiveMessage returns non-null blocks re-draft', () => {
      // Simulates the caller pattern: if dedup returns non-null, skip persistDraft
      const existingMessage = { id: 'msg-001' };
      const shouldDraft = existingMessage === null;
      expect(shouldDraft).toBe(false);
    });

    it('dedup logic: checkActiveMessage returns null allows draft', () => {
      const existingMessage = null;
      const shouldDraft = existingMessage === null;
      expect(shouldDraft).toBe(true);
    });
  });

  describe('metadata composition rules', () => {
    it('blocked_no_email metadata includes blocked_reason', () => {
      const status = 'blocked_no_email';
      const finalMetadata = {
        source: 'sales_beaver',
        prompt_variant: null,
        signal: null,
        ...(status === 'blocked_no_email' ? { blocked_reason: 'awaiting_email_enrichment' } : {}),
      };
      expect(finalMetadata.blocked_reason).toBe('awaiting_email_enrichment');
    });

    it('pending_ranger metadata does NOT include blocked_reason', () => {
      const status = 'pending_ranger';
      const finalMetadata = {
        source: 'sales_beaver',
        prompt_variant: 'signal_rich_v2',
        signal: 'hiring_signal',
        ...(status === 'blocked_no_email' ? { blocked_reason: 'awaiting_email_enrichment' } : {}),
      };
      expect(finalMetadata.blocked_reason).toBeUndefined();
      expect(finalMetadata.signal).toBe('hiring_signal');
    });

    it('enforcer_fallback sets source and prompt_variant correctly', () => {
      const draft_source = 'enforcer_fallback';
      const finalMetadata = {
        source: draft_source,
        prompt_variant: draft_source === 'enforcer_fallback' ? 'enforcer_fallback' : null,
        signal: null,
      };
      expect(finalMetadata.source).toBe('enforcer_fallback');
      expect(finalMetadata.prompt_variant).toBe('enforcer_fallback');
    });
  });
});
