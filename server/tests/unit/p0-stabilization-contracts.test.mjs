import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const service = (path) => readFileSync(resolve(__dirname, '../../', path), 'utf-8');

function fnBody(source, marker, endMarker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = endMarker ? source.indexOf(endMarker, start) : -1;
  return source.slice(start, end > start ? end : start + 5000);
}

describe('P0 stabilization contracts', () => {
  it('Vibe CSV import is source-specific, trusted, tiered, and deduped beyond email', () => {
    const src = service('routes/import.js');
    expect(src).toContain('vibe_csv');
    expect(src).toContain("meta.email_verification = email ? 'trusted_from_vibe_csv' : 'not_present'");
    expect(src).toContain("emailSource = emailVerified ? 'vibe_csv' : null");
    expect(src).toContain("email ? 'A' : normalizedLinkedIn ? 'B' : null");
    expect(src).toContain('LOWER(TRIM(email))');
    expect(src).toContain("SPLIT_PART(linkedin_url, '?', 1)");
    expect(src).toContain('REGEXP_REPLACE(COALESCE(name');
    expect(src).not.toContain("source: 'csv_import' })");
  });

  it('dashboard daily-progress is read-only and counts email/linkedin separately', () => {
    const src = service('routes/dashboard.js');
    const route = fnBody(src, "router.get('/daily-progress'", "router.get('/weekly-learnings'");
    expect(route).not.toContain('INSERT INTO daily_kpi');
    expect(route).not.toContain('UPDATE daily_kpi');
    expect(route).toContain("channel = 'email'");
    expect(route).toContain("channel = 'linkedin'");
    expect(route).toContain('target_email_sent');
    expect(route).toContain('target_linkedin_sent');
    expect(route).toContain("AT TIME ZONE 'Asia/Kuala_Lumpur'");
  });

  it('simulated sends cannot become sent or count toward KPI/conversion', () => {
    const src = service('services/sendQueueWorker.js');
    const simulatedIdx = src.indexOf("result.status === 'simulated'");
    const sentIdx = src.indexOf("UPDATE send_queue SET status = 'sent'");
    expect(simulatedIdx).toBeGreaterThanOrEqual(0);
    expect(sentIdx).toBeGreaterThan(simulatedIdx);
    expect(src).toContain("'simulated_send_not_delivered'");
    expect(src).toContain("'send_simulated_not_counted'");
    expect(src).toContain('recoverStaleSendingJobs');
  });

  it('paid provider calls are guarded through spendGuard', () => {
    expect(service('services/searchService.js')).toMatch(/checkProvider\('brave'[\s\S]+checkProvider\('google_cse'/);
    expect(service('services/searchService.js')).toContain('provider_error');
    expect(service('services/searchService.js')).toContain('logProviderError');
    expect(service('services/marketSensing.js')).toContain("checkProvider('brave'");
    expect(service('services/hunter.js')).toContain("checkProvider('hunter'");
    expect(service('services/emailEnrichment.js')).toContain("checkProvider('millionverifier'");
    expect(service('services/apollo.js')).toContain("checkProvider('apollo'");
    expect(service('services/spendGuard.js')).toContain("apollo: envNumber('APOLLO_DAILY_QUERY_CAP', 0)");
    expect(service('services/spendGuard.js')).toContain('providerUsageToday(provider, clientId)');
    expect(service('services/vibeProspecting.js')).toContain('ALLOW_VP_PAID_ENRICHMENT');
    expect(service('services/spendGuard.js')).toContain("brave: envNumber('BRAVE_DAILY_QUERY_CAP', 0)");
    expect(service('services/searchService.js')).toContain('SEARCH_MAX_PAID_QUERIES_PER_OPERATION');
    expect(service('services/searchService.js')).toContain('splitPaidQueryBudget');
    expect(service('services/spendGuard.js')).toContain('provider_blocked');
  });

  it('campaigns cannot silently claim output after zero-useful-lead paths', () => {
    const captain = service('services/captainBeaver.js');
    const agents = service('services/agents.js');
    const index = service('index.js');

    expect(index).toContain('CAPTAIN_KPI_GAP_KICKOFF_ENABLED');
    expect(captain).toContain('getRunCampaignPreflight');
    expect(captain).toContain('campaign_background_failed');
    expect(captain).toContain('campaign_blocked');
    expect(agents).toContain('original_lead_count');
    expect(agents).toContain('skipped_same_day');
    expect(agents).toContain('signal_pipeline_skipped');
    expect(agents).toContain('same_day_enrolled_dedupe');
  });

  it('VP spend ledger records paid contact enrichment immediately', () => {
    expect(service('services/spendGuard.js')).toContain("metadata->>'provider' = 'vp'");
    expect(service('services/spendGuard.js')).toContain("VP_CREDITS_PER_LEAD = envNumber('VP_CREDITS_PER_LEAD', 5)");
    expect(service('services/vibeProspecting.js')).toContain("logProviderUsage('vp'");
    expect(service('services/dbBuilder.js')).toContain("checkProvider('vp', { clientId, estimatedUnits: 5 })");
    expect(service('services/dbBuilder.js')).toContain('checkVP(0, { clientId })');
  });

  it('LLM calls require client attribution before provider spend', () => {
    expect(service('services/claude.js')).toContain('LLM_CLIENT_ID_REQUIRED');
    expect(service('services/claude.js')).toContain('allowUnattributedLLM');
    expect(service('services/claude.js')).toContain('function selectedLLMProvider()');
    expect(service('services/claude.js')).toContain("if (process.env.OPENAI_API_KEY) return 'openai'");
    expect(service('services/llm/openai.js')).toContain('LLM_CLIENT_ID_REQUIRED');
    expect(service('services/captainBeaver.js')).toContain('runWithClientContext(clientId');
    expect(service('../.env.example')).toContain('LLM_PROVIDER=openai');
    expect(service('../.env.example')).toContain('OPENAI_API_KEY=');
    expect(service('../.env.production.example')).toContain('LLM_PROVIDER=openai');
    expect(service('services/captainOrchestrator.js')).toContain('selected_key_set');
    expect(service('services/captainOrchestrator.js')).toContain("openaiSet ? 'openai' : 'anthropic'");
  });

  it('meetings are outcome tracking, not a fixed KPI target', () => {
    const captain = service('services/captainOrchestrator.js');
    expect(captain).not.toContain('MONTHLY_MEETING_TARGET');
    expect(captain).not.toContain('monthly_target');
    expect(captain).not.toContain('gap_to_target');
    expect(captain).toContain('Meetings: ${kpis.meetings.this_week} this week');
  });

  it('pipeline stage updates do not write the removed next_action column', () => {
    const leads = service('services/leads.js');
    const updateLead = fnBody(leads, 'async function updateLead', 'async function deleteLead');
    const fieldsMatch = updateLead.match(/const fields = \[([^\]]+)\]/);

    expect(leads).toContain("meeting_booked: 'meeting_booked'");
    expect(leads).toContain("return stage === 'booked' ? 'meeting_booked' : stage");
    expect(leads).not.toContain("  'booked',");
    expect(leads).toContain("PIPELINE_STAGE_INPUTS = Object.freeze([...PIPELINE_STAGES, 'booked'])");
    expect(updateLead).toContain('delete data.next_action');
    expect(updateLead).toContain('stage_history');
    expect(fieldsMatch?.[1] || '').not.toContain('next_action');
    expect(service('routes/leads.js')).toContain("body('pipeline_stage').optional().isIn(leadsService.PIPELINE_STAGE_INPUTS)");
  });

  it('Apollo is guarded and not trusted as a verified email source', () => {
    const agents = service('services/agents.js');
    expect(agents).not.toContain("lead.email_source === 'apollo'");
    expect(service('services/apollo.js')).toContain("checkProvider('apollo'");
    expect(service('services/apollo.js')).toContain("logProviderUsage('apollo'");
  });

  it('autonomous routes require the internal key at router level', () => {
    const autonomous = service('routes/autonomous.js');
    expect(autonomous).toContain('router.use(requireInternalKey)');
  });
});
