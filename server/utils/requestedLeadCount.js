'use strict';

const { MAX_SINGLE_KICKOFF_LEADS, clampSingleKickoffCount } = require('./campaignLimits');

const LEAD_NOUN_RE = /\b(?:approval[-\s]?ready\s+)?(?:new\s+)?(?:leads?|prospects?|companies|founders|contacts|outreach(?:\s+items?)?|messages?)\b/i;
const CAMPAIGN_ACTION_RE = /\b(find|source|get|research|run|start|kickoff|process|draft|message|send|contact|queue|launch|execute|begin)\b/i;

function clampCount(value, defaultCount = MAX_SINGLE_KICKOFF_LEADS) {
  return clampSingleKickoffCount(value, defaultCount);
}

function isSafeNumericToken(text, start, end) {
  const prev = text[start - 1] || '';
  const next = text[end] || '';

  // Ignore version, decimal, time, date, and fraction fragments such as V2.1,
  // 09:30, 2026-06-03, or 5/10. These are not lead-count requests.
  if ((prev && '.:-/'.includes(prev)) || (next && '.:-/'.includes(next))) return false;
  return true;
}

function numericTokens(text) {
  const tokens = [];
  const re = /\b(\d{1,3})\b/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[1].length;
    if (!isSafeNumericToken(text, start, end)) continue;
    tokens.push({ value: match[1], start, end });
  }
  return tokens;
}

function hasAnotherNumber(slice) {
  return /\b\d{1,3}\b/.test(slice);
}

function parseRequestedLeadCount(command, defaultCount = MAX_SINGLE_KICKOFF_LEADS) {
  const text = String(command || '');
  const tokens = numericTokens(text);

  for (const token of tokens) {
    const after = text.slice(token.end, Math.min(text.length, token.end + 90));
    const noun = after.match(LEAD_NOUN_RE);
    if (noun && !hasAnotherNumber(after.slice(0, noun.index))) {
      return clampCount(token.value, defaultCount);
    }
  }

  for (const token of tokens) {
    const before = text.slice(Math.max(0, token.start - 45), token.start);
    const nounMatches = Array.from(before.matchAll(new RegExp(LEAD_NOUN_RE.source, 'gi')));
    if (nounMatches.length > 0) {
      const lastNoun = nounMatches[nounMatches.length - 1];
      const afterNoun = before.slice((lastNoun.index || 0) + lastNoun[0].length);
      if (!hasAnotherNumber(afterNoun)) return clampCount(token.value, defaultCount);
    }
  }

  if (CAMPAIGN_ACTION_RE.test(text) && tokens.length > 0) {
    return clampCount(tokens[0].value, defaultCount);
  }

  return defaultCount;
}

module.exports = {
  parseRequestedLeadCount,
};
