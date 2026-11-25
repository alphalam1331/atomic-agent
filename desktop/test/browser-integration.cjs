/* Optional real Electron integration. Requires an X11/macOS/Windows display.
 * From desktop: npm run build; DISPLAY=:1 node_modules/.bin/electron test/browser-integration.cjs
 * Root npm run build must also have produced dist/tools/browser/embedded-browser-backend.js.
 * All profiles, cookies and pages are disposable; no personal agent state is read.
 */
const { app, BrowserWindow, session } = require('electron');
const { createServer } = require('node:http');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createDesktopBrowserService } = require('../out/main/browser-electron.js');
const temporary = mkdtempSync(join(tmpdir(), 'atomic-browser-integration-'));
process.env.ATOMIC_AGENT_STATE_DIR = join(temporary, 'agent');
app.setPath('userData', join(temporary, 'desktop'));
app.setPath('sessionData', join(temporary, 'sessions'));
app.commandLine.appendSwitch('site-per-process');
const profilePath = join(temporary, 'browser-profile');
let browser, backend, window, server;
const times = {};
const checkpoint = label => { if (process.env.ATOMIC_BROWSER_TEST_VERBOSE) console.error(`browser integration: ${label}`); };
async function measure(label, operation) {
  checkpoint(label);
  const start = performance.now(); const result = await operation();
  (times[label] ??= []).push(Number((performance.now() - start).toFixed(2))); return result;
}
function refFor(snapshot, name, role) {
  const line = snapshot.text.split('\n').find(line => line.includes(JSON.stringify(name)) && /\[ref=/.test(line) && (!role || line.includes(`- ${role} `)));
  assert.ok(line, `Missing ref for ${name}: ${snapshot.text}`);
  return /\[ref=([^\]]+)/.exec(line)[1];
}
async function main() {
  const { EmbeddedBrowserBackend } = await import(pathToFileURL(resolve(__dirname, '../../dist/tools/browser/embedded-browser-backend.js')).href);
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const base = `http://127.0.0.1:${server.address().port}/`;
    if (req.url === '/cross') { res.end(`<title>Cross-site frame fixture</title><h1>Main frame</h1><iframe src="http://localhost:${server.address().port}/cross-child"></iframe>`); return; }
    if (req.url === '/same') { res.end(`<title>Same-site frame fixture</title><script>window.decoyCount=0</script><h1>Main frame</h1><button onclick="window.decoyCount++">Main decoy</button><iframe style="display:block;margin-left:60px;margin-top:35px;width:450px;height:550px;border:7px solid;padding:3px" src="${base}same-child"></iframe>`); return; }
    if (req.url === '/same-child') { res.end(`<script>window.targetCount=0;window.decoyCount=0</script><h2>Same-origin child</h2><label>Child password<input type="password" value="child-password-fixture"></label><div style="margin-left:25px;margin-top:12px"><button onclick="window.targetCount++;document.getElementById('child-result').textContent='Child action completed'">Child action</button><button onclick="window.decoyCount++">Child decoy</button></div><p id="child-result">Waiting for child action</p><iframe style="margin-left:35px;margin-top:20px;width:320px;height:260px;border:5px solid;padding:3px" src="${base}same-grandchild"></iframe>`); return; }
    if (req.url === '/same-grandchild') { res.end('<script>window.targetCount=0;window.decoyCount=0</script><h3>Same-origin grandchild</h3><label>Nested code<input autocomplete="one-time-code" value="782662"></label><div style="margin-left:20px;margin-top:15px"><button onclick="window.targetCount++;document.getElementById(\'grandchild-result\').textContent=\'Grandchild action completed\'">Grandchild action</button><button onclick="window.decoyCount++">Grandchild decoy</button></div><p id="grandchild-result">Waiting for grandchild action</p>'); return; }
    if (req.url === '/cross-child') { res.end('<h2>Cross-process secret fixture</h2><label>Remote password<input type="password" value="cross-password-fixture"></label><p>cross-password-fixture</p>'); return; }
    if (req.url === '/large') { res.end(`<title>Large fixture</title><main><section aria-label="Relevant region"><h2>Relevant controls</h2>${Array.from({length: 5}, (_, i) => `<button>Relevant item ${i}</button>`).join('')}</section>${Array.from({length: 500}, (_, i) => `<article><h2>Unrelated item ${i}</h2><p>Background content for card ${i}</p><button>View card ${i}</button></article>`).join('')}</main>`); return; }
    if (req.url === '/login') res.setHeader('set-cookie', 'atomic_test_login=agent-profile-only; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax');
    const login = /atomic_test_login=agent-profile-only/.test(req.headers.cookie ?? '');
    res.end(`<!doctype html><title>Browser fixture</title><h1>Agent browser test</h1>
      <p>${login ? 'Profile login is present' : 'Profile login is absent'}</p>
      <label>Search fixture<input id="search" type="search"></label>
      <label>Password<input type="password" value="secret-password-fixture"></label>
      <label>One-time code<input autocomplete="one-time-code" value="928441"></label>
      <button id="action" onclick="document.querySelector('#result').textContent='Action completed'">Update fixture</button>
      <button onclick="window.open('/popup','fixture-sign-in')">Sign in popup</button>
      <button onclick="alert('fixture dialog');document.querySelector('#result').textContent='Dialog completed'">Dialog fixture</button>
      <p id="result">Waiting for action</p><div style="height:1800px"></div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('about:blank');
  window.showInactive();
  browser = createDesktopBrowserService({ profilePath }); browser.attachWindow(window);
  if (process.platform !== 'win32') assert.equal(statSync(profilePath).mode & 0o777, 0o700);
  browser.bounds({ x: 500, y: 80, width: 580, height: 740, visible: true });
  const env = await measure('bridgeStartupMs', () => browser.start());
  backend = new EmbeddedBrowserBackend({ endpoint: env.ATOMIC_AGENT_BROWSER_ENDPOINT, token: env.ATOMIC_AGENT_BROWSER_TOKEN });
  await measure('browserReadyMs', () => backend.ensureReady());
  await measure('navigateMs', () => backend.navigate({ url, waitUntil: 'domcontentloaded' }));
  const remote = [...browser.tabs.values()][0].view.webContents;
  const preferences = remote.getLastWebPreferences();
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.preload, undefined);
  assert.equal(preferences.disableDialogs, true);
  assert.notEqual(remote.session, window.webContents.session);
  assert.equal(await remote.executeJavaScript('typeof window.atomic'), 'undefined');
  let snapshot = await measure('snapshotMs', () => backend.snapshot());
  assert.doesNotMatch(snapshot.text, /secret-password-fixture|928441/);
  const actionRef = refFor(snapshot, 'Update fixture', 'button'); const inputRef = refFor(snapshot, 'Search fixture', 'searchbox');
  assert.equal(await backend.hasRef(actionRef), true);
  assert.equal((await backend.describeRef(actionRef)).tag, 'button');
  await measure('typeMs', () => backend.type({ ref: inputRef, text: 'agent entered fixture text', pressEnter: true }));
  assert.equal(await remote.executeJavaScript("document.querySelector('#search').value"), 'agent entered fixture text');
  await measure('clickMs', () => backend.click({ ref: actionRef }));
  assert.equal(browser.state().mode, 'agent', 'CDP input must not trigger manual takeover');
  snapshot = await measure('snapshotMs', () => backend.snapshot()); assert.match(snapshot.text, /Action completed/);
  await backend.click({ ref: refFor(snapshot, 'Dialog fixture', 'button') });
  assert.equal(await remote.executeJavaScript("document.querySelector('#result').textContent"), 'Dialog completed');
  const shot = await measure('screenshotMs', () => backend.screenshot({ maxSide: 1000, quality: 70 }));
  assert.ok(shot.buffer.length > 100); assert.equal(shot.buffer[0], 0xff); assert.equal(shot.mime, 'image/jpeg');
  checkpoint('popup'); await backend.click({ ref: refFor(snapshot, 'Sign in popup', 'button') }).catch(error => assert.match(error.message, /taken over|manual control/));
  while (browser.state().tabs.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.state().mode, 'manual');
  const popupTab = [...browser.tabs.values()][1]; await popupTab.initialLoad;
  const popup = popupTab.view.webContents;
  assert.equal(popup.getLastWebPreferences().preload, undefined); assert.equal(popup.getLastWebPreferences().nodeIntegration, false);
  assert.equal(popup.getURL(), `${url}popup`); assert.equal(await popup.executeJavaScript('typeof window.atomic'), 'undefined');
  assert.equal(await popup.executeJavaScript('window.opener === null'), true);
  await browser.command({ action: 'resume' });
  await backend.tabs({ action: 'close', index: 1 });
  checkpoint('tabs'); await backend.tabs({ action: 'new', url: `${url}login` }); assert.equal((await backend.tabs({ action: 'list' })).tabs.length, 2);
  await backend.tabs({ action: 'switch', index: 0 }); await backend.tabs({ action: 'close', index: 1 });
  assert.equal((await backend.tabs({ action: 'list' })).tabs.length, 1);
  checkpoint('manual takeover');
  await remote.executeJavaScript("{const s=document.createElement('style');s.id='__atomic_agent_embedded_mask';document.documentElement.appendChild(s)}");
  await browser.command({ action: 'takeover' }); await assert.rejects(backend.snapshot(), /manual control/);
  assert.equal(await remote.executeJavaScript("document.getElementById('__atomic_agent_embedded_mask') === null"), true);
  await browser.command({ action: 'resume' }); assert.equal(await backend.hasRef(actionRef), false, 'pre-takeover refs must expire');
  await backend.snapshot();
  const nativeInputRemote = [...browser.tabs.values()][0].view.webContents;
  nativeInputRemote.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(browser.state().mode, 'manual', 'direct native input must transfer control');
  await browser.command({ action: 'resume' });
  checkpoint('cancellation'); const controller = new AbortController();
  const cancelled = backend.withSignal(controller.signal, () => backend.evaluate('new Promise(() => {})'));
  await new Promise(resolve => setTimeout(resolve, 50)); controller.abort(new Error('fixture cancellation'));
  await assert.rejects(cancelled, /fixture cancellation/);
  await backend.snapshot();
  checkpoint('profile reopen'); await backend.shutdown(); backend = undefined; await browser.close();
  browser = createDesktopBrowserService({ profilePath }); browser.attachWindow(window);
  browser.bounds({ x: 500, y: 80, width: 580, height: 740, visible: true });
  const reopenedEnv = await browser.start();
  backend = new EmbeddedBrowserBackend({ endpoint: reopenedEnv.ATOMIC_AGENT_BROWSER_ENDPOINT, token: reopenedEnv.ATOMIC_AGENT_BROWSER_TOKEN });
  await backend.navigate({ url }); assert.match((await backend.snapshot()).text, /Profile login is present/);
  assert.deepEqual(await session.defaultSession.cookies.get({ name: 'atomic_test_login' }), [], 'agent login cannot leak to shell session');
  for (let i = 0; i < 5; i++) await measure('snapshotMs', () => backend.snapshot());
  checkpoint('same-origin frames'); await backend.navigate({ url: `${url}same`, waitUntil: 'load' });
  const sameSite = await backend.snapshot();
  assert.ok(sameSite.frameUrls.includes(`${url}same-child`)); assert.ok(sameSite.frameUrls.includes(`${url}same-grandchild`));
  assert.match(sameSite.text, /Same-origin child/); assert.match(sameSite.text, /Same-origin grandchild/);
  assert.doesNotMatch(sameSite.text, /child-password-fixture|782662/);
  await backend.click({ ref: refFor(sameSite, 'Child action', 'button') });
  assert.match((await backend.snapshot()).text, /Child action completed/);
  await backend.click({ ref: refFor(sameSite, 'Grandchild action', 'button') });
  assert.match((await backend.snapshot()).text, /Grandchild action completed/);
  const frameCounts = await [...browser.tabs.values()][0].view.webContents.executeJavaScript(`(() => {const c=document.querySelector('iframe').contentWindow,g=c.document.querySelector('iframe').contentWindow;return {mainDecoy:window.decoyCount,childTarget:c.targetCount,childDecoy:c.decoyCount,grandchildTarget:g.targetCount,grandchildDecoy:g.decoyCount}})()`);
  assert.deepEqual(frameCounts, {mainDecoy:0,childTarget:1,childDecoy:0,grandchildTarget:1,grandchildDecoy:0});
  assert.ok((await backend.screenshot({ maxSide: 1000, quality: 70 })).buffer.length > 100);
  checkpoint('cross-process frames'); await backend.navigate({ url: `${url}cross`, waitUntil: 'load' });
  const crossSite = await backend.snapshot();
  const childUrl = `http://localhost:${server.address().port}/cross-child`;
  assert.ok(crossSite.frameUrls.includes(childUrl), 'native OOPIF URL must reach domain checks');
  assert.doesNotMatch(crossSite.text, /cross-password-fixture/);
  const owned = [...browser.tabs.values()].find(tab => tab.tabId === browser.state().activeTabId).view.webContents;
  assert.ok(new Set(owned.mainFrame.framesInSubtree.map(frame => frame.processId)).size > 1, 'fixture must actually use separate renderer processes');
  await assert.rejects(backend.screenshot({ maxSide: 1000, quality: 70 }), /cross.process|frame|mask/i);
  const { buildBrowserReadAriaTool } = await import(pathToFileURL(resolve(__dirname, '../../dist/tools/browser/read-aria.js')).href);
  const blockedTool = buildBrowserReadAriaTool(backend, { blockedDomains: ['localhost'], allowedDomains: [] });
  const blockedRead = await blockedTool.run({}, { workingDir: temporary, sessionId: 'browser-fixture', stepIndex: 0, signal: new AbortController().signal });
  assert.equal(blockedRead.status, 'error'); assert.equal(blockedRead.details.reason, 'blocked_domain');
  assert.equal(blockedRead.details.worldSnapshot, undefined);
  checkpoint('region reads'); await backend.navigate({ url: `${url}large`, waitUntil: 'load' });
  const large = await backend.snapshot();
  const regionRef = refFor(large, 'Relevant region', 'region');
  for (let i = 0; i < 5; i++) {
    await measure('largeFullReadMs', () => backend.snapshot({ full: true }));
    const region = await measure('largeRegionReadMs', () => backend.snapshot({ ref: regionRef, depth: 8, full: true }));
    assert.match(region.text, /Relevant item 4/); assert.doesNotMatch(region.text, /Unrelated item/);
  }
  if (process.env.ATOMIC_BROWSER_COMPARE_EXECUTABLE) {
    const { PlaywrightBackend } = await import(pathToFileURL(resolve(__dirname, '../../dist/tools/browser/playwright-backend.js')).href);
    const external = new PlaywrightBackend({ userDataDir: join(temporary, 'external-profile'), channel: 'chrome',
      executablePath: process.env.ATOMIC_BROWSER_COMPARE_EXECUTABLE, headless: false, launchTimeoutMs: 15_000 });
    try {
      await measure('externalBrowserReadyMs', () => external.ensureReady());
      await measure('externalNavigateMs', () => external.navigate({ url }));
      const externalSnapshot = await measure('externalSnapshotMs', () => external.snapshot());
      const externalInput = refFor(externalSnapshot, 'Search fixture', 'searchbox');
      const externalAction = refFor(externalSnapshot, 'Update fixture', 'button');
      await measure('externalTypeMs', () => external.type({ ref: externalInput, text: 'agent entered fixture text', pressEnter: true }));
      await measure('externalClickMs', () => external.click({ ref: externalAction }));
      for (let i = 0; i < 6; i++) await measure('externalSnapshotMs', () => external.snapshot());
    } finally { await external.shutdown(); }
  }
  console.log(JSON.stringify({ ok: true, checked: ['sandbox/session isolation', 'DOM/ARIA refs and secret masking', 'real typing/clicks', 'JPEG screenshot', 'tabs', 'manual takeover and stale refs', 'native input takeover', 'cancellation', 'profile reopen', 'same-origin nested frames', 'cross-process frame masking refusal and blocked-domain gate'], timingsMs: times }, null, 2));
}
app.whenReady().then(main).then(() => cleanup(0), error => { console.error(error); return cleanup(1); });
async function cleanup(code) {
  try { await backend?.shutdown(); await browser?.close(); window?.destroy(); if (server) await new Promise(resolve => server.close(resolve)); }
  finally { rmSync(temporary, { recursive: true, force: true }); app.exit(code); }
}
