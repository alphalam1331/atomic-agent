/* The shell draws browser chrome; remote content lives in a separate native
   WebContentsView with no shell preload. No website HTML enters this document. */
const BROWSER_PANE = {state:null, error:'', scheduled:false, lastBounds:'', booted:false};

function browserPaneHTML(state, esc) {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const active = tabs.find((t) => t.tabId === state.activeTabId);
  const manual = state.mode === 'manual';
  const button = (action, label, text, disabled) => '<button type="button" data-browser="' + action
    + '" aria-label="' + label + '" title="' + label + '"' + (disabled ? ' disabled' : '') + '>' + text + '</button>';
  return '<header class="bp-heading"><strong>Browser</strong><span>Agent profile</span>'
    + button('hide', 'Hide browser', '×') + '</header>'
    + '<div class="bp-tabs" role="tablist" aria-label="Browser tabs">'
    + tabs.map((t) => '<div class="bp-tab' + (t.tabId === state.activeTabId ? ' active' : '') + '">'
      + '<button type="button" role="tab" data-browser="switch" data-tab="' + esc(t.tabId) + '" aria-selected="'
      + (t.tabId === state.activeTabId) + '" title="' + esc(t.title || t.url || 'New tab') + '">'
      + esc(t.title || (t.url === 'about:blank' ? 'New tab' : t.url) || 'New tab') + '</button>'
      + '<button type="button" data-browser="close" data-tab="' + esc(t.tabId) + '" aria-label="Close tab">×</button></div>').join('')
    + button('new', 'New browser tab', '+') + '</div>'
    + '<form class="bp-nav" id="browser-address-form">'
    + button('back', 'Go back', '←', !active || !active.canGoBack)
    + button('forward', 'Go forward', '→', !active || !active.canGoForward)
    + button(active && active.loading ? 'stop' : 'reload', active && active.loading ? 'Stop loading' : 'Reload page', active && active.loading ? '×' : '↻', !active)
    + '<input id="browser-address" aria-label="Website address" autocomplete="off" spellcheck="false" placeholder="Enter a website address">'
    + '<button type="submit" aria-label="Go to address">Go</button></form>'
    + '<div class="bp-control' + (manual ? ' manual' : '') + '" role="status"><span>'
    + (manual ? 'You control the browser. Agent browser access is paused.' : 'Agent control · Take over to sign in or browse.')
    + '</span>' + button(manual ? 'resume' : 'takeover', manual ? 'Resume agent browser access' : 'Take over browser', manual ? 'Resume agent' : 'Take over') + '</div>'
    + '<div class="bp-error" role="alert"' + (state.error ? '' : ' hidden') + '>' + esc(state.error || '') + '</div>'
    + '<div id="browser-viewport"><div class="bp-empty">' + (tabs.length ? 'Loading browser…' : 'Open a tab, or ask the agent to browse a website.') + '</div></div>';
}

function browserPaneOpen() { return !!(BROWSER_PANE.state && BROWSER_PANE.state.visible); }

function browserPanePaint() {
  const el = document.getElementById('browserpane');
  if (!el || !BROWSER_PANE.state) return;
  const address = el.querySelector('#browser-address');
  const focused = address && document.activeElement === address;
  const held = focused ? {value:address.value, start:address.selectionStart, end:address.selectionEnd} : null;
  const state = Object.assign({}, BROWSER_PANE.state, {error:BROWSER_PANE.error || BROWSER_PANE.state.error});
  el.hidden = !state.visible;
  el.innerHTML = browserPaneHTML(state, esc);
  const input = el.querySelector('#browser-address');
  const active = state.tabs.find((t) => t.tabId === state.activeTabId);
  input.value = held ? held.value : active && active.url !== 'about:blank' ? active.url : '';
  if (held) { input.focus(); input.setSelectionRange(held.start, held.end); }
  browserPaneSchedule();
}

async function browserPaneCommand(command) {
  if (!BR || !BR.browserCommand) return;
  try {
    const reply = await BR.browserCommand(command);
    if (!reply || !reply.ok) throw new Error(reply && reply.error || 'The browser is unavailable.');
    BROWSER_PANE.error = '';
    BROWSER_PANE.state = reply.data;
  } catch (error) { BROWSER_PANE.error = error.message || 'The browser is unavailable.'; }
  browserPanePaint();
  if (typeof renderToolbar === 'function') renderToolbar();
}

function browserPaneToggle() { return browserPaneCommand({action:browserPaneOpen() ? 'hide' : 'show'}); }

/* Native content sits above DOM overlays. Hide it while shell dialogs, settings,
   palettes, onboarding or preview overlays are drawn, and restore after them. */
function browserPaneBounds(state, rect, obstructed) {
  return {x:Math.max(0, Math.round(rect.x)), y:Math.max(0, Math.round(rect.y)),
    width:Math.max(0, Math.floor(rect.width)), height:Math.max(0, Math.floor(rect.height)),
    visible:!!state && state.visible && !obstructed && rect.width > 0 && rect.height > 0};
}

function browserPaneSync() {
  BROWSER_PANE.scheduled = false;
  if (!BR || !BR.browserBounds || !BROWSER_PANE.state) return;
  const viewport = document.getElementById('browser-viewport');
  if (!viewport) return;
  const obstructed = !!(S.settings || S.overlay || S.alert || S.pal || S.imgViewer
    || document.querySelector('#onboarding, .image-viewer, .screen-overlay, .wsnap-overlay')
    || document.querySelector('#overlays')?.childElementCount);
  const bounds = browserPaneBounds(BROWSER_PANE.state, viewport.getBoundingClientRect(), obstructed);
  const key = JSON.stringify(bounds);
  if (key === BROWSER_PANE.lastBounds) return;
  BROWSER_PANE.lastBounds = key;
  void BR.browserBounds(bounds).catch(() => { BROWSER_PANE.lastBounds = ''; });
}

function browserPaneSchedule() {
  if (BROWSER_PANE.scheduled) return;
  BROWSER_PANE.scheduled = true;
  requestAnimationFrame(browserPaneSync);
}

function browserPaneBoot() {
  if (BROWSER_PANE.booted || !BR || !BR.browserState) return;
  BROWSER_PANE.booted = true;
  const el = document.getElementById('browserpane');
  if (!el) return;
  el.addEventListener('click', (event) => {
    const button = event.target.closest('[data-browser]');
    if (!button) return;
    event.preventDefault();
    void browserPaneCommand({action:button.dataset.browser, ...(button.dataset.tab ? {tabId:button.dataset.tab} : {})});
  });
  el.addEventListener('submit', (event) => {
    if (event.target.id !== 'browser-address-form') return;
    event.preventDefault();
    const input = el.querySelector('#browser-address');
    const value = input.value.trim();
    if (value) void browserPaneCommand({action:'navigate', url:/^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value});
  });
  BR.onBrowserState((state) => {
    if (JSON.stringify(BROWSER_PANE.state) === JSON.stringify(state)) return;
    BROWSER_PANE.state = state;
    browserPanePaint();
    if (typeof renderToolbar === 'function') renderToolbar();
  });
  void BR.browserState().then((reply) => {
    if (reply && reply.ok) { BROWSER_PANE.state = reply.data; browserPanePaint(); renderToolbar(); }
  });
  new ResizeObserver(browserPaneSchedule).observe(document.getElementById('main'));
  new MutationObserver(browserPaneSchedule).observe(document.getElementById('window'), {childList:true, subtree:true, attributes:true, attributeFilter:['class', 'hidden', 'style']});
  window.addEventListener('resize', browserPaneSchedule);
  window.addEventListener('beforeunload', () => { void BR.browserBounds({x:0, y:0, width:0, height:0, visible:false}); });
}

if (typeof module !== 'undefined') module.exports = {browserPaneHTML, browserPaneBounds};
