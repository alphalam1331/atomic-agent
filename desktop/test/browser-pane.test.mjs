import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {browserPaneHTML, browserPaneBounds} = require('../renderer/browser-pane.js');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const state = (mode='agent') => ({mode, visible:true, activeTabId:'tab-1', tabs:[
  {tabId:'tab-1', url:'https://example.test/login', title:'Sign in', loading:false, canGoBack:false, canGoForward:true},
]});

test('browser chrome makes takeover and resuming access explicit', () => {
  const agent = browserPaneHTML(state(), esc);
  assert.match(agent, /data-browser="takeover"/);
  assert.match(agent, /Take over to sign in/);
  assert.match(agent, /role="tab"[^>]+aria-selected="true"/);
  assert.match(agent, /data-browser="back"[^>]+disabled/);
  assert.doesNotMatch(agent, /data-browser="forward"[^>]+disabled/);
  const manual = browserPaneHTML(state('manual'), esc);
  assert.match(manual, /Agent browser access is paused/);
  assert.match(manual, /data-browser="resume"/);
  assert.match(manual, /Resume agent browser access/);
});

test('remote titles and errors are escaped and page URLs never become shell frame sources', () => {
  const page = state();
  page.tabs[0].title = '<img src=x onerror="bad()">';
  page.tabs[0].url = 'https://example.test/?secret=not-in-shell-markup';
  page.error = '<script>bad()</script>';
  const html = browserPaneHTML(page, esc);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script|<iframe|<webview|not-in-shell-markup/);
  page.tabs = []; page.activeTabId = null;
  assert.match(browserPaneHTML(page, esc), /ask the agent to browse a website/);
});

test('native bounds hide remote content under shell dialogs and in collapsed layouts', () => {
  const rect = {x:430.4, y:202.9, width:550.9, height:410.7};
  assert.deepEqual(browserPaneBounds(state(), rect, false), {x:430, y:203, width:550, height:410, visible:true});
  assert.equal(browserPaneBounds(state(), rect, true).visible, false);
  assert.equal(browserPaneBounds({...state(), visible:false}, rect, false).visible, false);
  assert.equal(browserPaneBounds(state(), {...rect, width:0}, false).visible, false);
});
