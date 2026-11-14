import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const T = require('../renderer/telegram-test-notification.js');
const {readTelegramTestReply} = require('../out/main/telegram-test-notification.js');
const {AgentClient} = require('../out/main/agent-client.js');
const ts = require('typescript');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const send = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'tgTestNotification').getText(ast);
const ready = {hasToken:true, owner:42, enabled:true, restartOwed:false, channel:{state:'up'}};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[c]));

function fixture(overrides = {}, bridge = async () => ({ok:true, status:'sent'})) {
  const view = {...ready, ...overrides};
  let calls = 0;
  const c = vm.createContext({...T, TG:{busy:false, test:T.tgTestInitial(), channel:view.channel}, AGENT_GEN:1,
    tgHasToken:() => view.hasToken, tgOwner:() => view.owner, tgEnabled:() => view.enabled,
    tgRestartOwed:() => view.restartOwed, tgRepaint:() => {},
    BR:{telegramTestNotification:async () => { calls++; return bridge(); }}});
  vm.runInContext(send, c);
  return {c, view, calls:() => calls};
}

test('sending is held until token, owner, enabled channel and saved settings are ready', async () => {
  for (const missing of [{hasToken:false}, {owner:null}, {enabled:false}, {restartOwed:true}, {channel:{state:'down'}}]) {
    const f = fixture(missing);
    await f.c.tgTestNotification();
    assert.equal(f.calls(), 0);
    assert.equal(f.c.TG.test.phase, 'failed');
    assert.match(T.tgTestRowHTML(f.c.TG.test, {...ready, ...missing}, {esc}), / disabled/);
  }
  assert.equal(T.tgTestUnavailable({...ready, channel:null}), null, 'older agents can answer with an update hint');
});

test('a click sends once while pending, then confirms actual delivery', async () => {
  let finish;
  const f = fixture({}, () => new Promise((resolve) => { finish = resolve; }));
  const pending = f.c.tgTestNotification();
  assert.equal(f.c.TG.test.phase, 'sending');
  assert.match(T.tgTestRowHTML(f.c.TG.test, ready, {esc}), /disabled.*Sending…/);
  await f.c.tgTestNotification();
  assert.equal(f.calls(), 1);
  finish({ok:true, status:'sent'});
  await pending;
  assert.equal(f.c.TG.test.phase, 'sent');
  assert.match(f.c.TG.test.text, /Check your Telegram chat/);
});

test('failed delivery can be retried, and its text is escaped in the settings row', async () => {
  const f = fixture({}, async () => ({ok:false, error:'Telegram refused <message>'}));
  await f.c.tgTestNotification();
  assert.equal(f.c.TG.test.phase, 'failed');
  const html = T.tgTestRowHTML(f.c.TG.test, ready, {esc});
  assert.match(html, /Telegram refused &lt;message&gt;/);
  assert.ok(!html.includes(' disabled'));
  await f.c.tgTestNotification();
  assert.equal(f.calls(), 2);
});

test('bridge failure settles and a result for changed settings is discarded', async () => {
  const failed = fixture({}, async () => { throw new Error('transport lost'); });
  await failed.c.tgTestNotification();
  assert.equal(failed.c.TG.test.phase, 'failed');
  for (const change of ['owner', 'agent', 'settings']) {
    let finish;
    const f = fixture({}, () => new Promise((resolve) => { finish = resolve; }));
    const pending = f.c.tgTestNotification();
    if (change === 'owner') f.view.owner = 99;
    if (change === 'agent') f.c.AGENT_GEN++;
    if (change === 'settings') f.view.restartOwed = true;
    finish({ok:true, status:'sent'});
    await pending;
    assert.equal(f.c.TG.test.phase, 'idle');
  }
});

test('HTTP replies require confirmed delivery and explain an older agent', () => {
  assert.deepEqual(readTelegramTestReply(200, '{"ok":true,"status":"sent"}'), {ok:true, status:'sent'});
  for (const body of ['', 'not json', '{}', '{"ok":true,"status":"queued"}']) {
    assert.equal(readTelegramTestReply(200, body).ok, false);
  }
  assert.equal(readTelegramTestReply(404, '').unsupported, true);
  assert.deepEqual(readTelegramTestReply(409, '{"error":{"message":"Pair first.","code":"telegram_not_paired"}}'),
    {ok:false, error:'Pair first.', code:'telegram_not_paired'});
});

test('AgentClient posts with auth to its connected agent without taking a message or recipient', async () => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({method:req.method, url:req.url, auth:req.headers.authorization, body});
    res.writeHead(200, {'content-type':'application/json'});
    res.end('{"ok":true,"status":"sent"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new AgentClient('/tmp');
    client.port = server.address().port;
    client.setRemote({url:`http://127.0.0.1:${server.address().port}`, token:'test-agent-key'});
    assert.deepEqual(await client.telegramTestNotification(), {ok:true, status:'sent'});
    assert.deepEqual(calls, [{method:'POST', url:'/api/telegram/test-notification', auth:'Bearer test-agent-key', body:''}]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
