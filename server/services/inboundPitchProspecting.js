'use strict';

const DEFAULT_DEFER_MONTHS = 2;
const DEFAULT_BEAVER_CLIENT_ID = process.env.BEAVRDAM_TENANT_ID_BEAVER_SOLUTIONS
  || 'ce2fc8e5-617e-42d5-91fe-4275ceaa0030';

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.my', 'yahoo.com.sg',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'mail.com',
]);

const BULK_SENDER_DOMAINS = new Set([
  'mailchimpapp.net', 'sendgrid.net', 'amazonses.com', 'hubspotemail.net',
  'mailgun.org', 'mandrillapp.com', 'constantcontact.com',
]);

function extractEmailAddress(value = '') {
  const match = String(value || '').match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : '';
}

function senderDomainFromHeader(value = '') {
  const email = extractEmailAddress(value);
  if (!email) return '';
  return email.split('@')[1].replace(/^mail\./, '').toLowerCase();
}

function isFreemailDomain(domain = '') {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  return FREEMAIL_DOMAINS.has(d);
}

function isBulkSenderDomain(domain = '') {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  return BULK_SENDER_DOMAINS.has(d) || [...BULK_SENDER_DOMAINS].some(parent => d.endsWith(`.${parent}`));
}

function cleanHeaderName(value = '') {
  const raw = String(value || '').replace(/<[^>]+>/g, '').replace(/^"|"$/g, '').trim();
  if (!raw || /@/.test(raw)) return '';
  return raw.replace(/\s+/g, ' ').slice(0, 120);
}

function titleCaseLocalPart(value = '') {
  return String(value || '')
    .split(/[._\-+]/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

function senderNameFromHeader(value = '') {
  const cleaned = cleanHeaderName(value);
  if (cleaned) return cleaned;
  const email = extractEmailAddress(value);
  return titleCaseLocalPart(email.split('@')[0] || '');
}

function companyNameFromDomain(domain = '') {
  const root = String(domain || '').toLowerCase().replace(/^www\./, '').split('.')[0] || '';
  return root
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function countryFromDomain(domain = '') {
  const d = String(domain || '').toLowerCase();
  if (d.endsWith('.my')) return 'MY';
  if (d.endsWith('.sg')) return 'SG';
  return null;
}

function dateOnly(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function addMonthsDateOnly(value, months = DEFAULT_DEFER_MONTHS) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return addMonthsDateOnly(new Date().toISOString(), months);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function compactText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .trim();
}

function oneLinePitchSummary({ subject = '', body = '' } = {}) {
  const cleanSubject = compactText(subject).replace(/^(re|fw|fwd):\s*/i, '');
  if (cleanSubject && cleanSubject.length >= 8) return cleanSubject.slice(0, 160);
  const firstSentence = compactText(body).split(/(?<=[.!?])\s+/)[0] || '';
  return firstSentence.slice(0, 160);
}

function containsInboundPitchReference(body = '') {
  const text = String(body || '');
  return /\b(?:i|we)?\s*(?:got|received|saw|read)\s+your\s+(?:email|pitch|message|note|outreach)\b/i.test(text)
    || /\bthanks?\s+for\s+(?:reaching out|your\s+(?:email|pitch|message|note))\b/i.test(text)
    || /\byour\s+(?:email|pitch|message|note|outreach)\s+(?:to us|earlier|last week|yesterday)\b/i.test(text);
}

function baseLeadFields({ from, subject, body, channel = 'email', receivedAt, companyIdentity = {}, icpGate = {} }) {
  const senderEmail = extractEmailAddress(from);
  const senderDomain = senderDomainFromHeader(from);
  const senderName = senderNameFromHeader(from);
  const date = dateOnly(receivedAt);
  const summary = oneLinePitchSummary({ subject, body });
  const company = companyIdentity.company || companyNameFromDomain(senderDomain);
  const website = companyIdentity.website || (senderDomain ? `https://${senderDomain}` : null);
  const sourceUrl = senderEmail ? `mailto:${senderEmail}` : website;
  const whyNow = `actively running manual cold outbound - pitched us on ${date}`;

  const signalPackage = {
    signal_id: 'inbound_vendor_pitch',
    signal_family: 'pain_friction_evidence',
    source_channel: 'inbound_pitch',
    source_url: sourceUrl,
    evidence: `Pitch received via ${channel} on ${date}: ${summary}`,
    evidence_date: date,
    why_now: whyNow,
    pitch_summary: summary,
    sender_domain: senderDomain,
    company_website: website,
    company_icp_fit: {
      lead_class: 'icp_match',
      vertical_match: icpGate.vertical_match || null,
      icp_evidence: icpGate.icp_evidence || [],
    },
    decision_maker: {
      name: senderName,
      title: null,
      source_url: sourceUrl,
    },
  };

  return {
    name: senderName,
    email: senderEmail || null,
    company,
    title: null,
    source: 'inbound_pitch',
    signal_tier: 'P1',
    score: 90,
    pipeline_stage: 'prospecting',
    status: 'new',
    email_verified: Boolean(senderEmail),
    email_source: senderEmail ? 'inbound_pitch' : null,
    linkedin_url: null,
    country: countryFromDomain(senderDomain),
    lead_tier: senderEmail ? 'A' : null,
    buying_signal_strength: 'rich',
    signal_dated_at: receivedAt || new Date().toISOString(),
    metadata: {
      source: 'inbound_pitch',
      inbound_pitch: {
        received_at: receivedAt || new Date().toISOString(),
        channel,
        sender_domain: senderDomain,
        sender_email: senderEmail || null,
        summary,
      },
      signal_package: signalPackage,
      buying_signal_strength: 'rich',
      signal_dated_at: receivedAt || new Date().toISOString(),
      country: countryFromDomain(senderDomain),
    },
  };
}

function buildInboundPitchLeadCandidate(input = {}) {
  const domain = senderDomainFromHeader(input.from);
  if (!domain) return { action: 'skip', reason: 'missing_sender_domain' };
  if (isFreemailDomain(domain)) return { action: 'skip', reason: 'freemail_sender', sender_domain: domain };
  if (isBulkSenderDomain(domain)) return { action: 'skip', reason: 'bulk_sender_domain', sender_domain: domain };
  if (!senderNameFromHeader(input.from)) return { action: 'skip', reason: 'missing_sender_name', sender_domain: domain };
  if (!input.companyIdentity?.company || input.companyIdentity?.resolved === false) {
    return { action: 'skip', reason: 'company_unresolved', sender_domain: domain };
  }

  const lead = baseLeadFields(input);
  if (input.icpGate?.pass) {
    return { action: 'create_lead', lead, sender_domain: domain };
  }

  if (input.icpGate?.blocker === 'competitor_offer_disqualified') {
    const parked = {
      ...lead,
      status: 'rejected_persona',
      pipeline_stage: 'rejected',
      lead_tier: 'C',
      metadata: {
        ...lead.metadata,
        lead_class: 'competitor_offer',
        deferred_review_date: addMonthsDateOnly(input.receivedAt),
        rejection_reason: input.icpGate.reason || 'competitor_offer_matched',
        competitor_offer_matched_terms: input.icpGate.matched_terms || [],
        signal_package: {
          ...lead.metadata.signal_package,
          company_icp_fit: {
            lead_class: 'competitor_offer',
            vertical_match: null,
            icp_evidence: [],
          },
        },
      },
    };
    return { action: 'park_competitor', lead: parked, sender_domain: domain };
  }

  return {
    action: 'skip',
    reason: input.icpGate?.reason || input.icpGate?.blocker || 'icp_gate_failed',
    sender_domain: domain,
  };
}

async function findExistingInboundPitchLead(clientId, domain, { pool }) {
  const { rows } = await pool.query(
    `SELECT id
       FROM leads
      WHERE client_id = $1
        AND source = 'inbound_pitch'
        AND deleted_at IS NULL
        AND lower(metadata->'signal_package'->>'sender_domain') = lower($2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId, domain]
  );
  return rows[0] || null;
}

async function insertLead(clientId, lead, { pool }) {
  const { rows } = await pool.query(
    `INSERT INTO leads (client_id, name, email, company, title, source, signal_tier, status, score,
                        metadata, pipeline_stage, email_verified, email_source, linkedin_url, country,
                        lead_tier, tiered_at, buying_signal_strength, signal_dated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),$17,$18)
     RETURNING id`,
    [
      clientId,
      lead.name,
      lead.email,
      lead.company,
      lead.title,
      lead.source,
      lead.signal_tier,
      lead.status,
      lead.score,
      JSON.stringify(lead.metadata || {}),
      lead.pipeline_stage,
      lead.email_verified,
      lead.email_source,
      lead.linkedin_url,
      lead.country,
      lead.lead_tier,
      lead.buying_signal_strength,
      lead.signal_dated_at,
    ]
  );
  return rows[0] || null;
}

function defaultEvaluateSignalCompanyIcpGate(signal, icp) {
  const signalHunt = require('./signalHunt');
  const fn = signalHunt.evaluateSignalCompanyIcpGate || signalHunt._test?.evaluateSignalCompanyIcpGate;
  if (typeof fn !== 'function') {
    return { pass: false, blocker: 'icp_gate_unavailable', reason: 'icp_gate_unavailable' };
  }
  return fn(signal, icp);
}

async function captureVendorColdPitch(clientId, ctx = {}, deps = {}) {
  const pool = deps.pool || require('../db/pool');
  const logsService = deps.logsService || require('./logs');
  const resolveCompanyIdentity = deps.resolveCompanyIdentity || require('./companyEvidenceResolver').resolveCompanyIdentity;
  const loadIcpForSignalHunt = deps.loadIcpForSignalHunt || require('./tenantContext').loadIcpForSignalHunt;
  const evaluateSignalCompanyIcpGate = deps.evaluateSignalCompanyIcpGate || defaultEvaluateSignalCompanyIcpGate;

  const from = ctx.inboundFrom || ctx.from || '';
  const subject = ctx.inboundSubject || ctx.subject || '';
  const body = ctx.snippet || ctx.body || '';
  const channel = ctx.channel || (ctx.provider === 'agentmail' ? 'email' : 'email');
  const receivedAt = ctx.receivedAt || new Date().toISOString();
  const domain = senderDomainFromHeader(from);
  const targetClientId = deps.targetClientId || DEFAULT_BEAVER_CLIENT_ID;

  if (clientId !== targetClientId) {
    return { action: 'skip', reason: 'non_beaver_client', target_client_id: targetClientId };
  }

  if (!domain) return { action: 'skip', reason: 'missing_sender_domain' };
  if (isFreemailDomain(domain)) return { action: 'skip', reason: 'freemail_sender', sender_domain: domain };
  if (isBulkSenderDomain(domain)) return { action: 'skip', reason: 'bulk_sender_domain', sender_domain: domain };

  const existing = await findExistingInboundPitchLead(clientId, domain, { pool });
  if (existing) {
    await logsService.createLog(clientId, {
      agent: 'system',
      action: 'inbound_pitch_duplicate_domain',
      target_type: 'message',
      target_id: ctx.messageId || null,
      metadata: { sender_domain: domain, existing_lead_id: existing.id },
    }).catch(() => {});
    return { action: 'skip', reason: 'duplicate_domain', lead_id: existing.id, sender_domain: domain };
  }

  const companyIdentity = await resolveCompanyIdentity({
    company: companyNameFromDomain(domain),
    company_website: `https://${domain}`,
  });
  const icp = await loadIcpForSignalHunt(clientId, { source: 'service' });
  const summary = oneLinePitchSummary({ subject, body });
  const signal = {
    company: companyIdentity.company,
    company_website: companyIdentity.website || `https://${domain}`,
    source_channel: 'inbound_pitch',
    signal_summary: summary,
    raw_snippet: [summary, companyIdentity.page_text || ''].filter(Boolean).join(' '),
    why_now: `actively running manual cold outbound - pitched us on ${dateOnly(receivedAt)}`,
  };
  const icpGate = evaluateSignalCompanyIcpGate(signal, icp || {});
  const candidate = buildInboundPitchLeadCandidate({
    from,
    subject,
    body,
    channel,
    receivedAt,
    companyIdentity,
    icpGate,
  });

  if (!['create_lead', 'park_competitor'].includes(candidate.action)) {
    await logsService.createLog(clientId, {
      agent: 'system',
      action: 'inbound_pitch_skipped',
      target_type: 'message',
      target_id: ctx.messageId || null,
      metadata: { sender_domain: domain, reason: candidate.reason, icp_gate: icpGate },
    }).catch(() => {});
    return candidate;
  }

  const inserted = await insertLead(clientId, candidate.lead, { pool });
  await logsService.createLog(clientId, {
    agent: 'system',
    action: candidate.action === 'park_competitor' ? 'inbound_pitch_competitor_parked' : 'inbound_pitch_lead_created',
    target_type: 'lead',
    target_id: inserted?.id || null,
    metadata: {
      sender_domain: domain,
      message_id: ctx.messageId || null,
      source: 'inbound_pitch',
      action: candidate.action,
      icp_gate: icpGate,
    },
  }).catch(() => {});

  return { action: candidate.action, lead_id: inserted?.id || null, sender_domain: domain };
}

module.exports = {
  captureVendorColdPitch,
  buildInboundPitchLeadCandidate,
  containsInboundPitchReference,
  extractEmailAddress,
  senderDomainFromHeader,
  isFreemailDomain,
  isBulkSenderDomain,
  oneLinePitchSummary,
  DEFAULT_BEAVER_CLIENT_ID,
  _test: {
    addMonthsDateOnly,
    companyNameFromDomain,
    countryFromDomain,
    senderNameFromHeader,
  },
};
