/* Real shell controls, runtime tools and embedded tabs; only inference is scripted. */
import {createServer} from 'node:http';
import {SCENARIO_NAME, ask, check, main, waitTurn} from '../harness.mjs';
import {liveScenario} from './live-harness.mjs';
import {call, reply, requestText} from './scripted-model.mjs';

const TURN = {timeout:60000, startGrace:30000, quiet:1800, approve:'none'};

export async function run() {
  let isolated = false;
  const site = createServer((req, res) => {
    if (req.url === '/isolated') { isolated = true; res.end('ok'); return; }
    res.writeHead(200, {'content-type':'text/html'});
    res.end(`<!doctype html><title>Embedded fixture</title><h1>Browser fixture</h1>
      <button id="count" onclick="this.textContent='Count 1'">Increment count</button>
      <button id="save" onclick="this.textContent='Saved fixture'">Save fixture</button>
      <label>Search <input type="search" aria-label="Search"></label>
      <label>Password <input type="password" value="disposable-secret"></label>
      <script>if(typeof window.atomic==='undefined'&&typeof require==='undefined')fetch('/isolated')</script>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  try {
    return await liveScenario(SCENARIO_NAME(import.meta.url), async ({app, model}) => {
      let step = 0;
      model.route([{name:'embedded', match:() => true, steps:(record) => {
        step++;
        const text = requestText(record);
        if (step === 1) return call('browser.navigate', {url});
        if (step === 2) {
          check(!text.includes('disposable-secret'), 'the password value is absent from the model observation');
          const ref = text.match(/\[(e\d+)\] button "Increment count"/)?.[1];
          check(!!ref, 'navigation supplies a real embedded control ref', text.slice(-2500));
          return call('browser.click', {ref});
        }
        if (step === 3) {
          check(text.includes('Count 1'), 'click supplies an updated observation to the next inference');
          return reply('The embedded counter is now one.');
        }
        if (step === 4) {
          const ref = text.match(/\[(e\d+)\] button "Save fixture"/)?.[1];
          check(!!ref, 'the next turn retains the observed Save control');
          return call('browser.click', {ref});
        }
        if (step === 5) {
          check(text.includes('Saved fixture'), 'approved input reaches the embedded page');
          return reply('The fixture was saved after approval.');
        }
        if (step === 6) return call('browser.read_aria', {});
        if (step === 7) {
          check(/manual control|under manual|Resume agent/i.test(text), 'manual takeover blocks agent page reads');
          return reply('Browser access is paused for you.');
        }
        if (step === 8) return call('browser.read_aria', {});
        if (step === 9) {
          check(text.includes('Browser fixture'), 'resuming allows a fresh page read');
          return reply('Browser access resumed.');
        }
        throw new Error(`Unexpected embedded scenario inference ${step}`);
      }}]);
      await ask(app, 'Open the browser fixture and click its increment control.');
      const done = await waitTurn(app, TURN);
      check(done.reply === 'The embedded counter is now one.', 'the real browser tools completed the turn', done.reply);
      await app.waitFor(`!document.querySelector('#browserpane').hidden`, 'the Browser pane beside chat');
      check(isolated, 'the remote website has neither shell preload nor Node access');
      const before = await app.eval(`document.querySelector('#browser-address').value`);
      check(before === url, 'the address bar tracks the agent tab', before);
      await ask(app, 'Click Save fixture after I approve it.');
      const pending = await waitTurn(app, TURN);
      check(pending.pending, 'a commit-like embedded click waits at the existing approval gate');
      check(step === 4, 'there is no next inference while approval waits');
      await app.clickText('Allow once', {scope:'#apprcard'});
      check((await waitTurn(app, TURN)).reply === 'The fixture was saved after approval.', 'approving releases the gated embedded action');
      await app.clickSel('[data-browser="takeover"]');
      await app.waitFor(`!!document.querySelector('[data-browser="resume"]')`, 'manual mode');
      await ask(app, 'Read the page while I control the browser.');
      check((await waitTurn(app, TURN)).reply === 'Browser access is paused for you.', 'the turn reports paused browser access');
      await app.clickSel('[data-browser="resume"]');
      await app.waitFor(`!!document.querySelector('[data-browser="takeover"]')`, 'agent control');
      await ask(app, 'Read the page again now.');
      check((await waitTurn(app, TURN)).reply === 'Browser access resumed.', 'the resumed tool can read the same tab');
      await app.clickSel('[data-browser="new"]');
      await app.waitFor(`document.querySelectorAll('.bp-tab').length === 2`, 'a second real browser tab');
      check(await app.eval(`!!document.querySelector('[data-browser="resume"]')`), 'tab controls take manual control');
      await app.clickSel('#browser-address');
      await app.type(url + 'second');
      await app.press('Enter');
      await app.waitFor(`document.querySelector('#browser-address').value === ${JSON.stringify(url + 'second')} && !document.querySelector('[data-browser="back"]').disabled`, 'address-bar navigation');
      await app.clickSel('[data-browser="back"]');
      await app.waitFor(`document.querySelector('#browser-address').value === '' && !document.querySelector('[data-browser="forward"]').disabled`, 'back navigation to the new tab');
      await app.clickSel('[data-browser="forward"]');
      await app.waitFor(`document.querySelector('#browser-address').value === ${JSON.stringify(url + 'second')}`, 'forward navigation');
      await app.clickSel('[data-act="settings:open"]');
      await app.waitFor(`!!document.querySelector('#settings')`, 'settings over the browser');
      await app.clickSel('[data-act="settings:close"]');
      await app.waitFor(`!document.querySelector('#settings') && !document.querySelector('#browserpane').hidden`, 'browser restored after settings');
      await app.clickSel('[data-browser="hide"]');
      await app.waitFor(`document.querySelector('#browserpane').hidden`, 'hidden browser pane');
      await app.clickSel('[data-act="browser:toggle"]');
      await app.waitFor(`!document.querySelector('#browserpane').hidden`, 'reopened browser pane');
      check(step === 9, 'browser UI actions perform no inference');
    }, {setup:({config}) => {
      config.browser.enabled = true;
      return {ATOMIC_AGENT_BROWSER_ENABLED:'true'};
    }});
  } finally { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
}

if (import.meta.url === `file://${process.argv[1]}`) main(run());
