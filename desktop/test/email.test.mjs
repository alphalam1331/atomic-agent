import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const E = require('../renderer/email.js');
const config = () => ({enabled:true, address:'agent@example.com',
  imap:{host:'imap.example.com', port:993, security:'tls', username:'incoming-user'},
  smtp:{host:'mail.example.net', port:587, security:'starttls', username:'outgoing-user'}});
const reply = () => ({ok:true, data:{config:config(), hasImapPassword:true, hasSmtpPassword:true}});
const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[c]));
const h = {esc, ic:() => ''};
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
function harness(over = {}) {
  const calls = [];
  const pane = E.createEmailPane({read:async () => reply(),
    save:async (body) => {calls.push({save:body}); return {ok:true, data:{saved:true, restartRequired:true}};},
    check:async () => {calls.push({check:true}); return {ok:true, data:{verified:true}};},
    remove:async () => {calls.push({remove:true}); return {ok:true, data:{removed:true, restartRequired:true}};}, ...over});
  return {pane, calls};
}

test('manual settings keep IMAP and SMTP independent and preserve blank saved credentials', () => {
  const draft = E.emailDraftFrom(config());
  const result = E.emailSaveBody(draft, {imap:true, smtp:true});
  assert.deepEqual(result.body, {config:config()});
  draft.imapPassword = 'incoming app password'; draft.smtpPassword = 'different-outgoing-password';
  assert.deepEqual(E.emailSaveBody(draft, {imap:false, smtp:false}).body,
    {config:config(), imapPassword:'incoming app password', smtpPassword:'different-outgoing-password'});
  assert.match(E.emailSaveBody(E.emailDraftFrom(config()), {imap:false, smtp:true}).error, /IMAP password/);
  assert.match(E.emailSaveBody(E.emailDraftFrom(config()), {imap:true, smtp:false}).error, /SMTP password/);
});

test('a new account starts enabled while an existing disabled account stays disabled', () => {
  assert.equal(E.emailDraftFrom({...config(), enabled:false, address:null}).enabled, true);
  assert.equal(E.emailDraftFrom({...config(), enabled:false}).enabled, false);
  const draft = E.emailDraftFrom(config());
  draft.imap.host = '2001:db8::1'; draft.smtp.host = '::1';
  draft.address = 'agent@intranet';
  assert.equal(E.emailSaveBody(draft, {imap:true, smtp:true}).body.config.imap.host, '2001:db8::1');
  assert.equal(E.emailSaveBody(draft, {imap:true, smtp:true}).body.config.address, 'agent@intranet');
});

test('invalid address, host, port, security and multiline credentials cannot be submitted', () => {
  for (const [field, value] of [['address','bad address'], ['imap.host','https://host/path'], ['smtp.port','65536'],
    ['imap.port','3.5'], ['smtp.security','none'], ['imap.username','user\r\nheader'], ['smtpPassword','secret\nvalue']]) {
    const draft = E.emailDraftFrom(config()), [parent, leaf] = field.split('.');
    if (leaf) draft[parent][leaf] = value; else draft[parent] = value;
    const result = E.emailSaveBody(draft, {imap:true, smtp:true});
    assert.ok(result.error, field); assert.equal(result.body, undefined);
    assert.ok(!result.error.includes(value), 'validation does not echo credential or invalid input');
  }
});

test('password fields never contain drafts in markup and repaint restores them through properties', async () => {
  const {pane} = harness(); await pane.enter();
  pane.input('imapPassword', 'incoming-secret'); pane.input('smtpPassword', 'outgoing-secret');
  await pane.enter();
  assert.equal(pane.state.draft.imapPassword, 'incoming-secret', 'clicking the selected pane preserves its draft');
  pane.input('imap.host', '<img onerror="evil">');
  const html = E.emailPaneHTML({...pane.state, restartOwed:true}, h);
  assert.doesNotMatch(html, /incoming-secret|outgoing-secret|<img onerror/);
  assert.match(html, /&lt;img onerror=&quot;evil&quot;&gt;/);
  for (const input of html.matchAll(/<input[^>]*type="password"[^>]*>/g)) assert.doesNotMatch(input[0], /value=/);
  assert.equal([...html.matchAll(/type="password"/g)].length, 2);
  const fields = new Map();
  E.emailRestorePasswords(pane.state, {querySelector:(selector) => {const field = {value:''}; fields.set(selector, field); return field;}});
  assert.equal(fields.get('[data-email-field="imapPassword"]').value, 'incoming-secret');
  assert.equal(fields.get('[data-email-field="smtpPassword"]').value, 'outgoing-secret');
  assert.equal(pane.state.draft.imapPassword, 'incoming-secret', 'repaint does not erase drafts');
  pane.close();
  assert.equal(pane.state.draft.imapPassword, ''); assert.equal(pane.state.draft.smtpPassword, '');
  await pane.enter(); assert.equal(pane.state.draft.imapPassword, '');
});

test('Save sends one validated account, clears passwords and offers a restart', async () => {
  const {pane, calls} = harness(); await pane.enter();
  pane.input('imapPassword', 'new-secret'); pane.input('smtp.username', 'separate-smtp-user');
  await pane.action('save', 7);
  assert.equal(calls.length, 1); assert.equal(calls[0].save.imapPassword, 'new-secret');
  assert.equal(calls[0].save.smtpPassword, undefined); assert.equal(calls[0].save.config.smtp.username, 'separate-smtp-user');
  assert.equal(pane.state.draft.imapPassword, ''); assert.equal(pane.state.owedGen, 7);
  assert.match(E.emailPaneHTML({...pane.state, restartOwed:true, running:false}, h), /data-act="agent:restart"/);
  assert.doesNotMatch(E.emailPaneHTML({...pane.state, restartOwed:true, running:true}, h), /data-act="agent:restart"/);
  assert.doesNotMatch(E.emailPaneHTML({...pane.state, restartOwed:false}, h), /Restart the agent to use them/);
});

test('failed saves retain drafts for correction; busy operations cannot duplicate the write', async () => {
  const pending = deferred(); let saves = 0;
  const {pane} = harness({save:async () => {saves++; return pending.promise;}});
  await pane.enter(); pane.input('imapPassword', 'keep-draft');
  const saving = pane.action('save', 2);
  await pane.action('save', 2); assert.equal(saves, 1);
  pending.resolve({ok:false, error:'Wait for the running turn to finish.'}); await saving;
  assert.equal(pane.state.draft.imapPassword, 'keep-draft');
  assert.match(pane.state.error, /running turn/); assert.equal(pane.state.owedGen, null);
});

test('late status and save responses cannot restore credentials after the pane closes', async () => {
  const read = deferred();
  const {pane} = harness({read:() => read.promise});
  const entering = pane.enter(); pane.close(); read.resolve(reply()); await entering;
  assert.equal(pane.state.open, false); assert.equal(pane.state.draft.address, '');
  const save = deferred(); const active = harness({save:() => save.promise}).pane;
  await active.enter(); active.input('imapPassword', 'closed-secret');
  const saving = active.action('save', 3); active.close();
  save.resolve({ok:true, data:{saved:true}}); await saving;
  assert.equal(active.state.draft.imapPassword, ''); assert.equal(active.state.draft.address, '');
  assert.equal(active.state.owedGen, 3, 'the saved change still needs a restart');
});

test('returning during a write waits to read its result and retains the new visit draft', async () => {
  const pending = deferred(); let saved = config(), reads = 0;
  const {pane} = harness({read:async () => {reads++; return {ok:true, data:{config:saved, hasImapPassword:true, hasSmtpPassword:true}};},
    save:async (body) => {await pending.promise; saved = body.config; return {ok:true, data:{saved:true}};}});
  await pane.enter(); pane.input('address', 'new@example.net'); pane.input('imapPassword', 'old-visit-secret');
  const saving = pane.action('save', 2); pane.close(); const entering = pane.enter();
  assert.equal(reads, 1, 'the new visit does not read pre-save settings');
  pending.resolve(); await saving; await entering;
  assert.equal(reads, 2); assert.equal(pane.state.draft.address, 'new@example.net');
  assert.equal(pane.state.draft.imapPassword, '');
  pane.input('address', 'new-visit@example.net');
  assert.equal(pane.state.draft.address, 'new-visit@example.net');
});

test('Check uses the saved account and removal requires its separate confirmation', async () => {
  const {pane, calls} = harness(); await pane.enter();
  pane.input('imapPassword', 'unsaved-secret');
  await pane.action('check', 1);
  assert.deepEqual(calls, [{check:true}]); assert.match(pane.state.message, /No email was sent/);
  await pane.action('removeConfirm', 1); assert.equal(calls.length, 1);
  await pane.action('remove', 1); assert.equal(calls.length, 1); assert.equal(pane.state.confirmRemove, true);
  await pane.action('removeConfirm', 1);
  assert.deepEqual(calls[1], {remove:true}); assert.equal(pane.state.config, null);
  assert.equal(pane.state.hasImapPassword, false); assert.equal(pane.state.draft.imapPassword, '');
});

test('Check success remains visible after the saved settings have been applied by a restart', async () => {
  const {pane} = harness(); await pane.enter();
  await pane.action('save', 1);
  await pane.action('check', 2);
  const html = E.emailPaneHTML({...pane.state, restartOwed:false, running:false}, h);
  assert.match(html, /IMAP and SMTP authentication succeeded\. No email was sent\./);
  assert.doesNotMatch(html, /Restart to apply|data-act="agent:restart"|Restart the agent to use them/);
  assert.equal(pane.state.owedGen, 1, 'check feedback does not change the saved restart debt');
});

test('Email is wired into Connections and analytics retain actions without account values', () => {
  const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.ok(source.includes("['mcp','telegram','composio','email']"));
  assert.ok(source.includes("['send','Email','Settings · Connections','','settings:email']"));
  assert.ok(source.indexOf('const EMAIL =') < source.indexOf('\nrender();'), 'controller exists before the initial render');
  assert.ok(source.includes("if (!S.settings || settingsPaneId(S.settingsPane) !== 'email') EMAIL.close()"));
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  assert.ok(index.indexOf('<script src="email.js">') < index.indexOf('<script src="renderer.js">'));
  const ctx = vm.createContext({window:{}});
  vm.runInContext(readFileSync(new URL('../renderer/analytics-acts.js', import.meta.url), 'utf8'), ctx);
  const {sanitizeAct} = vm.runInContext('ANX_ACTS', ctx);
  assert.equal(sanitizeAct('email:save:secret'), 'email:save');
  assert.equal(sanitizeAct('email:agent@example.com'), 'email');
  assert.doesNotMatch(readFileSync(new URL('../renderer/email.js', import.meta.url), 'utf8'), /localStorage|sessionStorage|console\./);
});
