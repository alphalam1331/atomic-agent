# Browser tools

Status: current
Owner: src/tools/browser/

`browser.*` uses the `BrowserBackend` interface, so frontends share the tool contract and approval/domain gates. CLI/TUI and explicitly configured external connections use Playwright (`playwright-backend.ts`). Desktop startup supplies a private endpoint and capability token for `embedded-browser-backend.ts`: its native Chromium tabs are the tabs shown beside chat, with a persistent agent-owned profile distinct from the desktop shell and the user's normal browser profile. Explicit `browser.connect: "user-chrome"` or `browser.cdpUrl` continues to select the external backend.

## Embedded desktop backend

The [desktop browser service](../../../desktop/main/browser-service.ts) owns sandboxed `WebContentsView` instances without the shell's privileged preload. The agent runtime connects through an authenticated loopback-only HTTP bridge (`embedded-browser-transport.ts`), with a fixed CDP method allowlist scoped to those views; it cannot discover targets, inspect the shell, read cookies or use a browser-wide debugging port. Endpoint/token are passed explicitly at startup, never saved in browser config or prompt facts. Both environment values must be present to select this backend.

Each tool holds one serialized lease across ref preflight, element description, approval, action and its updated observation. Manual takeover, direct user input, manual tab/window changes and cancellation revoke that lease at the desktop, stop loads and detach debugging. Resume requires a fresh lease and snapshot: refs include the desktop epoch and tab identity, so a decision made before takeover cannot act afterward. Cancelling a turn aborts HTTP and revokes its lease; runtime shutdown disconnects the agent runtime without deleting the persistent profile.

Page reads use Chromium's accessibility tree, with opaque refs resolved back to DOM nodes for the same action classifier used by Playwright. In-process iframe trees are read separately; their controls retain their own frame URL and clicks account for iframe offsets and scale. Region reads fetch only descendants of the requested AX node. AX values and editable descendants are omitted; secret values collected inside each readable frame are also masked if echoed elsewhere in the tree. Only isolated execution-context IDs are retained between reads, and title/masking facts share one frame read; page content and masking values are never cached.

Electron's native frame inventory supplies authoritative URLs and document versions, including cross-process frames missing from the main CDP target. Before/after signatures reject reads or captures racing a frame/document change, and every native URL reaches the domain gate. Cross-process iframe bodies are omitted with an explicit note; open that frame's URL in an agent tab to read or operate it. Screenshots mask editable fields in every frame and refuse a page with a cross-process or otherwise unmaskable frame. An unreadable in-process frame fails closed. Clicks check enabled/visible state and hit testing before native input; covered elements and rotated/skewed iframes fail with instructions for a fresh read or separate tab. The embedded backend supports `domcontentloaded` and `load` navigation waits; an explicit `networkidle` request is rejected before navigation and remains available with the external backend.

Website popups open as separate owned tabs under manual control. They do not retain `window.opener`; sign-in flows that require opener callbacks should use the existing external browser mode. See the [desktop browser guide](../../../desktop/README.md) for the pane, profile and takeover behavior.

## Approval gate

- `browser.navigate` and `browser.tabs` new ask before a non-http(s) URL (`browser_nonweb`, level 5). A `javascript:` (or `vbscript:`) URL is refused outright: it runs code in the open page, so a `browser_nonweb` answer would otherwise stand in for the click/type gates below.
- `browser.click` and `browser.type` read the target first (`describeRef`, `describe-element.ts`): the nearest enclosing button / link / submit / menu item / tab (an icon inside a button counts as the button), its name (aria-label, aria-labelledby, label, text), form facts and the URL of the frame it is in. `classify-browser-action.ts` then decides. The check runs after the stale-ref preflight and before the backend acts.
  - `browser_commit` (level 4, grantable for the session): submit controls; clicks named send / post / publish / delete / save / confirm / allow / authorize / accept / merge / sign up and similar (English, Russian, basic German, Spanish, French, Portuguese, Italian, Chinese); Enter in a form or a non-search text field; a click on an element that could not be inspected (fail closed).
  - `browser_secret` (level 5, never granted): typing into password, one-time-code or payment card fields, or into an element that could not be inspected; clicks that pay (pay, buy now, checkout, place order, purchase…); any commit-like action on a payment page (a known payment host, or a checkout-like path such as `/checkout` or Amazon's `/gp/buy`). The preview shows the text length, never the text.
  - "Subscribe", "buy", "order", "book" and "donate" alone are `browser_commit`, and `browser_secret` only on a payment page: a YouTube or newsletter subscribe is not a payment.
  - Links, tabs, checkboxes, menus, typing without Enter and Enter in a search box do not ask.
- The session grant for `browser_commit` covers the whole category, like every grantable category; per-site grants are separate work.
- A browser call that was not approved stops the browser calls queued after it in the same batch (`agent/dispatch/batch-scheduler.ts`).
- Classification and previews rely on labels the page supplies, and a page can lie about them. The gate is a safety net, not a guarantee; secrets are never shown in a prompt either way.

## Domain lists

`browser.blockedDomains` and `browser.allowedDomains` in config.json (`browser-domain-policy.ts`). An entry matches its host and every subdomain.

- Blocked hosts are refused as a tool error (`blocked_domain`) at every approval level:
  - navigate, tabs new and search (the engine host), before the browser moves;
  - click / type on a page, or in a frame, on a blocked host, and a link or form (click or Enter) whose target is on one;
  - after navigate, tabs new, click, Enter and search, the page the browser landed on: a blocked landing clears the tab to `about:blank` (best effort for navigations that start after the action returns);
  - `browser.read_aria` and the world snapshot of a blocked page, or of a page that frames one (AI-mode snapshots include iframe content): no page content reaches the model.
- With a non-empty allow-list, navigate, tabs new, search, and a link or form target outside it ask first (`browser_offsite`, level 3).

## Screenshots

`browser.screenshot { ref?, fullPage? }` (`screenshot.ts`, `screenshot-geometry.ts`, ATO-515): a JPEG of the viewport, the whole page (cut at 8000 CSS px) or one element. Long side at most 1280 px, never upscaled; at most 900 KB, retaken smaller (quality 70 → 50 → 40) and refused if still over. Taken through CDP `Page.captureScreenshot` with a scaled clip, with card-number / one-time-code field values drawn as dots for the capture.

Saved under `<tmp>/atomic-agent-browser-shots/<session>/` (outside the working folder, inside the read roots). The model looks at it with `vision.describe`; the desktop and chat channels show it through `reply.attachments`. Read-only, no prompt in the agent's own profile: it shows only what `read_aria` already reads. It goes through the same page-read check as `read_aria` (`gate-page-read.ts`), so in the user's own Chrome a site not opened this session asks first.

A page on a blocked host is never captured. A capture is discarded, never saved, when the page or any of its frames is on a blocked host by the time the pixels are taken (a racing redirect, a blocked iframe).

## Page views

`browser.read_aria` takes `mode` (`aria-view.ts`, `compact-aria.ts`, ATO-956):

- `full`: the whole tree, as before.
- `interactive`: one line per control (interactive roles, plus any other ref'd node Playwright marks clickable) under landmark / heading headers; page text hidden. Refs are Playwright's own, so click / type resolve them exactly as from the full tree. Names that would read the same once clipped are shown longer.
- `diff`: changes by ref since this tab's last snapshot (`+` added, `~` changed with `was:`, `-` gone). Falls back to `interactive` on a new URL or without history.
- `region` with `ref`: capture only that locator's subtree, avoiding a whole-page snapshot. It retains the whole page's frame URLs for the domain gate, masks secret values, and leaves whole-page diff history intact. Use the refs from the resulting view; refs outside that subtree may become stale.

Without `mode`, a local model or a window ≤ 32k tokens gets `interactive`; others get `full`. The same default applies to the world snapshot after navigate / search. The size budget is 4% of the window (2k–24k chars). Interactive/diff views read the whole tree before filtering; a name Playwright writes as a quoted YAML key (`- 'button "Pay: $5" [ref=e7]'`) is unquoted first, so such a control is never dropped. A blocked page, or one framing a blocked site (AI-mode snapshots include iframe content), is neither rendered nor remembered for `diff`.

Successful click/type calls refresh `details.worldSnapshot` with interactive controls, with an ~8k-character body budget (or the smaller context budget). The next step receives current refs and control state through the existing world snapshot; no extra inference or stable-prefix change is involved. The observation is best effort: a read failure does not turn a successful action into a failed action. It uses the same domain, frame and user-profile read gates, so blocked/uncleared pages are not captured. Explicit full/region reads remain available for page text. [Performance measurements](docs/performance.md) separate startup, page extraction, action latency and observation overhead.

## Your own Chrome

`browser.connect: "user-chrome"` in config.json (opt-in; default `"agent"`, the agent's own profile). The agent then works in the user's signed-in Chrome (`attach-user-chrome.ts`, `user-chrome-endpoint.ts`):

- Attach order: `browser.cdpUrl` (a Chrome the user started with `--remote-debugging-port`, loopback only), else the `DevToolsActivePort` file Chrome 144+ writes while remote debugging is on (Chrome / Beta / Canary / Chromium / Brave / Edge on macOS, Windows, Linux, or `browser.userDataDir`). Otherwise Chrome is opened once on `chrome://inspect/#remote-debugging` and the agent waits up to 60 s for the user to turn it on and allow Chrome's dialog. Chrome 136+ ignores a debugging port on the default profile, so the agent never launches it with one.
- Not reachable: a plain error with those steps; the next browser call retries. A Chrome that was quit or restarted is noticed on the next call, which drops the dead connection and attaches again from a fresh `DevToolsActivePort` read; if remote debugging is off in the new Chrome the call fails at once with the steps (no settings page, no wait). The shell refuses to script browsers, so the model cannot work around this (`../os/shell-command-guard/browser-bypass.ts`).
- The agent opens its own tab and only sees, switches to or closes its tabs and their pop-ups. Shutdown disconnects; the user's windows stay.
- Opening or reading a site the agent has not opened this session asks as `browser_secret` (`user-profile-sites.ts`): navigate, tabs new, search, a link or form to a new host, and `read_aria` (every view) or `screenshot` on a page that landed elsewhere; the world snapshot of such a page is skipped. One check (`gate-page-read.ts`) covers blocked frames and this. Once per site per session; hosts in `browser.allowedDomains` do not ask. Reading a signed-in site is reading the account, and a URL can carry what was read to another host.
- Every `browser_commit` (submit, send, post, delete, Enter in a form) asks as `browser_secret`: every time, never covered by a session grant. Non-web URLs (chrome://, file://, view-source:, data:…) are refused outright.
- Cookies, saved passwords and storage are never read. Values of password, one-time-code and card fields are masked in every snapshot, in both modes (`redact-secret-fields.ts`); a code field is also recognised by its name or label ("Verification code", "Код из SMS"), and typing into one asks as `browser_secret` with only the length in the preview.

Read [tool instructions](../AGENTS.md) and the adjacent tests before changing the classifier or the gate order.
