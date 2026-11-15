import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";

const require = createRequire(import.meta.url);
const helpers = require("../renderer/task-ask.js");
const renderer = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function source(name) {
  const pattern = new RegExp("\\n(?:async )?function " + name + "\\(");
  const at = renderer.search(pattern);
  assert.ok(at >= 0, name);
  return renderer.slice(at + 1, renderer.indexOf("\n}\n", at) + 2);
}
function fixture(config = {enabled:true, ownerUserId:12345}) {
  const calls = [], actions = [], sent = [];
  const context = createContext({
    clearTimeout,
    ...helpers, AGENT_GEN:1, TK:{mode:"create", form:null}, S:{settings:1, settingsPane:"tasks", draft:""},
    BR:{configGetKey:async () => ({ok:true, value:config}), taskCreate:async input => { calls.push(input); return {ok:true, id:"task-1"}; }},
    esc:String, ic:() => "", setSwitchHTML: o => '<button data-act="' + o.act + '" role="switch" aria-checked="' + !!o.on + '"' + (o.disabled ? ' disabled' : '') + '></button>',
    tasksVisible:() => false, tkRenderKeepCaret:() => {}, tkRepaintKeepFocus:() => {}, render:() => {},
    tkPreviewHTML:() => "", toast:() => {}, tasksRefresh:async () => {},
    tkPreview:async () => ({ok:true, message:"check the site", schedule:{kind:"cron", expression:"0 9 * * *", tz:"Asia/Hong_Kong"}}),
    act:action => actions.push(action), $:() => null,
    submit:() => { sent.push(context.S.draft); context.S.draft = ""; },
  });
  for (const name of ["tkNewForm", "tkLoadTelegram", "tkNotifyHTML", "tkFormHTML", "tkAskHTML", "tkAsk", "tkSubmit", "tasksAct"]) runInContext(source(name), context);
  context.TK.form = context.tkNewForm();
  return {context, calls, actions, sent};
}

test("both new-task forms show the Telegram choice, initially off after pairing is checked", async () => {
  const {context:c} = fixture();
  const f = c.TK.form;
  await c.tkLoadTelegram(f);
  assert.equal(f.telegramPaired, true);
  assert.equal(f.notify, false);
  for (const manual of [false, true]) {
    f.manual = manual;
    assert.match(c.tkFormHTML(), /data-act="tasks:notify" role="switch" aria-checked="false">/);
  }
  c.tasksAct("notify");
  assert.equal(f.notify, true);
  assert.match(c.tkFormHTML(), /aria-checked="true"/);
});

test("an unpaired task offers setup, preserves its fields and rechecks on return", async () => {
  const {context:c, actions} = fixture({enabled:false});
  const f = c.TK.form; f.ask = "every morning, check the site";
  await c.tkLoadTelegram(f);
  assert.match(c.tkFormHTML(), /data-act="tasks:telegram">Set up Telegram/);
  assert.match(c.tkFormHTML(), /data-act="tasks:notify"[^>]* disabled/);
  c.tasksAct("notify"); assert.equal(f.notify, false);
  c.tasksAct("telegram");
  assert.deepEqual(actions, ["settings:telegram"]);
  assert.equal(c.TK.form, f);
  assert.equal(f.ask, "every morning, check the site");
  assert.equal(f.telegramLoaded, false);
  c.BR.configGetKey = async () => ({ok:true, value:{enabled:true, ownerUserId:12345}});
  await c.tkLoadTelegram(f);
  assert.equal(f.telegramPaired, true);
  assert.equal(f.notify, false);
});

test("manual creation passes Telegram only after opt-in", async () => {
  for (const notify of [false, true]) {
    const {context:c, calls} = fixture();
    await c.tkLoadTelegram(c.TK.form);
    c.TK.form.manual = true;
    if (notify) c.tasksAct("notify");
    await c.tkSubmit();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].notify, notify ? "telegram" : undefined);
    assert.equal(calls[0].tz, "Asia/Hong_Kong");
  }
});

test("plain-words creation carries the selected report destination into the scheduling request", async () => {
  for (const notify of [false, true]) {
    const {context:c, sent} = fixture();
    await c.tkLoadTelegram(c.TK.form);
    c.TK.form.ask = "every day, check the site";
    if (notify) c.tasksAct("notify");
    c.tkAsk();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].includes('Set notify: "telegram"'), notify);
  }
});

test("a late pairing answer cannot change a newer task form", async () => {
  const {context:c} = fixture();
  let resolve;
  c.BR.configGetKey = () => new Promise(r => { resolve = r; });
  const pending = c.tkLoadTelegram(c.TK.form);
  const next = c.tkNewForm(); c.TK.form = next;
  resolve({ok:true, value:{enabled:true, ownerUserId:12345}});
  await pending;
  assert.equal(next.telegramLoaded, false);
  assert.equal(next.notify, false);
});

test("the standalone demo checks setup after rendering rather than repainting inside the form", async () => {
  const {context:c} = fixture();
  let paints = 0;
  c.BR = null;
  c.tasksVisible = () => true;
  c.tkRenderKeepCaret = () => { paints++; };
  assert.match(c.tkNotifyHTML(c.TK.form), /Checking Telegram setup/);
  assert.equal(paints, 0);
  await Promise.resolve();
  assert.equal(c.TK.form.telegramLoaded, true);
  assert.equal(paints, 1);
});

test("pairing follows the connected agent rather than an unrelated local config", async () => {
  const {context:c} = fixture({enabled:false, ownerUserId:null});
  c.BR.config = async () => ({ok:true, data:{config:{telegram:{enabled:true, ownerUserId:9876}}}});
  await c.tkLoadTelegram(c.TK.form);
  assert.equal(c.TK.form.telegramPaired, true);
  c.BR.config = async () => ({ok:false, error:'connection lost'});
  await c.tkLoadTelegram(c.TK.form);
  assert.equal(c.TK.form.telegramPaired, false, 'a failed remote read cannot fall back to a different agent');
});

test("a pairing response from a replaced agent is discarded", async () => {
  const {context:c} = fixture();
  let finish;
  c.BR.config = () => new Promise(resolve => { finish = resolve; });
  const pending = c.tkLoadTelegram(c.TK.form);
  c.AGENT_GEN++;
  finish({ok:true, data:{config:{telegram:{enabled:true, ownerUserId:9876}}}});
  await pending;
  assert.equal(c.TK.form.telegramLoaded, false);
  assert.equal(c.TK.form.telegramLoading, false);
  assert.equal(c.TK.form.telegramPaired, false);
});

test("the manual task command carries the opt-in and refuses unknown destinations", async () => {
  const cli = require("../out/main/agent-cli.js");
  const commands = [];
  const run = input => cli.withCliStandIn(async args => {
    commands.push(args);
    return {ok:true, stdout:'{"id":"task-1"}', stderr:""};
  }, () => cli.taskCreate(input));
  const base = {message:"check the site", kind:"cron", expression:"0 9 * * *", tz:"Asia/Hong_Kong"};
  assert.equal((await run(base)).ok, true);
  assert.equal(commands[0].includes("--notify"), false);
  assert.equal((await run({...base, notify:"telegram"})).ok, true);
  const flag = commands[1].indexOf("--notify");
  assert.equal(commands[1][flag + 1], "telegram");
  assert.match((await run({...base, notify:"email"})).error, /notify only supports: telegram/);
  assert.equal(commands.length, 2);
});
