import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const salesRules = readFileSync(
  join(ROOT, 'server/sales-rules/BEAVER_LINKEDIN_OUTREACH_RULES.md'),
  'utf8',
);
const agentsPrompt = readFileSync(
  join(ROOT, 'server/config/agents.js'),
  'utf8',
);
const agentsService = readFileSync(
  join(ROOT, 'server/services/agents.js'),
  'utf8',
);
const autonomousRoutes = readFileSync(
  join(ROOT, 'server/routes/autonomous.js'),
  'utf8',
);

describe('LinkedIn DM standard contract', () => {
  it('documents the new three-line cold DM structure Sales Beaver must write', () => {
    expect(salesRules).toContain('### Three-line LinkedIn DM standard');
    expect(salesRules).toContain('Hi [First Name], saw you [specific signal].');
    expect(salesRules).toContain('one diagnostic question only');
    expect(salesRules).toContain('No extra opt-out line');
    expect(salesRules).not.toContain('No formal greeting line');
    expect(salesRules).not.toContain('Every cold first message has four parts');
  });

  it('keeps Sales Beaver prompt aligned to the new DM standard', () => {
    expect(agentsPrompt).toContain('THREE-LINE LINKEDIN DM STANDARD');
    expect(agentsPrompt).toContain('Hi <first_name>, saw you <specific signal>.');
    expect(agentsPrompt).toContain('Do not add a separate opt-out closer');
    expect(agentsPrompt).not.toContain('Use full 4-part v1.0 structure');
    expect(agentsPrompt).not.toContain('Use the 4-part structure with observation replacing trigger');
    expect(agentsPrompt).not.toContain('APPROVED (trigger + diagnostic + varied opt-out)');
  });

  it('keeps Enforcer from rejecting the new style for missing an opt-out closer', () => {
    expect(agentsPrompt).toContain('V1.1 LINKEDIN DM STRUCTURE');
    expect(agentsPrompt).toContain('The fourth opt-out closer is no longer required');
    expect(agentsPrompt).not.toContain('(d) varied opt-out closer');
    expect(agentsPrompt).not.toContain('four parts is missing');
  });

  it('keeps the response schema compatible while marking opt-out as optional', () => {
    expect(agentsPrompt).toContain('"opt_out_variant":"Optional; empty string when omitted"');
  });

  it('keeps secondary Sales Beaver channel hints aligned to the greeting standard', () => {
    expect(agentsService).toContain('Start line 1 with "Hi {first_name}, saw you {specific signal}."');
    expect(agentsService).toContain('Line 1 starts with: Hi [first name only], saw you [specific signal].');
    expect(agentsService).toContain('The three-line LinkedIn DM text: Hi [name], saw you [specific signal].');
    expect(agentsService).not.toContain('No greeting like "Hi Name,"');
    expect(agentsService.indexOf('Line 1 starts with: Hi [first name only], saw you [specific signal].'))
      .toBeLessThan(agentsService.indexOf('NO subject line. NO "Hi [name]," greeting.'));
  });

  it('keeps LinkedIn channel escalation from using the old no-greeting DM format', () => {
    expect(autonomousRoutes).toContain('FORMAT (LinkedIn DM');
    expect(autonomousRoutes).toContain('Hi ${escalationFirstName}, saw you');
    expect(autonomousRoutes).toContain("escalation.new_channel === 'linkedin'");
    expect(autonomousRoutes.indexOf("escalation.new_channel === 'linkedin'"))
      .toBeLessThan(autonomousRoutes.indexOf('FORMAT (${escalation.new_channel} DM'));
  });
});
