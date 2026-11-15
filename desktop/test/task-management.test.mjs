import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const {taskEditFormFields, taskManagementActionsHTML} = createRequire(import.meta.url)("../renderer/task-management.js");
const esc = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
const icons = {esc, ic:name => '<svg data-icon="' + name + '"></svg>'};
const row = {id:"task-1", fullMessage:"Line one\n\n" + "a long task message ".repeat(12), userMessage:"Line one…", sessionId:"session-1", status:"pending", notify:"telegram"};

test("editing preserves the whole message and cron expression with its time zone", () => {
  const schedule = {kind:"cron", expression:"15 9 * * 1-5", tz:"Asia/Hong_Kong"};
  const fields = taskEditFormFields({...row, schedule});
  assert.deepEqual(fields, {
    editId:"task-1", manual:true, message:row.fullMessage, kind:"cron", cronExpression:schedule.expression,
    intervalSeconds:"", atIsoOrMs:"", tz:"Asia/Hong_Kong", notify:true,
  });
  assert.equal(schedule.expression, "15 9 * * 1-5");
});

test("editing interval, at and unscheduled tasks retains their original schedule kind", () => {
  const interval = taskEditFormFields({...row, schedule:{kind:"interval", everyMs:300_000}});
  assert.equal(interval.kind, "interval");
  assert.equal(interval.intervalSeconds, "300");
  const at = taskEditFormFields({...row, schedule:{kind:"at", at:1_820_000_000_123}});
  assert.equal(at.kind, "at");
  assert.equal(at.atIsoOrMs, "1820000000123");
  const immediate = taskEditFormFields({...row, schedule:null, notify:null});
  assert.equal(immediate.kind, "immediate");
  assert.equal(immediate.notify, false);
  for (const name of ["cronExpression", "intervalSeconds", "atIsoOrMs", "tz"]) assert.equal(immediate[name], "");
});

test("editing falls back to the message only when no full message was supplied", () => {
  assert.equal(taskEditFormFields({...row, fullMessage:undefined}).message, "Line one…");
  assert.equal(taskEditFormFields({...row, fullMessage:""}).message, "");
});

test("task actions follow status and never offer terminal tasks run or cancel", () => {
  const verbs = status => [...taskManagementActionsHTML({...row, status}, false, icons).matchAll(/data-act="tasks:([^:]+):/g)].map(m => m[1]);
  assert.deepEqual(verbs("pending"), ["open", "edit", "run", "cancel"]);
  assert.deepEqual(verbs("running"), ["open", "stop", "cancel"]);
  assert.deepEqual(verbs("cancelled"), ["open", "remove"]);
  for (const status of ["completed", "failed", "blocked", "unknown"]) assert.deepEqual(verbs(status), ["open"]);
});

test("pending operations disable mutation buttons while a saved session stays accessible", () => {
  const html = taskManagementActionsHTML(row, true, icons);
  assert.match(html, /tasks:open:task-1"><svg/);
  for (const verb of ["edit", "run", "cancel"]) assert.match(html, new RegExp('tasks:' + verb + ':task-1" disabled>'));
  const noSession = taskManagementActionsHTML({...row, sessionId:null}, false, icons);
  assert.match(noSession, /tasks:open:task-1" disabled>/);
  for (const [status, verb] of [["running", "stop"], ["cancelled", "remove"]]) {
    assert.match(taskManagementActionsHTML({...row, status}, true, icons), new RegExp('tasks:' + verb + ':task-1" disabled>'));
  }
});

test("task ids are escaped in every action attribute", () => {
  const html = taskManagementActionsHTML({...row, id:'task-" onclick="alert(1)<&'}, false, icons);
  assert.equal((html.match(/task-&quot; onclick=&quot;alert\(1\)&lt;&amp;/g) || []).length, 4);
  assert.doesNotMatch(html, / onclick="/);
});

test("a run still stopping cannot be stopped twice but its schedule can still be cancelled", () => {
  const html = taskManagementActionsHTML({...row, status:"running", stopping:true}, false, icons);
  assert.match(html, /tasks:stop:task-1" disabled>/);
  assert.match(html, /tasks:cancel:task-1">/);
});
