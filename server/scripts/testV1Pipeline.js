'use strict';

// One-off end-to-end smoke test for the v1.0 outreach rules wiring.
// Pipes 3 synthetic leads through Sales Beaver -> Enforcer with the real
// callAgent path (so {{OUTREACH_RULES}}/{{PROOF_NUMBERS}} resolution and the
// required-input contract both fire).
//
// Run from beavrdam/:
//   node --env-file=.env server/scripts/testV1Pipeline.js
//
// No clientId is set on context, so the budget gate is skipped and logUsage
// failures (no DB) are swallowed by the existing catch in claude.js.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });
process.chdir(path.join(__dirname, '..'));

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY not loaded from beavrdam/.env');
  process.exit(1);
}

const { callAgent } = require('../services/claude');

const LEADS = [
  {
    label: 'A — agency founder, post trigger',
    user_message_payload: {
      first_name: 'Zheng Yen',
      company_name: 'Mackyclyde',
      persona_segment: 'Boutique SEO agency founder, MY/SG, 5-15 staff',
      verifiable_trigger: {
        text: 'LinkedIn post about expanding SEO retainers across SEA last week',
        date: '2026-05-01',
        source_url: 'https://linkedin.com/posts/zhengyen/mackyclyde-sea-seo',
      },
      vertical_match: false,
      segment_pain_id: 1,
      deliverable_id: null,
      channel: 'linkedin',
      touch_number: 0,
    },
  },
  {
    label: 'B — B2B founder, funding trigger',
    user_message_payload: {
      first_name: 'Alia',
      company_name: 'Recruitlab',
      persona_segment: 'B2B recruitment SaaS founder, MY, 12 staff',
      verifiable_trigger: {
        text: 'Closed seed round announcement on LinkedIn',
        date: '2026-04-22',
        source_url: 'https://linkedin.com/posts/alia/recruitlab-seed',
      },
      vertical_match: false,
      segment_pain_id: 3,
      deliverable_id: null,
      channel: 'linkedin',
      touch_number: 0,
    },
  },
  {
    label: 'C — sales-led team, SDR hire trigger',
    user_message_payload: {
      first_name: 'Daniel',
      company_name: 'Stackline',
      persona_segment: 'B2B services VP Sales, MY, 25 staff',
      verifiable_trigger: {
        text: 'LinkedIn job posting for SDR role, posted 12 days ago',
        date: '2026-04-24',
        source_url: 'https://linkedin.com/jobs/stackline-sdr',
      },
      vertical_match: false,
      segment_pain_id: 2,
      deliverable_id: null,
      channel: 'linkedin',
      touch_number: 0,
    },
  },
];

function buildSalesBeaverUserMessage(lead) {
  const p = lead.user_message_payload;
  return `Write a ${p.channel} outreach message for this lead.

LEAD CONTEXT:
- first_name: ${p.first_name}
- company_name: ${p.company_name}
- persona_segment: ${p.persona_segment}
- verifiable_trigger.text: ${p.verifiable_trigger.text}
- verifiable_trigger.date: ${p.verifiable_trigger.date}
- verifiable_trigger.source_url: ${p.verifiable_trigger.source_url}
- vertical_match: ${p.vertical_match}
- segment_pain_id: ${p.segment_pain_id}
- deliverable_id: ${p.deliverable_id}
- channel: ${p.channel}
- touch_number: ${p.touch_number}

DO NOT include any sign-off, "Regards,", "Best,", or your own name. End the body at the final question.`;
}

function buildEnforcerUserMessage(lead, draft) {
  const p = lead.user_message_payload;
  return `Review this message:

LEAD CONTEXT (validate message is accurate for this person):
- Name: ${p.first_name}
- Company: ${p.company_name}
- Title/Persona: ${p.persona_segment}
- Signal (verifiable_trigger): ${p.verifiable_trigger.text}
- segment_pain_id: ${p.segment_pain_id}
- channel: ${p.channel}
- touch_number: ${p.touch_number}

MESSAGE:
${draft.body || ''}`;
}

function wordCount(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('v1.0 outreach pipeline — end-to-end smoke test');
  console.log(`Started at ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const results = [];

  for (const lead of LEADS) {
    console.log(`── Lead ${lead.label}`);
    const out = { label: lead.label, sales: null, enforcer: null, errors: [] };

    // Stage 1: Sales Beaver
    try {
      const t0 = Date.now();
      const draft = await callAgent('sales_beaver', buildSalesBeaverUserMessage(lead));
      const elapsed = Date.now() - t0;
      out.sales = { elapsed, draft };

      if (draft?.status === 'needs_more_research') {
        console.log(`   sales: DROPPED (needs_more_research). missing=${JSON.stringify(draft.missing_fields)} (${elapsed}ms)`);
      } else if (draft?.body) {
        const wc = wordCount(draft.body);
        console.log(`   sales: OK. words=${wc} segment_pain=${draft.segment_pain_id} path=${draft.path_used} opt_out=${draft.opt_out_variant} (${elapsed}ms)`);
        console.log(`   trigger_referenced: ${(draft.trigger_referenced || '').slice(0, 80)}`);
        console.log(`   body:\n${draft.body.split('\n').map(l => '     ' + l).join('\n')}`);
      } else {
        console.log(`   sales: UNKNOWN response shape (${elapsed}ms): ${JSON.stringify(draft).slice(0, 200)}`);
      }
    } catch (e) {
      out.errors.push(`sales: ${e.message}`);
      console.log(`   sales: ERROR ${e.message}`);
    }

    // Stage 2: Enforcer (only if Sales produced a body)
    if (out.sales?.draft?.body) {
      try {
        const t0 = Date.now();
        const review = await callAgent('ranger', buildEnforcerUserMessage(lead, out.sales.draft));
        const elapsed = Date.now() - t0;
        out.enforcer = { elapsed, review };
        const summary = `decision=${review.decision || review.approved} score=${review.score ?? 'n/a'}`;
        const reason = review.decision !== 'approve' ? ` reject_reason=${review.reject_reason || review.failed_rule || 'n/a'}` : '';
        console.log(`   enforcer: ${summary}${reason} (${elapsed}ms)`);
        if (review.feedback) console.log(`   feedback: ${review.feedback.slice(0, 200)}`);
      } catch (e) {
        out.errors.push(`enforcer: ${e.message}`);
        console.log(`   enforcer: ERROR ${e.message}`);
      }
    }

    results.push(out);
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  for (const r of results) {
    const sales = r.sales?.draft?.status === 'needs_more_research' ? 'DROPPED' :
                  r.sales?.draft?.body ? 'DRAFTED' : 'ERROR';
    const enforcer = r.enforcer?.review?.decision || (sales === 'DRAFTED' ? 'ERROR' : 'n/a');
    console.log(`  ${r.label.padEnd(50)} sales=${sales.padEnd(8)} enforcer=${enforcer}`);
  }
  console.log('');

  process.exit(0);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
