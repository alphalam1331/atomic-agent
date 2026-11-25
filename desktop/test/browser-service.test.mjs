import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopBrowserService, isBrowserNavigationUrl } = require('../out/main/browser-service.js');

function fixture(options = {}) {
  const session = new EventEmitter();
  session.setPermissionRequestHandler = fn => { session.permissionRequest = fn; };
  session.setPermissionCheckHandler = fn => { session.permissionCheck = fn; };
  session.setDevicePermissionHandler = fn => { session.devicePermission = fn; };
  session.webRequest = { onBeforeRequest: (_filter, fn) => { session.beforeRequest = fn; } };
  session.flushStorageData = () => { session.flushed = true; };
  const views = []; const states = [];
  const service = new DesktopBrowserService({
    browserSession: session, commandTimeoutMs: options.commandTimeoutMs ?? 1000,
    onState: state => states.push(state),
    createView() {
      const contents = new EventEmitter();
      Object.assign(contents, {
        id: views.length + 100, url: '', title: '', loading: false, destroyed: false, stopped: 0,
        getURL: () => contents.url, getTitle: () => contents.title, isLoading: () => contents.loading,
        isDestroyed: () => contents.destroyed, stop: () => { contents.stopped++; },
        loadURL: async url => { contents.url = url; contents.emit('did-navigate'); },
        reload: () => { contents.reloaded = true; },
        setWindowOpenHandler: fn => { contents.openHandler = fn; },
        close: () => { contents.destroyed = true; contents.emit('destroyed'); },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      });
      const mainFrame = { url: '', processId: 1, routingId: 2, frameTreeNodeId: 3, parent: null, frameToken: 'fixture-main-frame', detached: false, executeJavaScript: async script => { mainFrame.lastScript = script; } };
      mainFrame.framesInSubtree = [mainFrame]; contents.mainFrame = mainFrame;
      let attached = false;
      contents.debugger = {
        isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
        sendCommand: async (method, params) => { contents.commands ??= []; contents.commands.push({ method, params }); return options.sendCommand?.(method, params, contents) ?? { ok: true }; },
      };
      const view = { webContents: contents, setBounds: rect => { view.rect = rect; }, setVisible: value => { view.visible = value; } };
      views.push(view); return view;
    },
  });
  const children = new Set();
  const window = {
    isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getContentBounds: () => ({ width: 1000, height: 800 }),
    webContents: { getZoomFactor: () => 1.25 },
    contentView: { addChildView: view => children.add(view), removeChildView: view => children.delete(view) },
  };
  service.attachWindow(window);
  service.bounds({ x: 500, y: 100, width: 500, height: 700 });
  const begin = async () => {
    const env = await service.start();
    const rpc = async (input, headers = {}) => {
      const response = await fetch(env.ATOMIC_AGENT_BROWSER_ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ATOMIC_AGENT_BROWSER_TOKEN}`, ...headers }, body: JSON.stringify(input),
      });
      return { status: response.status, ...(await response.json()) };
    };
    return { env, rpc };
  };
  return { service, session, views, states, window, children, begin };
}

test('website navigation, permissions, downloads and resource requests fail closed', async () => {
  for (const url of ['https://example.test', 'http://127.0.0.1:1234/', 'about:blank']) assert.equal(isBrowserNavigationUrl(url), true);
  for (const url of ['file:///tmp/private', 'javascript:alert(1)', 'devtools://x', 'atomic://x', 'data:text/html,x', 'https://user:password@example.test/']) assert.equal(isBrowserNavigationUrl(url), false);
  const f = fixture();
  try {
    assert.equal(f.session.permissionCheck(), false); assert.equal(f.session.devicePermission(), false);
    let permission; f.session.permissionRequest(null, 'media', value => { permission = value; }); assert.equal(permission, false);
    let prevented = false; f.session.emit('will-download', { preventDefault: () => { prevented = true; } }); assert.equal(prevented, true);
    for (const [url, resourceType, cancel] of [['file:///secret', 'image', true], ['atomic://shell', 'mainFrame', true], ['data:text/html,x', 'subFrame', true], ['blob:https://example.test/x', 'image', false], ['https://example.test', 'subFrame', false]]) {
      f.session.beforeRequest({ url, resourceType }, result => assert.equal(result.cancel, cancel));
    }
    await f.service.command({ action: 'new' });
    const c = f.views[0].webContents;
    let blocked = false; c.emit('will-navigate', { preventDefault: () => { blocked = true; } }, 'file:///secret'); assert.equal(blocked, true);
    assert.deepEqual(c.openHandler({ url: 'file:///secret' }), { action: 'deny' });
    const popup = c.openHandler({ url: 'https://example.test/oauth' });
    assert.equal(popup.action, 'deny'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.views[1].webContents.getURL(), 'https://example.test/oauth');
    assert.equal(f.service.state().mode, 'manual'); assert.equal(f.service.state().activeTabId, f.service.state().tabs[1].tabId);
    await assert.rejects(f.service.command({ action: 'navigate', url: 'file:///secret' }), /http, https/);
  } finally { await f.service.close(); }
});

test('the bridge authenticates every request, refuses website origins and cannot target the shell', async () => {
  const f = fixture();
  try {
    const { env, rpc } = await f.begin();
    assert.match(env.ATOMIC_AGENT_BROWSER_ENDPOINT, /^http:\/\/127\.0\.0\.1:\d+\/browser$/);
    assert.equal((await rpc({ operation: 'ready' }, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await rpc({ operation: 'ready' }, { origin: 'https://evil.test' })).status, 400);
    assert.equal((await rpc({ operation: 'ready' })).status, 200);
    const { result: lease } = await rpc({ operation: 'acquire' });
    const cdp = (method, extra = {}) => rpc({ operation: 'cdp', ...lease, method, ...extra });
    assert.equal((await cdp('Runtime.evaluate', { params: { expression: 'document.title' } })).status, 200);
    assert.match((await cdp('Runtime.evaluate', { tabId: 'shell-webcontents' })).error, /does not own/);
    for (const method of ['Target.getTargets', 'Browser.getVersion', 'Storage.getCookies', 'Network.getAllCookies']) assert.match((await cdp(method)).error, /not allowed/);
    assert.match((await cdp('Page.navigate', { params: { url: 'file:///private' } })).error, /http, https/);
    assert.equal((await rpc({ operation: 'release', leaseId: lease.leaseId })).status, 200);
    assert.match((await cdp('Runtime.evaluate')).error, /expired/);
  } finally { await f.service.close(); }
});

test('manual takeover invalidates a pre-approval lease and interrupts in-flight commands', async () => {
  const f = fixture({ sendCommand: method => method === 'Runtime.evaluate' ? new Promise(() => {}) : {} });
  try {
    const { rpc } = await f.begin(); await rpc({ operation: 'ready' });
    const { result: lease } = await rpc({ operation: 'acquire' });
    const running = rpc({ operation: 'cdp', ...lease, method: 'Runtime.evaluate' });
    while (!f.views[0].webContents.debugger.isAttached()) await new Promise(resolve => setImmediate(resolve));
    await f.service.command({ action: 'takeover' });
    assert.match((await running).error, /taken over/);
    assert.equal(f.views[0].webContents.mainFrame.lastScript, "document.getElementById('__atomic_agent_embedded_mask')?.remove()", 'takeover removes only the fixed screenshot mask without the revoked lease');
    assert.equal(f.views[0].webContents.debugger.isAttached(), false);
    assert.match((await rpc({ operation: 'cdp', ...lease, method: 'Input.insertText', params: { text: 'must not type' } })).error, /manual control/);
    await f.service.command({ action: 'resume' });
    assert.match((await rpc({ operation: 'cdp', ...lease, method: 'Input.insertText' })).error, /expired/);
    assert.equal((await rpc({ operation: 'acquire' })).status, 200);
  } finally { await f.service.close(); }
});

test('direct input consumes its first event and switches to manual; CDP input stays agent controlled', async () => {
  const f = fixture({ sendCommand: (method, _params, c) => {
    if (method === 'Input.dispatchMouseEvent') c.emit('before-mouse-event', { preventDefault: () => assert.fail('CDP input was blocked') }, { type: 'mouseDown', x: 12, y: 34, button: 'left' });
    return {};
  } });
  try {
    const { rpc } = await f.begin(); await rpc({ operation: 'ready' });
    const { result: lease } = await rpc({ operation: 'acquire' });
    assert.equal((await rpc({ operation: 'cdp', ...lease, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 12, y: 34, button: 'left' } })).status, 200);
    assert.equal(f.service.state().mode, 'agent');
    let blocked = 0;
    f.views[0].webContents.emit('before-input-event', { preventDefault: () => blocked++ }, { type: 'keyDown' });
    assert.equal(blocked, 1); assert.equal(f.service.state().mode, 'manual');
    f.views[0].webContents.emit('before-input-event', { preventDefault: () => blocked++ }, { type: 'keyDown' });
    assert.equal(blocked, 1);
  } finally { await f.service.close(); }
});

test('unrelated native input takes over while a synthetic input command is pending', async () => {
  const f = fixture({ sendCommand: () => new Promise(() => {}) });
  try {
    const { rpc } = await f.begin(); await rpc({ operation: 'ready' });
    const { result: lease } = await rpc({ operation: 'acquire' });
    const running = rpc({ operation: 'cdp', ...lease, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 12, y: 34, button: 'left' } });
    while (!f.views[0].webContents.debugger.isAttached()) await new Promise(resolve => setImmediate(resolve));
    let blocked = false;
    f.views[0].webContents.emit('before-input-event', { preventDefault: () => { blocked = true; } }, { type: 'keyDown', key: 'Z' });
    assert.equal(blocked, true); assert.equal(f.service.state().mode, 'manual');
    assert.match((await running).error, /taken over/);
  } finally { await f.service.close(); }
});

test('cancellation and command timeout stop loading, detach and invalidate the lease', async () => {
  for (const cancel of [true, false]) {
    const f = fixture({ commandTimeoutMs: 30, sendCommand: () => new Promise(() => {}) });
    try {
      const { rpc } = await f.begin(); await rpc({ operation: 'ready' });
      const { result: lease } = await rpc({ operation: 'acquire' });
      const running = rpc({ operation: 'cdp', ...lease, method: 'Runtime.evaluate' });
      while (!f.views[0].webContents.debugger.isAttached()) await new Promise(resolve => setImmediate(resolve));
      if (cancel) assert.equal((await rpc({ operation: 'cancel', leaseId: lease.leaseId })).status, 200);
      assert.match((await running).error, cancel ? /cancelled/ : /timed out/);
      assert.equal(f.views[0].webContents.debugger.isAttached(), false); assert.ok(f.views[0].webContents.stopped > 0);
      assert.match((await rpc({ operation: 'release', leaseId: lease.leaseId })).error, /expired/);
    } finally { await f.service.close(); }
  }
});

test('client-generated leases cannot be acquired after a racing cancellation', async () => {
  const f = fixture();
  try {
    const { rpc } = await f.begin(); await rpc({ operation: 'ready' });
    const leaseId = '2d8bf361-c2a3-4fc0-89f8-7dbb7e81f706';
    assert.equal((await rpc({ operation: 'cancel', leaseId })).status, 200);
    assert.match((await rpc({ operation: 'acquire', leaseId })).error, /cancelled before/);
    const next = 'f18786d1-e9dd-48de-b547-2062b2d1d900';
    assert.equal((await rpc({ operation: 'acquire', leaseId: next })).result.leaseId, next);
    await f.service.command({ action: 'takeover' });
    assert.equal((await rpc({ operation: 'cancel', leaseId: next })).status, 200, 'cleanup cancellation is idempotent in manual mode');
    await f.service.command({ action: 'resume' });
    assert.match((await rpc({ operation: 'acquire', leaseId: next })).error, /cancelled before/);
  } finally { await f.service.close(); }
});

test('input refuses hidden or minimized windows and covered viewports without delivering a mutation', async () => {
  const f = fixture();
  try {
    const { rpc } = await f.begin(); await rpc({ operation: 'ready' });
    const { result: lease } = await rpc({ operation: 'acquire' });
    const input = () => rpc({ operation: 'cdp', ...lease, method: 'Input.insertText', params: { text: 'blocked fixture input' } });
    f.window.isVisible = () => false; assert.match((await input()).error, /Show the Browser pane/);
    f.window.isVisible = () => true; f.window.isMinimized = () => true; assert.match((await input()).error, /Show the Browser pane/);
    f.window.isMinimized = () => false;
    f.service.bounds({ x: 100, y: 100, width: 300, height: 300, visible: false });
    assert.equal(f.service.state().visible, true, 'covering native viewport preserves open-pane intent');
    assert.match((await input()).error, /Show the Browser pane/);
    assert.equal(f.views[0].webContents.commands, undefined);
    f.service.bounds({ x: 100, y: 100, width: 300, height: 300, visible: true });
    assert.equal((await input()).status, 200);
  } finally { await f.service.close(); }
});

test('authoritative frame metadata includes cross-process frames only for the leased owned tab', async () => {
  const f = fixture();
  try {
    const { rpc } = await f.begin(); await rpc({ operation: 'ready' });
    const { result: lease } = await rpc({ operation: 'acquire' });
    const main = f.views[0].webContents.mainFrame;
    main.url = 'https://allowed.test/';
    main.framesInSubtree.push({ url: 'https://blocked.test/secret', processId: 9, routingId: 12, frameTreeNodeId: 13, parent: main, frameToken: 'fixture-oopif', detached: false, executeJavaScript: async () => undefined });
    const before = await rpc({ operation: 'frames', ...lease });
    assert.equal(before.status, 200); assert.equal(before.result.frames[1].identity, '9:12:13');
    assert.equal(before.result.frames[1].url, 'https://blocked.test/secret');
    assert.match((await rpc({ operation: 'frames', ...lease, tabId: 'shell' })).error, /does not own/);
    f.views[0].webContents.emit('did-frame-navigate');
    assert.notEqual((await rpc({ operation: 'frames', ...lease })).result.signature, before.result.signature);
    await f.service.command({ action: 'hide' });
    assert.equal(f.service.state().mode, 'manual');
    assert.match((await rpc({ operation: 'frames', ...lease })).error, /manual control/);
  } finally { await f.service.close(); }
});

test('bounds are converted to DIP, clamped, selected-tab-only and detached at window close', async () => {
  const f = fixture();
  try {
    await f.service.command({ action: 'show' });
    f.service.bounds({ x: 700, y: 100, width: 500, height: 900, visible: true });
    assert.deepEqual(f.views[0].rect, { x: 875, y: 125, width: 125, height: 675 });
    assert.equal(f.views[0].visible, true);
    await f.service.command({ action: 'new' }); assert.equal(f.views[0].visible, false); assert.equal(f.views[1].visible, true);
    assert.throws(() => f.service.bounds({ x: NaN, y: 0, width: 1, height: 1 }), /Invalid/);
    f.service.attachWindow(null); assert.equal(f.service.state().mode, 'manual'); assert.equal(f.children.size, 0);
    for (const view of f.views) assert.equal(view.visible, false);
    await f.service.close(); assert.equal(f.session.flushed, true); for (const view of f.views) assert.equal(view.webContents.destroyed, true);
  } finally { await f.service.close(); }
});
