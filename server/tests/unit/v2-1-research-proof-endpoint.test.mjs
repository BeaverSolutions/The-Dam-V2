import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readSource = (path) => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');
const autonomousSource = readSource('../../routes/autonomous.js');

function routeBody(routePath) {
  const start = autonomousSource.indexOf(`router.post('${routePath}'`);
  const nextRoute = autonomousSource.indexOf('\nrouter.', start + 1);
  return start === -1 ? '' : autonomousSource.slice(start, nextRoute === -1 ? undefined : nextRoute);
}

describe('V2.1 research proof endpoint', () => {
  it('runs only the bounded Signal Hunt save path and cannot auto-outreach', () => {
    const body = routeBody('/v2-1/research-proof');

    expect(body).toContain("router.post('/v2-1/research-proof', requireInternalKey");
    expect(body).toContain('const proofLimit = 5;');
    expect(body).toContain('const proofPaidQueryCap = boundedResearchProofQueryCap(req.body?.max_paid_queries);');
    expect(body).toContain('previewSignalHuntPlan');
    expect(body).toContain('buildPlatformPlan');
    expect(body).toContain('loadApprovedPlatformPlan');
    expect(body).toContain("loadIcpForSignalHunt(clientId, { source: 'http' })");
    expect(body).toContain('TENANT_PROFILE_BLOCKED');
    expect(body).toContain('approvedPlatformPlanRequest(req.body)');
    expect(body).toContain('approved_platform_plan_id');
    expect(body).toContain('confirm_platform_plan_hash');
    expect(body).toContain('APPROVED_PLATFORM_PLAN_REQUIRED');
    expect(body).toContain('v2_1_research_proof_platform_plan');
    expect(body).toContain('REPEATED_ZERO_QUERY_SET');
    expect(body).toContain('required_confirmation');
    expect(body).toContain('platformPlan: approvedPlatformPlan');
    expect(body).toContain('platformFunnelFromSignalHuntResult');
    expect(body).toContain('recordSignalHuntPlatformFunnel');
    expect(body).toContain('updateStrategyStateFromPlan');
    expect(body).toContain('runWithClientContext(clientId, () => runSignalHunt(clientId, {');
    expect(body).toContain('maxLeads: proofLimit');
    expect(body).toContain('maxPaidQueries: effectiveProofPaidQueryCap');
    expect(body).toContain('paid_query_cap: effectiveProofPaidQueryCap');
    expect(body).toContain('const saved = await saveSignalLeads(clientId, leads);');
    expect(body).toContain('signal_package');
    expect(body).toContain('messages_delta');
    expect(body).toContain('approvals_delta');
    expect(body).toContain('send_queue_delta');
    expect(body).not.toContain('confirm_query_plan_hash');
    expect(body).not.toContain('QUERY_PLAN_CONFIRMATION_MISMATCH');
    expect(body).not.toContain('directorExecute');
    expect(body).not.toContain('rangerReview');

    expect(body.indexOf('loadApprovedPlatformPlan')).toBeLessThan(
      body.indexOf('previewSignalHuntPlan(clientId')
    );
    expect(body.indexOf('previewSignalHuntPlan(clientId')).toBeLessThan(
      body.indexOf('runWithClientContext(clientId, () => runSignalHunt')
    );
    expect(body.indexOf("loadIcpForSignalHunt(clientId, { source: 'http' })")).toBeLessThan(
      body.indexOf('buildPlatformPlan')
    );
  });

  it('keeps chat-triggered Signal Hunt behind an explicit paid gate, uses bounded proof cap, and prevents auto-outreach', () => {
    const chatBody = routeBody('/chat');
    const start = chatBody.indexOf('Intent 4: SIGNAL HUNT');
    const end = chatBody.indexOf('Intent 5: RECENT REPLIES', start);
    const signalBranch = chatBody.slice(start, end);
    const previewStart = signalBranch.indexOf('const plan = await previewSignalHuntPlan');
    const previewEnd = signalBranch.indexOf('if (req.body?.allow_paid_signal_hunt', previewStart);
    const previewBlock = signalBranch.slice(previewStart, previewEnd);

    expect(signalBranch).toContain('allow_paid_signal_hunt');
    expect(signalBranch).toContain('signal_hunt_paid_gate_required');
    expect(signalBranch).toContain('Math.min(');
    expect(signalBranch).toContain('5');
    expect(signalBranch).toContain('const signalPaidQueryCap = boundedChatSignalQueryCap(signalLimit)');
    expect(previewBlock).toContain('maxLeads: signalLimit');
    expect(signalBranch).toContain('maxLeads: signalLimit');
    expect(signalBranch).toContain('maxPaidQueries: signalPaidQueryCap');
    expect(signalBranch).toContain('paid_query_cap: signalPaidQueryCap');
    expect(signalBranch).toContain('Research-only');
    expect(signalBranch).not.toContain('maxLeads: 20');
    expect(signalBranch).not.toContain('maxPaidQueries: signalLimit');
    expect(signalBranch).not.toContain('directorExecute(client_id');
  });
});
