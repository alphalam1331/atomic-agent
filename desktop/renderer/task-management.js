/* Task management form fields and action availability. renderer.js owns
   transport, validation and state; these helpers preserve the saved data. */

function taskEditFormFields(row) {
  const schedule = row.schedule;
  return {
    editId: row.id,
    manual: true,
    message: row.fullMessage ?? row.userMessage ?? '',
    kind: schedule ? schedule.kind : 'immediate',
    cronExpression: schedule && schedule.kind === 'cron' ? schedule.expression : '',
    intervalSeconds: schedule && schedule.kind === 'interval' ? String(schedule.everyMs / 1000) : '',
    atIsoOrMs: schedule && schedule.kind === 'at' ? String(schedule.at) : '',
    tz: schedule && schedule.kind === 'cron' ? (schedule.tz || '') : '',
    notify: row.notify === 'telegram',
  };
}

function taskManagementActionsHTML(row, busy, {esc, ic}) {
  const id = esc(row.id);
  const button = (verb, label, icon, danger, disabled) =>
    '<button class="btn ' + (danger ? 'btn-danger' : 'btn-s') + ' sm" data-act="tasks:' + verb + ':' + id + '"'
    + (disabled ? ' disabled' : '') + '>' + (icon ? ic(icon) : '') + label + '</button>';
  let html = button('open', 'Open session', 'chat', false, !row.sessionId);
  if (row.status === 'pending') {
    html += button('edit', 'Edit task', '', false, busy)
      + button('run', 'Run now', 'play', false, busy)
      + button('cancel', 'Cancel task', '', true, busy);
  } else if (row.status === 'running') {
    html += button('stop', 'Stop run', '', true, busy || row.stopping)
      + button('cancel', 'Cancel task', '', true, busy);
  } else if (row.status === 'cancelled') {
    html += button('remove', 'Remove task', '', true, busy);
  }
  return html;
}

if (typeof module !== 'undefined') {
  module.exports = {taskEditFormFields, taskManagementActionsHTML};
}
