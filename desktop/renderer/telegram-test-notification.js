/* Settings can verify delivery before a task relies on Telegram reports. */
function tgTestInitial() { return {phase:'idle', text:null}; }

function tgTestUnavailable(view) {
  if (!view || view.hasToken !== true) return 'Save a bot token first.';
  if (view.owner === null || view.owner === undefined) return 'Pair your Telegram account first.';
  if (view.enabled !== true) return 'Turn on Answer in Telegram first.';
  if (view.restartOwed) return 'Restart the agent to apply your Telegram settings first.';
  if (view.channel && view.channel.state !== 'up') return 'Telegram is not connected. Check its status, then try again.';
  return null;
}

function tgTestResult(reply) {
  return reply && reply.ok === true && reply.status === 'sent'
    ? {phase:'sent', text:'Test notification sent. Check your Telegram chat with the bot.'}
    : {phase:'failed', text:reply && typeof reply.error === 'string' ? reply.error : 'Could not send the test notification. Try again.'};
}

function tgTestRowHTML(state, view, h) {
  const sending = state.phase === 'sending';
  const reason = tgTestUnavailable(view);
  const text = state.text || reason || 'Send a message to your paired account to check that task reports can reach you.';
  return '<div class="tk-setrow" data-tg-test-result="' + state.phase + '"><div class="body"><div class="t">Test notifications</div>'
    + '<div class="d" role="status" aria-live="polite">' + h.esc(text) + '</div></div>'
    + '<button class="btn btn-s sm" data-act="telegram:test"' + (sending || reason || view.busy ? ' disabled' : '') + '>'
    + (sending ? '<span class="tk-spin"></span>Sending…' : 'Send test notification') + '</button></div>';
}

if (typeof module !== 'undefined') {
  module.exports = {tgTestInitial, tgTestUnavailable, tgTestResult, tgTestRowHTML};
}
