/* Settings › Connections › Email. Provider-independent IMAP/SMTP settings.
   Password drafts live only in memory and are restored as input properties,
   never HTML attributes. No storage, analytics or network calls here. */
function emailDraftFrom(config) {
  const server = (value, port) => ({host:typeof value?.host === 'string' ? value.host : '',
    port:String(value?.port || port), security:value?.security === 'starttls' ? 'starttls' : 'tls',
    username:typeof value?.username === 'string' ? value.username : ''});
  return {enabled:config?.address ? config.enabled === true : true,
    address:typeof config?.address === 'string' ? config.address : '',
    imap:server(config?.imap, 993), smtp:server(config?.smtp, 465), imapPassword:'', smtpPassword:''};
}

function emailHostValid(host) {
  if (!host || /[\s/@\\?#\u0000-\u001f\u007f]/.test(host)) return false;
  if (!host.includes(':')) return !/[\[\]]/.test(host);
  try { new URL('https://[' + host + ']/'); return true; } catch { return false; }
}

function emailSaveBody(draft, credentials) {
  const address = String(draft.address || '').trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) return {error:'Enter the email address for this account.'};
  const config = {enabled:!!draft.enabled, address};
  for (const protocol of ['imap', 'smtp']) {
    const server = draft[protocol], label = protocol.toUpperCase();
    const host = String(server?.host || '').trim(), username = String(server?.username || '').trim();
    if (!emailHostValid(host)) return {error:'Enter the ' + label + ' server hostname or IP address without a URL or port.'};
    if (!/^\d+$/.test(String(server.port)) || Number(server.port) < 1 || Number(server.port) > 65535) return {error:'Enter an ' + label + ' port from 1 to 65535.'};
    if (!['tls', 'starttls'].includes(server.security)) return {error:'Choose TLS or STARTTLS for ' + label + '.'};
    if (!username || /[\r\n\u0000]/.test(username)) return {error:'Enter the ' + label + ' username.'};
    const password = draft[protocol + 'Password'];
    if (!password && !credentials[protocol]) return {error:'Enter the ' + label + ' password or app password.'};
    if (password && /[\r\n\u0000]/.test(password)) return {error:label + ' passwords must be a single line.'};
    config[protocol] = {host, port:Number(server.port), security:server.security, username};
  }
  const body = {config};
  for (const protocol of ['imap', 'smtp']) if (draft[protocol + 'Password']) body[protocol + 'Password'] = draft[protocol + 'Password'];
  return {body};
}

function createEmailPane(io) {
  const state = {open:false, loaded:false, busy:null, draft:emailDraftFrom(null), config:null,
    hasImapPassword:false, hasSmtpPassword:false, error:null, message:null, messageNeedsRestart:false, owedGen:null, confirmRemove:false};
  let visit = 0, operation = null;
  const changed = () => { if (state.open && io.changed) io.changed(); };
  function close() {
    if (!state.open) return;
    state.open = false; visit++;
    state.draft = emailDraftFrom(null); state.confirmRemove = false;
  }
  async function enter(force) {
    if (state.open && !force) return;
    state.open = true; state.loaded = false; state.error = null; state.confirmRemove = false;
    const current = ++visit;
    changed();
    // A return visit must read after an earlier Save/Remove finishes, so a
    // status response from before that write cannot replace the new account.
    if (operation) await operation;
    if (!state.open || current !== visit) return;
    let result;
    try { result = await io.read(); } catch { result = null; }
    if (!state.open || current !== visit) return;
    if (!result?.ok || !result.data?.config) {
      state.error = result?.error || 'Could not read the email settings. Start or update the agent, then try again.';
      state.loaded = false;
    } else {
      state.config = result.data.config;
      state.draft = emailDraftFrom(state.config);
      state.hasImapPassword = result.data.hasImapPassword === true;
      state.hasSmtpPassword = result.data.hasSmtpPassword === true;
      state.loaded = true;
    }
    changed();
  }
  function input(field, value) {
    if (state.busy || !state.loaded) return;
    const parts = field.split('.');
    if (parts.length === 2 && ['imap', 'smtp'].includes(parts[0]) && ['host', 'port', 'security', 'username'].includes(parts[1])) state.draft[parts[0]][parts[1]] = value;
    else if (['address', 'imapPassword', 'smtpPassword'].includes(field)) state.draft[field] = value;
    state.error = null; state.message = null; state.confirmRemove = false;
  }
  async function action(verb, generation) {
    if (state.busy || !state.open) return;
    if (verb === 'refresh') return enter(true);
    if (!state.loaded) return;
    if (verb === 'enable') { state.draft.enabled = !state.draft.enabled; state.message = null; changed(); return; }
    if (verb === 'removeCancel') { state.confirmRemove = false; changed(); return; }
    if (verb === 'remove') { state.confirmRemove = true; changed(); return; }
    if (!['save', 'check', 'removeConfirm'].includes(verb)) return;
    if (verb === 'removeConfirm' && !state.confirmRemove) return;
    let body;
    if (verb === 'save') {
      const result = emailSaveBody(state.draft, {imap:state.hasImapPassword, smtp:state.hasSmtpPassword});
      if (result.error) { state.error = result.error; changed(); return; }
      body = result.body;
    }
    const current = visit;
    let release;
    operation = new Promise(resolve => { release = resolve; });
    state.busy = verb; state.error = null; state.message = null; changed();
    let result;
    try { result = await (verb === 'save' ? io.save(body) : verb === 'check' ? io.check() : io.remove()); }
    catch { result = null; }
    state.busy = null;
    if (!result?.ok) {
      if (state.open && current === visit) state.error = result?.error || 'Could not ' + (verb === 'removeConfirm' ? 'remove' : verb) + ' the email account.';
    } else if (verb === 'check') {
      if (state.open && current === visit) {
        state.message = 'IMAP and SMTP authentication succeeded. No email was sent.';
        state.messageNeedsRestart = false;
      }
    }
    else {
      state.owedGen = generation;
      state.message = verb === 'save' ? 'Email settings saved. Restart the agent to use them.' : 'Email account removed. Restart the agent to apply the change.';
      state.messageNeedsRestart = true;
      state.confirmRemove = false;
      if (verb === 'save') {
        state.config = body.config;
        state.hasImapPassword = !!body.imapPassword || state.hasImapPassword;
        state.hasSmtpPassword = !!body.smtpPassword || state.hasSmtpPassword;
      } else { state.config = null; state.hasImapPassword = false; state.hasSmtpPassword = false; }
      if (state.open && current === visit) state.draft = emailDraftFrom(state.config);
    }
    operation = null; release();
    changed();
  }
  return {state, enter, close, input, action};
}

function emailRestorePasswords(state, root) {
  for (const protocol of ['imap', 'smtp']) {
    const field = root.querySelector('[data-email-field="' + protocol + 'Password"]');
    if (field) field.value = state.draft[protocol + 'Password'];
  }
}

function emailPaneHTML(st, h) {
  const disabled = st.busy ? ' disabled' : '';
  const notice = (text, red) => '<div class="tk-notice tk-notice--' + (red ? 'red' : 'blue') + '" role="status"><span class="grow">' + h.esc(text) + '</span></div>';
  const field = (name, label, value, type, placeholder) => '<div class="tk-field sd-frow"><label class="tk-lbl" for="email-' + name + '">' + label + '</label>'
    + '<input class="tk-inp" id="email-' + name + '" data-email-field="' + name + '" type="' + (type || 'text') + '"'
    + (type === 'password' ? '' : ' value="' + h.esc(value) + '"') + (placeholder ? ' placeholder="' + h.esc(placeholder) + '"' : '')
    + ' autocomplete="off" spellcheck="false"' + (type === 'number' ? ' min="1" max="65535" step="1"' : '') + disabled + '></div>';
  let body = '<div class="tk-card pad"><h3 class="sd-title">Agent email account</h3><p>Connect the account you created for the agent. Use the IMAP and SMTP settings from your email provider. The agent can read messages and send email as this address.</p></div>';
  if (!st.loaded) return '<div class="sd-pane sd-email">' + body + (st.error ? notice(st.error, true) + '<button class="btn btn-s sm" data-act="email:refresh">Try again</button>' : '<div class="tk-empty"><span class="tk-spin"></span><p>Loading…</p></div>') + '</div>';
  body += '<div class="tk-card sd-rows"><div class="tk-setrow"><div class="body"><div class="t">Use email</div><div class="d">Save and restart to apply this setting.</div></div>'
    + '<button class="tk-switch' + (st.draft.enabled ? ' on' : '') + '" role="switch" aria-checked="' + st.draft.enabled + '" aria-label="Use email" data-act="email:enable"' + disabled + '></button></div></div>';
  body += '<div class="sd-form">' + field('address', 'Email address', st.draft.address, 'email', 'agent@example.com');
  for (const protocol of ['imap', 'smtp']) {
    const server = st.draft[protocol], label = protocol.toUpperCase(), hasPassword = st[protocol === 'imap' ? 'hasImapPassword' : 'hasSmtpPassword'];
    body += '<div class="tk-card pad"><h3 class="sd-title">' + (protocol === 'imap' ? 'Incoming mail · IMAP' : 'Outgoing mail · SMTP') + '</h3><div class="sd-form">'
      + field(protocol + '.host', label + ' server', server.host, 'text', protocol + '.example.com')
      + field(protocol + '.port', label + ' port', server.port, 'number')
      + '<div class="tk-field sd-frow"><label class="tk-lbl" for="email-' + protocol + '-security">' + label + ' encryption</label>'
      + '<select class="tk-inp" id="email-' + protocol + '-security" data-email-field="' + protocol + '.security"' + disabled + '>'
      + ['tls', 'starttls'].map((v) => '<option value="' + v + '"' + (server.security === v ? ' selected' : '') + '>' + (v === 'tls' ? 'TLS (encrypted from connection)' : 'STARTTLS (required upgrade)') + '</option>').join('') + '</select></div>'
      + field(protocol + '.username', label + ' username', server.username, 'text', 'Usually the full email address')
      + field(protocol + 'Password', label + ' password or app password', '', 'password', hasPassword ? 'Saved · leave blank to keep it' : 'Enter password or app password')
      + '</div></div>';
  }
  body += '</div><p class="tk-help">Passwords are stored on this computer. A blank password keeps the saved password. Use an app password if your provider requires one.</p>'
    + '<div class="sd-acts"><button class="btn btn-p sm" data-act="email:save"' + disabled + '>' + (st.busy === 'save' ? 'Saving…' : 'Save') + '</button>'
    + '<button class="btn btn-s sm" data-act="email:check"' + (st.busy || !st.config?.address || !st.config.enabled ? ' disabled' : '') + '>' + (st.busy === 'check' ? 'Checking…' : 'Check saved connection') + '</button>'
    + '<span class="grow"></span>' + (st.config?.address ? '<button class="btn btn-danger sm" data-act="email:remove"' + disabled + '>Remove account</button>' : '') + '</div>'
    + '<p class="tk-help">Save with Use email on before checking. Check verifies both saved servers without sending a message.</p>';
  if (st.confirmRemove) body += '<div class="tk-notice tk-notice--amber"><span class="grow">Remove the saved account and both passwords?</span><button class="btn btn-g sm" data-act="email:removeCancel"' + disabled + '>Cancel</button><button class="btn btn-danger sm" data-act="email:removeConfirm"' + disabled + '>Confirm removal</button></div>';
  if (st.error) body += notice(st.error, true);
  if (st.message && (!st.messageNeedsRestart || st.restartOwed)) body += notice(st.message, false);
  if (st.restartOwed) body += '<div class="tk-notice tk-notice--blue"><span class="grow">Restart to apply the email settings.</span>'
    + (st.running ? '<span class="sd-cap">Restart when the running reply is done.</span>' : '<button class="btn btn-t sm" data-act="agent:restart">' + h.ic('refresh') + 'Restart Agent Runtime</button>') + '</div>';
  return '<div class="sd-pane sd-email">' + body + '</div>';
}

if (typeof module !== 'undefined') module.exports = {emailDraftFrom, emailSaveBody, createEmailPane, emailRestorePasswords, emailPaneHTML};
