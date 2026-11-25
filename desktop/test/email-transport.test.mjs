import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {AgentClient} = require('../out/main/agent-client.js');
const {validateEvent} = require('../out/main/analytics/validate.js');

test('email routes use the authenticated agent transport and preserve server refusal messages', async () => {
  const seen = []; let conflict = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({method:req.method, path:req.url, auth:req.headers.authorization, body:raw ? JSON.parse(raw) : null});
    res.writeHead(conflict ? 409 : 200, {'content-type':'application/json'});
    res.end(JSON.stringify(conflict ? {error:{message:'Wait for the running turn to finish.'}} : {verified:true}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new AgentClient(process.cwd());
  client.port = server.address().port; client.token = 'email-test-token';
  try {
    const body = {config:{address:'agent@example.com'}, imapPassword:'test-password'};
    await client.emailStatus(); await client.emailSave(body); await client.emailCheck(); await client.emailRemove();
    assert.deepEqual(seen, [
      {method:'GET', path:'/api/email', auth:'Bearer email-test-token', body:null},
      {method:'PUT', path:'/api/email', auth:'Bearer email-test-token', body},
      {method:'POST', path:'/api/email/check', auth:'Bearer email-test-token', body:null},
      {method:'DELETE', path:'/api/email', auth:'Bearer email-test-token', body:null},
    ]);
    conflict = true;
    await assert.rejects(client.emailSave(body), /Wait for the running turn to finish/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('the Email settings analytics allowlist carries no account or credential fields', () => {
  assert.deepEqual(validateEvent('settings_pane_viewed', {pane:'email', ms_on_pane:5, address:'agent@example.com', password:'secret'}, 'ui').props,
    {pane:'email', ms_on_pane:5});
});
