import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { classify, CATEGORIES } = require('../../services/replyClassifier.js');

describe('replyClassifier.classify — category detection', () => {
  describe('hard_bounce', () => {
    it('classifies mailer-daemon From header as hard_bounce', () => {
      const r = classify({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', subject: '', body: '' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
      expect(r.matched_pattern).toMatch(/from:/);
    });

    it('classifies postmaster@ as hard_bounce', () => {
      const r = classify({ from: 'postmaster@mx.example.com', subject: '', body: '' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });

    it('classifies NDR subject as hard_bounce independent of From', () => {
      const r = classify({ from: 'legit@example.com', subject: 'Undeliverable: Your message to Ahmad', body: '' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
      expect(r.matched_pattern).toMatch(/subject:/);
    });

    it('classifies delivery failure subject as hard_bounce', () => {
      const r = classify({ from: 'legit@example.com', subject: 'Delivery Status Notification (Failure)', body: '' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });

    it('classifies NDR body marker as hard_bounce', () => {
      const r = classify({ from: 'legit@example.com', subject: 'Re: your message', body: "The recipient address rejected your message. 550 5.1.1 user unknown." });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
      expect(r.matched_pattern).toMatch(/body:/);
    });

    it('classifies 550-level bounce code in body', () => {
      const r = classify({ from: 'relay@example.com', subject: 'Returned mail', body: '550 5.1.0 Address rejected.' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });

    it('classifies "mailbox not found" body as hard_bounce', () => {
      const r = classify({ from: 'noreply@mx.host.com', subject: '', body: 'No such user ahmad.razak@company.my' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });
  });

  describe('soft_bounce', () => {
    it('classifies mailbox full body as soft_bounce', () => {
      const r = classify({ from: 'server@example.com', subject: '', body: 'Mailbox full. Please try again later.' });
      expect(r.category).toBe(CATEGORIES.SOFT_BOUNCE);
    });

    it('classifies over quota body as soft_bounce', () => {
      const r = classify({ from: 'server@example.com', subject: '', body: 'User is over quota.' });
      expect(r.category).toBe(CATEGORIES.SOFT_BOUNCE);
    });

    it('classifies 452 SMTP code in body as soft_bounce', () => {
      const r = classify({ from: 'server@example.com', subject: '', body: '452 4.2.2 Mailbox full.' });
      expect(r.category).toBe(CATEGORIES.SOFT_BOUNCE);
    });

    it('does NOT classify soft bounce when also matching hard_bounce From', () => {
      // hard_bounce From wins over soft_bounce body
      const r = classify({ from: 'mailer-daemon@google.com', subject: '', body: 'Mailbox full.' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });
  });

  describe('auto_reply', () => {
    it('classifies OOO subject as auto_reply', () => {
      const r = classify({ from: 'ahmad@company.com', subject: 'Out of Office: Re: Quick question', body: '' });
      expect(r.category).toBe(CATEGORIES.AUTO_REPLY);
      expect(r.matched_pattern).toMatch(/subject:/);
    });

    it('classifies automatic reply subject as auto_reply', () => {
      const r = classify({ from: 'ahmad@company.com', subject: 'Automatic Reply: Re: your outreach', body: '' });
      expect(r.category).toBe(CATEGORIES.AUTO_REPLY);
    });

    it('classifies OOO body marker as auto_reply when subject is clean', () => {
      const r = classify({ from: 'ahmad@company.com', subject: 'Re: Quick question', body: 'I am currently out of office until June 10.' });
      expect(r.category).toBe(CATEGORIES.AUTO_REPLY);
      expect(r.matched_pattern).toMatch(/body:/);
    });

    it('classifies limited email access body as auto_reply', () => {
      const r = classify({ from: 'ahmad@company.com', subject: 'Re: note', body: 'I have limited access to email this week.' });
      expect(r.category).toBe(CATEGORIES.AUTO_REPLY);
    });

    it('does NOT classify soft_bounce body as auto_reply', () => {
      const r = classify({ from: 'server@example.com', subject: '', body: 'Mailbox full. Try again later.' });
      expect(r.category).toBe(CATEGORIES.SOFT_BOUNCE);
    });
  });

  describe('unsubscribe', () => {
    it('classifies "unsubscribe" body as unsubscribe', () => {
      const r = classify({ from: 'ahmad@company.com', subject: 'Re: your note', body: 'Please unsubscribe me from your list.' });
      expect(r.category).toBe(CATEGORIES.UNSUBSCRIBE);
    });

    it('classifies "remove me" as unsubscribe', () => {
      const r = classify({ from: 'ahmad@company.com', subject: '', body: 'Remove me from this list.' });
      expect(r.category).toBe(CATEGORIES.UNSUBSCRIBE);
    });

    it('classifies "opt-out" as unsubscribe', () => {
      const r = classify({ from: 'ahmad@company.com', subject: '', body: 'Please opt-out my email.' });
      expect(r.category).toBe(CATEGORIES.UNSUBSCRIBE);
    });

    it('classifies "do not contact" as unsubscribe', () => {
      const r = classify({ from: 'ahmad@company.com', subject: '', body: 'Do not contact me again.' });
      expect(r.category).toBe(CATEGORIES.UNSUBSCRIBE);
    });

    it('classifies "stop emailing" as unsubscribe', () => {
      const r = classify({ from: 'ahmad@company.com', subject: '', body: 'Please stop emailing me.' });
      expect(r.category).toBe(CATEGORIES.UNSUBSCRIBE);
    });

    it('does NOT classify as unsubscribe when hard_bounce From matches (priority order)', () => {
      // An NDR body might contain unsubscribe boilerplate — hard_bounce wins
      const r = classify({ from: 'mailer-daemon@google.com', subject: '', body: 'Unsubscribe from notifications below.' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });

    it('does NOT classify as unsubscribe when NDR body pattern also matches (hard_bounce body wins)', () => {
      const r = classify({ from: 'noreply@host.com', subject: '', body: 'User unknown. To unsubscribe see footer.' });
      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });
  });

  describe('spam / vendor_cold_pitch', () => {
    it('classifies unsolicited B2B vendor pitches as spam:vendor_cold_pitch', () => {
      const r = classify({
        from: 'Samantha Lee <samantha@growthpilot.my>',
        subject: 'Helping training firms book more meetings',
        body: 'I help B2B companies with outbound lead generation and appointment setting. Would you be open to a quick call next week?',
      });

      expect(r.category).toBe(CATEGORIES.SPAM);
      expect(r.subcategory).toBe('vendor_cold_pitch');
      expect(r.sender_domain).toBe('growthpilot.my');
    });

    it('does not let vendor-pitch wording override bounce priority', () => {
      const r = classify({
        from: 'mailer-daemon@google.com',
        subject: 'Undeliverable: Helping training firms book more meetings',
        body: 'Would you be open to a quick call? 550 5.1.1 user unknown.',
      });

      expect(r.category).toBe(CATEGORIES.HARD_BOUNCE);
    });

    it('does not classify freemail vendor-looking text as vendor_cold_pitch', () => {
      const r = classify({
        from: 'random sender <pitcher@gmail.com>',
        subject: 'Quick collaboration',
        body: 'We help companies with lead generation. Would you be open to a call?',
      });

      expect(r.category).toBe(CATEGORIES.REAL_REPLY);
    });
  });

  describe('real_reply (default)', () => {
    it('classifies a genuine prospect reply as real_reply', () => {
      const r = classify({ from: 'jacob@tincityimpact.com', subject: 'Re: Quick question', body: 'Hey, sounds interesting. Tell me more.' });
      expect(r.category).toBe(CATEGORIES.REAL_REPLY);
      expect(r.matched_pattern).toBeNull();
    });

    it('classifies a short positive reply as real_reply', () => {
      const r = classify({ from: 'ceo@startup.io', subject: '', body: 'Yes, happy to chat.' });
      expect(r.category).toBe(CATEGORIES.REAL_REPLY);
    });

    it('classifies a neutral/asking reply as real_reply', () => {
      const r = classify({ from: 'founder@acme.co', subject: '', body: 'What does this cost?' });
      expect(r.category).toBe(CATEGORIES.REAL_REPLY);
    });
  });

  describe('edge cases — malformed / empty inputs', () => {
    it('empty envelope defaults to real_reply', () => {
      const r = classify({});
      expect(r.category).toBe(CATEGORIES.REAL_REPLY);
    });

    it('null values coerce without throwing', () => {
      expect(() => classify({ from: null, subject: null, body: null })).not.toThrow();
      const r = classify({ from: null, subject: null, body: null });
      expect(r.category).toBe(CATEGORIES.REAL_REPLY);
    });

    it('undefined envelope does not throw', () => {
      expect(() => classify()).not.toThrow();
      const r = classify();
      expect(r.category).toBe(CATEGORIES.REAL_REPLY);
    });

    it('numeric from/subject/body coerce to string without throwing', () => {
      expect(() => classify({ from: 42, subject: 0, body: false })).not.toThrow();
    });
  });

  describe('CATEGORIES export', () => {
    it('exports the six expected category constants', () => {
      expect(CATEGORIES.HARD_BOUNCE).toBe('hard_bounce');
      expect(CATEGORIES.SOFT_BOUNCE).toBe('soft_bounce');
      expect(CATEGORIES.AUTO_REPLY).toBe('auto_reply');
      expect(CATEGORIES.UNSUBSCRIBE).toBe('unsubscribe');
      expect(CATEGORIES.SPAM).toBe('spam');
      expect(CATEGORIES.REAL_REPLY).toBe('real_reply');
    });
  });
});
