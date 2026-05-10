// Inline autoFixMessage logic from agents.js for isolated testing
function stripEmDashes(text) {
  return text.replace(/\s*[—–]\s*/g, ', ');
}

function autoFixMessage(body, { touchNumber = 0, maxWords = 80 } = {}) {
  if (!body || typeof body !== 'string') {
    return { body: body || '', fixes: [], fatal: 'empty_body' };
  }

  const fixes = [];
  let fixed = body;

  if (/[—–]/.test(fixed)) {
    fixed = stripEmDashes(fixed);
    fixes.push('stripped_em_dashes');
  }

  if (/^\s*[•\-\*]\s/m.test(fixed)) {
    fixed = fixed.replace(/^\s*[•\-\*]\s+/gm, '').replace(/\n{2,}/g, '\n\n');
    fixes.push('removed_bullets');
  }

  if (/^\s*\d+[\.\)]\s/m.test(fixed)) {
    fixed = fixed.replace(/^\s*\d+[\.\)]\s+/gm, '');
    fixes.push('removed_numbered_list');
  }

  fixed = fixed.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (touchNumber === 0) {
    const softCtas = [
      /\bworth a quick chat\b[^.?!]*/gi,
      /\bhappy to jump on\b[^.?!]*/gi,
      /\bwould love to connect\b[^.?!]*/gi,
      /\bkeen to connect\b[^.?!]*/gi,
      /\blet me know if you'?re open to\b[^.?!]*/gi,
      /\bopen to a quick\b[^.?!]*/gi,
    ];
    let stripped = false;
    for (const pattern of softCtas) {
      if (pattern.test(fixed)) {
        fixed = fixed.replace(pattern, '').replace(/\s+([.?!])/g, '$1').replace(/\s{2,}/g, ' ').trim();
        stripped = true;
      }
    }
    if (stripped) fixes.push('stripped_soft_cta');
  }

  const bannedLowerList = [
    'cutting-edge', 'paradigm shift', 'seamless', 'leverage', 'synergy',
    'game-changer', 'innovative', 'revolutionary', 'transformative', 'delve',
    'i hope this email finds you well', 'i wanted to reach out', 'unlock',
    'unleash', 'empower', 'elevate', 'streamline', 'actionable insights',
    'thought leader', 'disruptive', 'data-driven', 'circle back', 'touch base',
    'move the needle', 'best-in-class',
  ];
  let bannedHit = false;
  for (const phrase of bannedLowerList) {
    const re = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'gi');
    if (re.test(fixed)) {
      fixed = fixed.replace(re, '');
      bannedHit = true;
    }
  }
  if (bannedHit) {
    fixed = fixed.replace(/\s{2,}/g, ' ').replace(/\s+([.?!,])/g, '$1').trim();
    fixes.push('stripped_banned_phrases');
  }

  if (/\?{2,}/.test(fixed)) {
    fixed = fixed.replace(/\?{2,}/g, '?');
    fixes.push('collapsed_question_marks');
  }

  const questionMatches = fixed.match(/\?/g) || [];
  if (questionMatches.length > 1) {
    const sentences = fixed.split(/(?<=[.?!])\s+/);
    let lastQuestionIdx = -1;
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (sentences[i].includes('?')) { lastQuestionIdx = i; break; }
    }
    for (let i = 0; i < sentences.length; i++) {
      if (i !== lastQuestionIdx && sentences[i].includes('?')) {
        sentences[i] = sentences[i].replace(/\?/g, '.');
      }
    }
    fixed = sentences.join(' ');
    fixes.push('reduced_to_one_question');
  }

  const bodyOnly = fixed
    .replace(/^Hi\s+[\w\s]{1,40}?,\s*/i, '')
    .replace(/\s*Regards,?\s*[\s\S]*$/i, '')
    .replace(/\s*Best,?\s*[\s\S]*$/i, '')
    .replace(/\s*Cheers,?\s*[\s\S]*$/i, '')
    .trim();
  const words = bodyOnly.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    const sentences = bodyOnly.split(/(?<=[.?!])\s+/).filter(Boolean);
    if (sentences.length >= 3) {
      const questionSentIdx = sentences.findIndex(s => s.includes('?'));
      const closing = questionSentIdx >= 0 ? sentences[questionSentIdx] : sentences[sentences.length - 1];
      let trimmed = [sentences[0], sentences[1], closing].join(' ');
      const trimmedWords = trimmed.split(/\s+/).filter(Boolean);
      if (trimmedWords.length > maxWords) {
        trimmed = trimmedWords.slice(0, maxWords).join(' ');
      }
      const greetingMatch = fixed.match(/^Hi\s+[\w\s]{1,40}?,/i);
      const signoffMatch = fixed.match(/(Regards|Best|Cheers),?\s*[\s\S]*$/i);
      fixed = [
        greetingMatch ? greetingMatch[0] : 'Hi,',
        '',
        trimmed,
        '',
        signoffMatch ? signoffMatch[0] : 'Regards,',
      ].join('\n');
      fixes.push(`trimmed_from_${words.length}_to_${trimmed.split(/\s+/).length}_words`);
    }
  }

  fixed = fixed.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

  return { body: fixed, fixes, fatal: null };
}

describe('autoFixMessage', () => {
  describe('em dash removal', () => {
    it('replaces em dash with comma', () => {
      const { body, fixes } = autoFixMessage('Great work — really impressive.');
      expect(body).not.toContain('—');
      expect(body).toContain(',');
      expect(fixes).toContain('stripped_em_dashes');
    });

    it('replaces en dash with comma', () => {
      const { body, fixes } = autoFixMessage('Pages 1–5 are key.');
      expect(body).not.toContain('–');
      expect(fixes).toContain('stripped_em_dashes');
    });
  });

  describe('bullet removal', () => {
    it('removes bullet markers', () => {
      const { body, fixes } = autoFixMessage('Benefits:\n• Fast\n• Easy\n• Cheap');
      expect(body).not.toContain('•');
      expect(fixes).toContain('removed_bullets');
    });

    it('removes dash-style bullets', () => {
      const { body, fixes } = autoFixMessage('Here:\n- First\n- Second');
      expect(body).not.toContain('\n- ');
      expect(fixes).toContain('removed_bullets');
    });
  });

  describe('numbered list removal', () => {
    it('strips numbered prefixes', () => {
      const { body, fixes } = autoFixMessage('Steps:\n1. First\n2. Second\n3. Third');
      expect(body).not.toMatch(/^\d+\./m);
      expect(fixes).toContain('removed_numbered_list');
    });
  });

  describe('soft CTA stripping (Day 0 only)', () => {
    it('strips "would love to connect" on Day 0', () => {
      const { body, fixes } = autoFixMessage('Hi Ahmad,\n\nWould love to connect about your work.', { touchNumber: 0 });
      expect(body.toLowerCase()).not.toContain('would love to connect');
      expect(fixes).toContain('stripped_soft_cta');
    });

    it('keeps soft CTA on follow-up (touch 2+)', () => {
      const { body, fixes } = autoFixMessage('Would love to connect about your work.', { touchNumber: 2 });
      expect(body.toLowerCase()).toContain('would love to connect');
      expect(fixes).not.toContain('stripped_soft_cta');
    });
  });

  describe('banned phrase stripping', () => {
    it('removes single banned phrase', () => {
      const { body, fixes } = autoFixMessage('Our cutting-edge platform helps teams.');
      expect(body.toLowerCase()).not.toContain('cutting-edge');
      expect(fixes).toContain('stripped_banned_phrases');
    });

    it('removes multiple banned phrases', () => {
      const { body, fixes } = autoFixMessage('We leverage synergy to streamline workflows.');
      expect(body.toLowerCase()).not.toContain('leverage');
      expect(body.toLowerCase()).not.toContain('synergy');
      expect(body.toLowerCase()).not.toContain('streamline');
      expect(fixes).toContain('stripped_banned_phrases');
    });
  });

  describe('question collapse', () => {
    it('collapses multiple ?? to single ?', () => {
      const { body, fixes } = autoFixMessage('Really?? Are you sure??');
      expect(body).not.toMatch(/\?{2,}/);
      expect(fixes).toContain('collapsed_question_marks');
    });

    it('reduces multiple questions to one (keeps last)', () => {
      const { body, fixes } = autoFixMessage('How are things? What about growth? Want to chat?');
      const qCount = (body.match(/\?/g) || []).length;
      expect(qCount).toBe(1);
      expect(body).toContain('chat?');
      expect(fixes).toContain('reduced_to_one_question');
    });
  });

  describe('word count trimming', () => {
    it('trims body exceeding maxWords', () => {
      // Need 3+ sentences in body (after stripping greeting/signoff) for trim logic to activate
      const longBody = `Hi Ahmad,\n\nFirst sentence with enough words to count. Second sentence that adds more content to the body. Third sentence keeps going with additional words. Fourth sentence ensures we are well above the word limit now. Fifth sentence to really push it over the edge for testing purposes. Would this help your agency scale?\n\nRegards,\nMJ`;
      const { fixes } = autoFixMessage(longBody, { maxWords: 30 });
      expect(fixes.some(f => f.startsWith('trimmed_from_'))).toBe(true);
    });

    it('preserves greeting and sign-off', () => {
      const longBody = `Hi Ahmad,\n\n${'Word '.repeat(100)}Would this help?\n\nRegards,\nMichael Jerry`;
      const { body } = autoFixMessage(longBody, { maxWords: 80 });
      expect(body).toMatch(/^Hi/i);
      expect(body).toMatch(/Regards/i);
    });
  });

  describe('empty/null handling', () => {
    it('returns fatal for null body', () => {
      const result = autoFixMessage(null);
      expect(result.fatal).toBe('empty_body');
      expect(result.body).toBe('');
    });

    it('returns fatal for empty string', () => {
      const result = autoFixMessage('');
      expect(result.fatal).toBe('empty_body');
      expect(result.body).toBe('');
    });
  });

  describe('clean message passthrough', () => {
    it('makes no changes to already-clean message', () => {
      const clean = 'Hi Ahmad,\n\nNoticed your team expanded into TikTok campaigns. Running outreach manually must be tough.\n\nWould a faster shortlist help?\n\nRegards,\nMichael Jerry';
      const { body, fixes, fatal } = autoFixMessage(clean, { touchNumber: 0, maxWords: 80 });
      expect(fixes.length).toBe(0);
      expect(fatal).toBeNull();
      expect(body).toBe(clean);
    });
  });
});
