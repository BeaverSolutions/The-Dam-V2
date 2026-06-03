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
    expect(body).toContain('const { runSignalHunt, saveSignalLeads } = require(\'../services/signalHunt\');');
    expect(body).toContain('runWithClientContext(clientId, () => runSignalHunt(clientId, {');
    expect(body).toContain('maxLeads: proofLimit');
    expect(body).toContain('maxPaidQueries: proofLimit');
    expect(body).toContain('const saved = await saveSignalLeads(clientId, leads);');
    expect(body).toContain('signal_package');
    expect(body).toContain('messages_delta');
    expect(body).toContain('approvals_delta');
    expect(body).toContain('send_queue_delta');
    expect(body).not.toContain('directorExecute');
    expect(body).not.toContain('rangerReview');
  });
});
