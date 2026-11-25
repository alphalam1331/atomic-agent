# Embedded browser

Status: current
Owner: desktop/

The Browser button opens a pane beside chat. Its tabs, address bar and Back,
Forward, Reload and Stop controls belong to the local shell. Each website runs
in its own Electron `WebContentsView`, created without a preload or Node access,
with sandboxing, context isolation and web security enabled. The shell renderer
never embeds website HTML. Native content is hidden while shell overlays or
settings are open, and its bounds follow layout and shell zoom.

## Ownership and transport

[browser-electron.ts](../main/browser-electron.ts) creates one dedicated persistent
session at `<ATOMIC_AGENT_STATE_DIR>/browser-electron`, with an owner-only profile
directory on POSIX. Cookies and website storage
stay there across launches, separately from personal Chrome and the desktop shell.
Tabs are kept across runtime restarts and a closed/reopened desktop window, but
are not restored after a full app quit. Closing the window pauses browser access.

[browser-service.ts](../main/browser-service.ts) owns the views and a loopback HTTP
server on an ephemeral port. A random bearer capability is passed explicitly to
the supervised agent child's environment through `AgentClientOptions.browserEnv`.
It never goes through shell IPC, browser page content, model prompts or logs.
Command, skill and vendor-CLI child environments omit both bridge variables;
shell passthrough cannot reintroduce them.
The transport rejects origins, redirects, unauthenticated requests and oversized
bodies. Its CDP method allowlist addresses only registered remote views. It has
no browser target discovery, storage/cookie API, global debugging port or path to
the privileged shell renderer. Production does not enable Electron's remote
debugging switch; the existing test driver may enable it for its own inspection.

The runtime selects [EmbeddedBrowserBackend](../../src/tools/browser/embedded-browser-backend.ts)
when the two desktop environment values are present and browser connection mode
is `agent`, without an explicit external CDP URL. CLI/TUI and explicitly selected
`user-chrome` or external CDP configurations keep the existing Playwright backend.
A desktop connected to a remote agent also keeps that agent's own browser; the
local pane does not proxy remote websites back from it.

## Tools and control

The existing `browser.*` contract runs through `BrowserBackend`. The
embedded backend reads Chromium's structured accessibility tree, creates opaque
refs backed by DOM node identities, describes the referenced control before the
existing approval gate, and sends native input to that node's visible location.
It refuses disabled, hidden or obstructed click targets. Region reads traverse
only that accessibility subtree. Field values and editable descendants are
omitted, known secret values are redacted, and screenshots temporarily mask
editable fields. Native frame inventory includes cross-process frames in the
existing blocked-domain/read gates. Reads include reachable child-frame controls;
cross-process frame content is omitted with guidance to open its URL in an owned
tab. Screenshots are refused when every rendered frame cannot be masked safely.

Each tool holds a lease over inspection, approval, action and its resulting
observation. Browser tools serialize at this backend even across chats. Take over
invalidates that lease, stops pending loads and detaches debuggers. A delayed
approval cannot resume an old action. Browser reads and actions fail while manual
control is active. The first direct click, wheel or key in an agent-controlled
website is consumed and switches to manual control; subsequent input is normal.
Address-bar navigation and tab controls also switch to manual control.

Resume agent grants browser access again. The agent must read a fresh observation;
old refs are invalid. Resume does not replay an interrupted action or start a new
chat turn: if the turn ended, send the agent a message to continue. Hiding the pane
or hiding/minimizing its window pauses browser access. Input requires a visible,
uncovered native view; a covered view fails before any input is sent. Runtime
cancellation aborts its HTTP operation and
invalidates the lease. Quit closes every owned webContents and the bridge and
flushes profile storage. Runtime shutdown disconnects without deleting logins.

Approval gates, domain restrictions and secret handling remain at tool dispatch.
Manual navigation uses web URLs only; agent non-web navigation is refused by this
surface even if approved. Site permissions, device access and downloads are
denied. Popup GET targets open as sandboxed owned tabs and transfer control to the
person. The native popup is denied before that deferred navigation, so it cannot
escape into a privileged window. This avoids an Electron 44 native hang observed
when returning a `WebContentsView` from `createWindow`. The new tab has no opener;
opener-dependent sign-ins and popup form submissions require the external browser.
JavaScript dialogs are disabled so an alert cannot wedge native input. Persistent
state permits ordinary website sign-in, but this is not
a password-manager, passkey, camera/microphone or file-upload integration.

The embedded backend supports `domcontentloaded` and `load`; it rejects an explicit
`networkidle` wait because the bounded bridge does not track network activity.
Its accessibility view can differ from Playwright's view. External browser modes remain available for sites
that need unsupported browser capabilities.

## Verification and performance

`node --test desktop/test/browser-*.test.mjs` covers browser chrome and the
service's authentication, ownership, takeover and lifecycle seams. The disposable
Electron integration harness exercises real views and the core backend using a
working display; it must not use personal state. Browser core tests include the
transport and backend protocol. Performance measurements are documented in the
[browser guide](../../src/tools/browser/README.md); embedding is not itself a
per-action speed claim. No browser change adds inference calls or mutable prompt
prefix data.

### Reproducing the real browser check

Build both packages, then run the disposable integration harness on a working
display (the display number is machine-specific):

```bash
npm run build
cd desktop
npm run build
DISPLAY=:1 node_modules/.bin/electron test/browser-integration.cjs
DISPLAY=:1 node test/live/run-all.mjs L16
```

The harness uses a temporary state directory, desktop session and owner-only
browser profile. It opens an inactive window because a hidden native view can
accept a CDP click without delivering the page event. Production input instead
fails closed when its window or active viewport is hidden, minimized or covered.
The harness checks real typing/Enter/click effects, suppressed dialogs, safe popup
navigation, cookie/profile reopening, shell-session isolation, screenshot-mask
cleanup after takeover, cancellation, nested iframe target and decoy counters,
and blocked cross-process frame URLs. Screenshots of unmaskable cross-process
frames are refused.

To compare the external backend using a separately installed Chrome executable:

```bash
DISPLAY=:1 ATOMIC_BROWSER_COMPARE_EXECUTABLE=/usr/bin/google-chrome \
  node_modules/.bin/electron test/browser-integration.cjs
```

### Measured local fixture, 2026-11-25

One Linux/X11 run used Electron 44 (Chromium 152.0.7977.54) and Google Chrome
156.0.8078.47, both visible, with fresh disposable profiles and the same local
HTTP page. Their Chromium versions differ. These are elapsed
wall-clock samples, not an internet benchmark or a universal speed claim.
Readiness starts inside the already-running Electron process; it excludes desktop
startup, while external readiness includes launching Chrome. Navigation, input
and screenshot rows have one sample; read rows report medians.

| Operation | Embedded | External Playwright |
|---|---:|---:|
| Browser ready | 47.69 ms | 428.58 ms |
| Navigate, DOM ready | 170.20 ms | 75.15 ms |
| Structured read, 7 samples | 25.31 ms | 10.79 ms |
| Type and Enter | 36.08 ms | 101.91 ms |
| Click | 30.87 ms | 72.83 ms |
| JPEG screenshot | 85.49 ms | not sampled |

The authenticated bridge itself started in 0.23 ms. Embedded readiness and native
input were faster in this run; navigation and structured reads were slower. The
bridge adds ownership, authoritative frame checks and several CDP round trips.
Keeping it warm does not remove those per-read costs.

On a second fixture containing 500 unrelated articles and a region with five
buttons, full embedded reads took a median 138.88 ms across five samples. Reading
only that region took 55.46 ms across five samples, about 60% less elapsed time,
while retaining the region's descendants. Region reads reduce relevant work; the
tool must first have a valid region ref from the current page. Isolated execution
context IDs are reused between reads, but page content and secret values are read
fresh. Actions return updated observations without another inference call.
