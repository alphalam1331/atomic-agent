import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const helper = require('../renderer/task-management.js');
const reports = require('../renderer/task-ask.js');
const {validateCreateForm} = require('../out/main/task-schedule.js');
const ts = require('typescript');
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
const ast = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name?.text, n.getText(ast)]));
const longMessage = 'Check the project carefully. '.repeat(12) + '\nKeep this second line intact.';
const record = (over = {}) => ({id:'task-1', status:'pending', userMessage:longMessage, sessionId:'chat-1',
  schedule:{kind:'cron', expression:'0 9 * * 1-5', tz:'Asia/Hong_Kong'}, recurring:true, notify:'telegram', ...over});
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[c]));

function fixture(raw = record()) {
  const calls = [], actions = [];
  const c = vm.createContext({...helper, ...reports, clearTimeout, setTimeout, Date,
    AGENT_GEN:1, TK:{rows:[], form:null, mode:'detail', detailId:raw.id, action:null, remove:null, stopping:new Set()},
    S:{settings:1, settingsPane:'tasks'},
    BR:{
      taskPreview:async form => ({ok:true, ...validateCreateForm(form, Date.now())}),
      updateTask:async (id, patch) => { calls.push(['update', id, patch]); return {ok:true, data:{id, ...patch}}; },
      stopTask:async id => { calls.push(['stop', id]); return {ok:true, data:{task:{id, status:'pending'}, stopping:false}}; },
      removeTask:async id => { calls.push(['remove', id]); return {ok:true, data:{removed:true, id}}; },
      config:async () => ({ok:true, data:{config:{telegram:{enabled:false, ownerUserId:null}}}}),
    },
    esc, ic:() => '', formatScheduleLabel:s => s?.kind || 'once',
    document:{getElementById:() => null}, tkTyping:() => false,
    render:() => {}, tkRepaintKeepFocus:() => {}, tasksVisible:() => false,
    tasksRefresh:async () => { actions.push('refresh'); }, toast:() => {},
    act:() => {},
  });
  for (const name of ['tkRow','tkNewForm','tkEdit','tkSubmit','tkManage','tkLoadTelegram','tkPreview','tasksAct','tkFormHTML','tkPreviewHTML','tkRemoveModal']) {
    vm.runInContext(functions.get(name), c);
  }
  c.TK.rows = [c.tkRow(raw)];
  return {c, calls, actions};
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('normalization and editing preserve the full multiline message and raw schedule', async () => {
  const {c} = fixture();
  assert.equal(c.TK.rows[0].userMessage.length, 96);
  c.tkEdit('task-1');
  await flush();
  assert.equal(c.TK.form.message, longMessage);
  assert.equal(c.TK.form.cronExpression, '0 9 * * 1-5');
  assert.equal(c.TK.form.tz, 'Asia/Hong_Kong');
  assert.equal(c.TK.form.preview.ok, true);
});

test('saving edits updates the same task and preserves an existing report destination when setup is unavailable', async () => {
  const {c, calls} = fixture();
  c.tkEdit('task-1'); await flush();
  await c.tkLoadTelegram(c.TK.form);
  assert.equal(c.TK.form.telegramPaired, false);
  assert.equal(c.TK.form.notify, true);
  const saved = await c.tkSubmit();
  assert.equal(saved.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'update');
  assert.equal(calls[0][1], 'task-1');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), {userMessage:longMessage,
    schedule:{kind:'cron', expression:'0 9 * * 1-5', tz:'Asia/Hong_Kong'}, notify:'telegram'});
  assert.equal(c.TK.mode, 'detail');
  assert.equal(c.TK.detailId, 'task-1');
  assert.equal(c.TK.form, null);
});

test('an unscheduled task can be edited without adding a schedule or enabling reports', async () => {
  const {c, calls} = fixture(record({schedule:null, recurring:false, notify:null}));
  c.tkEdit('task-1'); await flush();
  assert.equal(c.TK.form.kind, 'immediate');
  assert.equal((await c.tkSubmit()).ok, true);
  assert.equal(calls[0][2].schedule, null);
  assert.equal(calls[0][2].notify, null);
});

test('editing retains a persisted interval with millisecond precision', async () => {
  const {c, calls} = fixture(record({schedule:{kind:'interval', everyMs:1500}}));
  c.tkEdit('task-1'); await flush();
  assert.equal(c.TK.form.intervalSeconds, '1.5');
  assert.equal((await c.tkSubmit()).ok, true);
  assert.equal(calls[0][2].schedule.everyMs, 1500);
});

test('pending form validation prevents duplicate saves and stops a dismissed or replaced-agent form from writing', async () => {
  for (const change of ['dismiss', 'agent']) {
    const {c, calls} = fixture();
    c.tkEdit('task-1'); await flush();
    let finish;
    c.BR.taskPreview = () => new Promise(resolve => { finish = resolve; });
    const saved = c.tkSubmit();
    assert.equal(c.TK.form.submitting, true);
    assert.equal((await c.tkSubmit()).ok, false);
    if (change === 'dismiss') c.tasksAct('back'); else c.AGENT_GEN++;
    finish({ok:true, ...validateCreateForm({...helper.taskEditFormFields(record())}, Date.now())});
    assert.equal((await saved).ok, false);
    assert.equal(calls.length, 0);
  }
});

test('older previews cannot replace a newer form revision', async () => {
  const {c} = fixture(); c.tkEdit('task-1'); await flush();
  const pending = [];
  c.BR.taskPreview = () => new Promise(resolve => pending.push(resolve));
  const old = c.tkPreview();
  c.TK.form.revision++;
  const fresh = c.tkPreview();
  pending[1]({ok:true, preview:{ok:true, error:null, nextFirings:[123]}, schedule:{kind:'interval', everyMs:60000}});
  await fresh;
  pending[0]({ok:true, preview:{ok:false, error:'old error', nextFirings:[]}, schedule:null});
  assert.equal(await old, null);
  assert.equal(c.TK.form.preview.ok, true);
  assert.equal(c.TK.form.preview.nextFirings[0], 123);
});

test('stopping a recurring run uses Stop and leaves Cancel separate; slow stopping stays visible', async () => {
  const {c, calls} = fixture(record({status:'running'}));
  await c.tkManage('stop', 'task-1');
  assert.deepEqual(calls, [['stop', 'task-1']]);
  assert.match(c.TK.msg, /next scheduled run is kept/);
  c.BR.stopTask = async () => ({ok:true, data:{task:{status:'running'}, stopping:true}});
  await c.tkManage('stop', 'task-1');
  assert.equal(c.TK.stopping.has('task-1'), true);
  assert.match(c.TK.msg, /Waiting/);
});

test('removing a cancelled task requires confirmation and returns to the list with its chat kept', async () => {
  const {c, calls} = fixture(record({status:'cancelled'}));
  c.tasksAct('remove:task-1');
  assert.equal(calls.length, 0);
  assert.match(c.tkRemoveModal(), /chat history is kept/);
  await c.tkManage('remove', c.TK.remove);
  assert.deepEqual(calls, [['remove', 'task-1']]);
  assert.equal(c.TK.mode, 'list');
  assert.equal(c.TK.remove, null);
  assert.match(c.TK.msg, /chat history is kept/);
});

test('invalid state controls and repeated in-flight operations do not dispatch requests', async () => {
  const {c, calls} = fixture();
  await c.tkManage('remove', 'task-1');
  await c.tkManage('stop', 'task-1');
  assert.equal(calls.length, 0);
  c.TK.rows[0].status = 'cancelled';
  let finish;
  c.BR.removeTask = () => new Promise(resolve => { finish = resolve; });
  const removed = c.tkManage('remove', 'task-1');
  assert.ok(c.TK.action);
  await c.tkManage('remove', 'task-1');
  finish({ok:false, error:'Wait for the running turn to stop.'});
  await removed;
  assert.equal(c.TK.action, null);
  assert.match(c.TK.err, /Wait/);
});
