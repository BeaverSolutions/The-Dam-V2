'use strict';

const pool = require('../db/pool');

// Stage → which actions are available
const STAGE_ACTIONS = {
  prospecting:      ['account_research'],
  new:              ['account_research'],
  outreach:         ['account_research'],
  qualifying:       ['account_research', 'call_prep'],
  booked:           ['call_prep', 'competitive_brief'],   // Pipeline UI value
  meeting_booked:   ['call_prep', 'competitive_brief'],   // DB value alias
  proposal:         ['competitive_brief', 'post_meeting'],
  negotiating:      ['competitive_brief'],
  closed_won:       [],
  closed_lost:      [],
  closed:           [],
};

const ACTION_META = {
  account_research: {
    label: 'Account Research',
    description: 'Company background, ICP fit, pain points, and talking points before first contact.',
    icon: 'Search',
    color: 'var(--blue)',
  },
  call_prep: {
    label: 'Call Prep',
    description: 'Agenda, talking points, likely objections, and what to listen for in the call.',
    icon: 'Phone',
    color: 'var(--lime)',
  },
  competitive_brief: {
    label: 'Competitive Brief',
    description: 'Their competitive landscape, how to position against alternatives, what NOT to say.',
    icon: 'Target',
    color: 'var(--orange)',
  },
  post_meeting: {
    label: 'Post-Meeting',
    description: 'Process your meeting notes into a follow-up email + proposal outline.',
    icon: 'FileText',
    color: 'var(--purple)',
  },
};

/**
 * Get available actions for a lead based on its pipeline stage
 */
async function getAvailableActions(clientId, leadId) {
  const { rows } = await pool.query(
    `SELECT l.pipeline_stage, l.name, l.company, l.title, l.meeting_date,
            sb.brief_type, sb.updated_at as brief_updated_at
     FROM leads l
     LEFT JOIN smart_briefs sb ON sb.lead_id = l.id AND sb.client_id = l.client_id
     WHERE l.id = $1 AND l.client_id = $2`,
    [leadId, clientId]
  );

  if (!rows.length) return { actions: [] };

  const lead = rows[0];
  const stage = lead.pipeline_stage || 'prospecting';
  const availableTypes = STAGE_ACTIONS[stage] || [];

  // Map which types already have generated briefs
  const generatedTypes = new Set(rows.filter(r => r.brief_type).map(r => r.brief_type));

  const actions = availableTypes.map(type => ({
    type,
    ...ACTION_META[type],
    generated: generatedTypes.has(type),
    brief_updated_at: rows.find(r => r.brief_type === type)?.brief_updated_at || null,
  }));

  return { actions, stage, lead: { name: lead.name, company: lead.company, title: lead.title } };
}

/**
 * Get a previously generated brief
 */
async function getBrief(clientId, leadId, briefType) {
  const { rows } = await pool.query(
    `SELECT content, created_at, updated_at FROM smart_briefs
     WHERE client_id = $1 AND lead_id = $2 AND brief_type = $3`,
    [clientId, leadId, briefType]
  );
  return rows[0] || null;
}

/**
 * Save a brief to the database
 */
async function saveBrief(clientId, leadId, briefType, content) {
  const { rows } = await pool.query(
    `INSERT INTO smart_briefs (client_id, lead_id, brief_type, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id, lead_id, brief_type)
     DO UPDATE SET content = $4, updated_at = NOW()
     RETURNING *`,
    [clientId, leadId, briefType, JSON.stringify(content)]
  );
  return rows[0];
}

/**
 * Load lead context for brief generation
 */
async function getLeadContext(clientId, leadId) {
  const [leadRes, messagesRes, repliesRes, personaRes, icpRes] = await Promise.all([
    pool.query(
      `SELECT l.*, c.name as client_name
       FROM leads l
       JOIN clients c ON c.id = l.client_id
       WHERE l.id = $1 AND l.client_id = $2`,
      [leadId, clientId]
    ),
    pool.query(
      `SELECT subject, body, status, created_at FROM messages
       WHERE lead_id = $1 AND client_id = $2
       ORDER BY created_at ASC LIMIT 10`,
      [leadId, clientId]
    ),
    // Inbound replies detected on outbound messages
    pool.query(
      `SELECT body, metadata, reply_detected_at FROM messages
       WHERE lead_id = $1 AND client_id = $2
         AND reply_detected_at IS NOT NULL
       ORDER BY reply_detected_at DESC LIMIT 5`,
      [leadId, clientId]
    ),
    pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'system' AND key = 'client_persona' LIMIT 1`,
      [clientId]
    ),
    pool.query(
      `SELECT content FROM agent_memory WHERE client_id = $1 AND agent = 'director' AND key = 'icp' LIMIT 1`,
      [clientId]
    ),
  ]);

  return {
    lead: leadRes.rows[0],
    messages: messagesRes.rows,
    replies: repliesRes.rows,
    persona: personaRes.rows[0]?.content || {},
    icp: icpRes.rows[0]?.content || {},
  };
}

/**
 * GENERATOR: Account Research
 */
async function generateAccountResearch(clientId, leadId) {
  const { callAgent } = require('./claude');
  const { lead, persona, icp } = await getLeadContext(clientId, leadId);

  const prompt = `You are The Director at ${persona.company_name || 'our company'}. Generate a concise account research brief for a sales rep preparing to reach out to this prospect.

LEAD:
- Name: ${lead.name}
- Title: ${lead.title || 'Unknown'}
- Company: ${lead.company}
- Industry: ${lead.industry || 'Unknown'}

OUR ICP: ${JSON.stringify(icp)}
OUR VALUE PROP: ${persona.value_proposition || 'Not set'}

Return JSON:
{
  "company_summary": "2-3 sentences on what this company does",
  "likely_size": "estimated headcount and revenue tier",
  "icp_fit_score": 85,
  "icp_fit_reason": "Why they are or aren't a strong ICP fit",
  "likely_pain_points": ["pain 1", "pain 2", "pain 3"],
  "best_angle": "The single most compelling reason to reach out to them specifically",
  "things_to_research": ["What to Google before contacting", "What LinkedIn to check"],
  "red_flags": ["Any reasons to be cautious"]
}`;

  const result = await callAgent('director', prompt);
  return result;
}

/**
 * GENERATOR: Call Prep
 */
async function generateCallPrep(clientId, leadId) {
  const { callAgent } = require('./claude');
  const { lead, messages, replies, persona, icp } = await getLeadContext(clientId, leadId);

  const sentMessages = messages.filter(m => ['sent', 'pending_send'].includes(m.status));
  const messageHistory = sentMessages.map(m => `Subject: ${m.subject}\nBody: ${m.body?.substring(0, 200)}`).join('\n---\n');

  const replyHistory = replies.length
    ? replies.map(r => {
        const sentiment = r.metadata?.reply_sentiment ? ` [${r.metadata.reply_sentiment}]` : '';
        return `Reply${sentiment}: "${r.body?.substring(0, 300)}"`;
      }).join('\n---\n')
    : 'No replies yet';

  const prompt = `You are The Director at ${persona.company_name || 'our company'}. Generate a call prep brief for a sales call with this prospect.

PROSPECT:
- Name: ${lead.name}
- Title: ${lead.title || 'Unknown'}
- Company: ${lead.company}
- Meeting date: ${lead.meeting_date || 'Soon'}
- Signal: ${lead.metadata?.signal || 'Not recorded'}
- Friction detected: ${lead.metadata?.friction || 'Not recorded'}

MESSAGES WE SENT THEM:
${messageHistory || 'No messages sent yet'}

THEIR REPLIES:
${replyHistory}

OUR COMPANY:
- Value prop: ${persona.value_proposition || 'Not set'}
- Differentiator: ${persona.differentiator || 'Not set'}
- Social proof: ${persona.social_proof || 'Not set'}
- Tone: ${persona.tone || 'Professional'}

Return JSON:
{
  "call_objective": "The single goal of this call in one sentence",
  "suggested_agenda": [
    {"time": "0:00–2:00", "item": "Opening — build rapport, confirm agenda"},
    {"time": "2:00–10:00", "item": "Discovery — ask about X"},
    {"time": "10:00–18:00", "item": "Demo/pitch — focus on Y"},
    {"time": "18:00–25:00", "item": "Handle objections"},
    {"time": "25:00–30:00", "item": "Close — define next step"}
  ],
  "key_questions": ["Question 1 to uncover pain", "Question 2", "Question 3"],
  "likely_objections": [
    {"objection": "We already have a solution", "response": "How to handle this"},
    {"objection": "Budget is tight", "response": "How to handle this"}
  ],
  "talking_points": ["Point 1 tailored to their situation", "Point 2", "Point 3"],
  "what_to_listen_for": ["Signal 1 that shows buying intent", "Signal 2"],
  "do_not_say": ["Phrases to avoid in this conversation"],
  "ideal_next_step": "What you want to close with at the end of the call"
}`;

  const result = await callAgent('director', prompt);
  return result;
}

/**
 * GENERATOR: Competitive Brief
 */
async function generateCompetitiveBrief(clientId, leadId) {
  const { callAgent } = require('./claude');
  const { lead, persona } = await getLeadContext(clientId, leadId);

  const currentTools = lead.metadata?.current_tools?.length
    ? `Known tools in use: ${lead.metadata.current_tools.join(', ')}`
    : 'No tool signals detected';
  const evaluating = lead.metadata?.evaluating?.length
    ? `May be evaluating: ${lead.metadata.evaluating.join(', ')}`
    : 'No competing evaluation signals detected';

  const prompt = `You are The Director at ${persona.company_name || 'our company'}. Generate a competitive positioning brief for a meeting with this prospect.

PROSPECT COMPANY: ${lead.company} (${lead.industry || 'industry unknown'})
${currentTools}
${evaluating}

OUR POSITIONING:
- Company: ${persona.company_name || 'Us'}
- Value prop: ${persona.value_proposition || 'Not set'}
- Differentiator: ${persona.differentiator || 'Not set'}
- Social proof: ${persona.social_proof || 'Not set'}

Return JSON:
{
  "likely_alternatives": [
    {
      "name": "Competitor or alternative name",
      "type": "Direct competitor / Status quo / DIY",
      "their_strength": "What the prospect might like about them",
      "our_advantage": "How we win against this"
    }
  ],
  "positioning_statement": "One sentence that captures how to position against the field",
  "key_differentiators": ["Differentiator 1", "Differentiator 2", "Differentiator 3"],
  "landmines": ["Things to avoid saying that play into competitor strengths"],
  "proof_points": ["Specific proof points that counter common objections"],
  "if_they_mention": [
    {"trigger": "If they mention competitor X", "response": "How to handle it"}
  ]
}`;

  const result = await callAgent('director', prompt);
  return result;
}

/**
 * GENERATOR: Post-Meeting Summary
 */
async function generatePostMeeting(clientId, leadId, notes) {
  const { callAgent } = require('./claude');
  const { lead, persona } = await getLeadContext(clientId, leadId);

  const prompt = `You are The Director at ${persona.company_name || 'our company'}. Process these meeting notes and generate a follow-up plan.

MEETING WITH: ${lead.name}, ${lead.title || ''} at ${lead.company}
MEETING NOTES:
${notes}

OUR COMPANY:
- Value prop: ${persona.value_proposition || 'Not set'}
- Tone: ${persona.tone || 'Professional'}

Return JSON:
{
  "meeting_summary": "2-3 sentences summarising what was discussed and agreed",
  "lead_temperature": "hot / warm / cold",
  "lead_temperature_reason": "Why you rated them this way based on the notes",
  "action_items": [
    {"owner": "Us / Them", "action": "Action to take", "deadline": "By when"}
  ],
  "follow_up_email": {
    "subject": "Follow-up email subject line",
    "body": "Full email body — professional, warm, references specifics from the meeting. Max 150 words."
  },
  "proposal_outline": {
    "headline": "Proposed solution headline",
    "pain_addressed": "The core pain we solve for them",
    "solution": "What we are proposing",
    "expected_outcome": "What they get",
    "suggested_investment": "Rough pricing tier if applicable",
    "next_step": "Proposed next step"
  },
  "internal_notes": "What the team should know about this prospect — red flags, buying signals, timeline"
}`;

  const result = await callAgent('director', prompt);
  return result;
}

/**
 * Main generate dispatcher
 */
async function generateBrief(clientId, leadId, briefType, options = {}) {
  let content;

  switch (briefType) {
    case 'account_research':
      content = await generateAccountResearch(clientId, leadId);
      break;
    case 'call_prep':
      content = await generateCallPrep(clientId, leadId);
      break;
    case 'competitive_brief':
      content = await generateCompetitiveBrief(clientId, leadId);
      break;
    case 'post_meeting':
      if (!options.notes) throw new Error('Meeting notes are required for post-meeting brief');
      content = await generatePostMeeting(clientId, leadId, options.notes);
      // Save notes to the lead
      await pool.query(
        `UPDATE leads SET meeting_notes = $1, updated_at = NOW() WHERE id = $2 AND client_id = $3`,
        [options.notes, leadId, clientId]
      );
      break;
    default:
      throw new Error(`Unknown brief type: ${briefType}`);
  }

  // For post_meeting, route follow-up through Ranger before approval queue
  if (briefType === 'post_meeting' && content?.follow_up_email) {
    try {
      const { rangerReview } = require('./agents');
      const rangerResult = await rangerReview(clientId, {
        message_id: null,
        message_body: content.follow_up_email.body,
      });
      const status = rangerResult.approved === true ? 'pending_approval' : 'ranger_rejected';
      const { rows: [msg] } = await pool.query(
        `INSERT INTO messages (client_id, lead_id, channel, subject, body, status, ranger_score, ranger_notes, metadata)
         VALUES ($1, $2, 'email', $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          clientId, leadId,
          content.follow_up_email.subject,
          content.follow_up_email.body,
          status,
          Math.round(rangerResult.score || 0),
          rangerResult.notes || null,
          JSON.stringify({ source: 'post_meeting_brief', auto_generated: true, ranger: rangerResult }),
        ]
      );
      if (rangerResult.approved === true) {
        await pool.query(
          `INSERT INTO approvals (client_id, message_id, requested_by) VALUES ($1, $2, 'ranger')`,
          [clientId, msg.id]
        );
      }
      content._follow_up_message_id = msg.id;
    } catch (err) {
      console.warn('[smartActions] Failed to create follow-up message:', err.message);
    }
  }

  // Persist the brief
  await saveBrief(clientId, leadId, briefType, content);

  // Log it
  await pool.query(
    `INSERT INTO logs (client_id, agent, action, target_type, target_id, metadata)
     VALUES ($1, 'director', $2, 'lead', $3, $4)`,
    [clientId, `brief_generated_${briefType}`, leadId, JSON.stringify({ brief_type: briefType })]
  );

  return content;
}

module.exports = {
  getAvailableActions,
  getBrief,
  generateBrief,
  STAGE_ACTIONS,
  ACTION_META,
};
