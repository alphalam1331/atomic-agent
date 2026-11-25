import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { BrowserWindow, Session, WebContentsView } from "electron";

export interface BrowserTabState {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserPaneState {
  mode: "agent" | "manual";
  activeTabId: string | null;
  tabs: BrowserTabState[];
  visible: boolean;
  error?: string;
}

export interface DesktopBrowserOptions {
  /** Only the dedicated agent profile; never the desktop shell's session. */
  browserSession: Session;
  /** Must create a sandboxed view without a privileged preload. */
  createView: () => WebContentsView;
  onState?: (state: BrowserPaneState) => void;
  commandTimeoutMs?: number;
}

interface BrowserTab { tabId: string; view: WebContentsView; initialLoad?: Promise<void>; documentVersion: number; }
interface Lease { id: string; tabId: string; epoch: number; controller: AbortController; }
type JsonObject = Record<string, unknown>;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TABS = 20;

/** No Browser/Target/Storage/Network/file commands and no arbitrary debugger sessions. */
const CDP_METHODS = new Set([
  "Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.releaseObject", "Runtime.releaseObjectGroup",
  "Page.navigate", "Page.getFrameTree", "Page.captureScreenshot", "Page.getLayoutMetrics", "Page.stopLoading", "Page.createIsolatedWorld",
  "DOM.describeNode", "DOM.resolveNode", "DOM.getBoxModel", "DOM.scrollIntoViewIfNeeded", "DOM.focus", "DOM.getFrameOwner",
  "Accessibility.enable", "Accessibility.getFullAXTree", "Accessibility.getPartialAXTree", "Accessibility.getChildAXNodes",
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText",
]);

export function isBrowserNavigationUrl(raw: unknown): raw is string {
  if (raw === "about:blank") return true;
  if (typeof raw !== "string" || raw.length > 32_768) return false;
  try { const url = new URL(raw); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password; }
  catch { return false; }
}

function object(raw: unknown): JsonObject {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected a browser command object.");
  return raw as JsonObject;
}

/**
 * Owns only remote-site views. The loopback RPC is deliberately independent of
 * the shell's webContents and cannot enumerate or attach to any other target.
 */
export class DesktopBrowserService {
  private readonly tabs = new Map<string, BrowserTab>();
  private window: BrowserWindow | null = null;
  private activeTabId: string | null = null;
  private mode: "agent" | "manual" = "agent";
  private visible = false;
  private viewportVisible = true;
  private rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private epoch = 0;
  private lease: Lease | null = null;
  private readonly cancelledLeases = new Map<string, number>();
  private server: Server | null = null;
  private startPromise: Promise<Record<string, string>> | null = null;
  private closed = false;
  private error: string | undefined;
  private readonly token = randomBytes(32).toString("hex");
  private readonly injectingInput = new Map<number, { type: string; key?: string; x?: number; y?: number; button?: string }>();

  constructor(private readonly options: DesktopBrowserOptions) {
    const session = options.browserSession;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.on("will-download", (event) => event.preventDefault());
    session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      // All navigations (including iframe redirects) are web-only. Other web
      // resources may use data/blob URLs; local files and shell protocols may not.
      const navigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
      const allowed = navigation ? isBrowserNavigationUrl(details.url)
        : /^(https?:|wss?:|data:|blob:)/i.test(details.url) || details.url === "about:blank";
      callback({ cancel: !allowed });
    });
  }

  start(): Promise<Record<string, string>> {
    if (this.closed) return Promise.reject(new Error("The browser is closed."));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handleHttp(req, res); });
      this.server = server;
      server.requestTimeout = 35_000;
      server.headersTimeout = 5_000;
      server.maxHeadersCount = 24;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("Browser bridge did not bind.")); return; }
        resolve({ ATOMIC_AGENT_BROWSER_ENDPOINT: `http://127.0.0.1:${address.port}/browser`, ATOMIC_AGENT_BROWSER_TOKEN: this.token });
      });
    });
    return this.startPromise;
  }

  state(): BrowserPaneState {
    return {
      mode: this.mode, activeTabId: this.activeTabId, visible: this.visible,
      tabs: [...this.tabs.values()].filter((tab) => !tab.view.webContents.isDestroyed()).map(({ tabId, view }) => ({
        tabId, url: view.webContents.getURL(), title: view.webContents.getTitle().slice(0, 500),
        loading: view.webContents.isLoading(), canGoBack: view.webContents.navigationHistory.canGoBack(),
        canGoForward: view.webContents.navigationHistory.canGoForward(),
      })),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  attachWindow(window: BrowserWindow | null): void {
    if (this.window === window) return;
    if (this.window && !this.window.isDestroyed()) {
      for (const { view } of this.tabs.values()) this.window.contentView.removeChildView(view);
    }
    this.window = window;
    if (!window) { this.takeover(); this.visible = false; }
    else for (const { view } of this.tabs.values()) window.contentView.addChildView(view);
    this.layout(); this.publish();
  }

  /** CSS viewport coordinates from the trusted shell, converted to native DIP. */
  bounds(raw: unknown): BrowserPaneState {
    const input = object(raw);
    for (const key of ["x", "y", "width", "height"]) {
      if (typeof input[key] !== "number" || !Number.isFinite(input[key])) throw new Error("Invalid browser bounds.");
    }
    const factor = this.window?.webContents.getZoomFactor() ?? 1;
    const content = this.window?.getContentBounds() ?? { width: 0, height: 0 };
    const x = Math.min(content.width, Math.max(0, Math.round((input.x as number) * factor)));
    const y = Math.min(content.height, Math.max(0, Math.round((input.y as number) * factor)));
    this.rectangle = {
      x, y,
      width: Math.max(0, Math.min(content.width - x, Math.round((input.width as number) * factor))),
      height: Math.max(0, Math.min(content.height - y, Math.round((input.height as number) * factor))),
    };
    if (typeof input.visible === "boolean") this.viewportVisible = input.visible;
    this.layout();
    return this.state();
  }

  async command(raw: unknown): Promise<BrowserPaneState> {
    if (this.closed) throw new Error("The browser is closed.");
    const input = object(raw);
    const action = input.action;
    if (action === "show") { this.visible = true; if (!this.activeTabId) this.createTab("about:blank"); }
    else if (action === "hide") { this.takeover(); this.visible = false; }
    else if (action === "takeover") this.takeover();
    else if (action === "resume") { this.invalidateLease("Browser control was resumed; read the page again."); this.mode = "agent"; this.error = undefined; }
    else {
      // Address-bar navigation and selecting another tab are explicit manual
      // control too. An approval obtained before this point cannot act later.
      this.takeover();
      if (action === "new") this.createTab(input.url === undefined ? "about:blank" : this.requireUrl(input.url));
      else {
        const tab = this.requireTab(input.tabId ?? this.activeTabId);
        if (action === "switch") this.activeTabId = tab.tabId;
        else if (action === "close") this.closeTab(tab);
        else if (action === "navigate") await this.load(tab, this.requireUrl(input.url));
        else if (action === "back") { if (tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack(); }
        else if (action === "forward") { if (tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward(); }
        else if (action === "reload") tab.view.webContents.reload();
        else if (action === "stop") tab.view.webContents.stop();
        else throw new Error("Unknown browser command.");
      }
    }
    this.layout(); this.publish();
    return this.state();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.invalidateLease("The browser is closed.");
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await this.options.browserSession.flushStorageData();
  }

  private publish(): void { if (!this.closed) this.options.onState?.(this.state()); }
  private requireUrl(raw: unknown): string {
    if (!isBrowserNavigationUrl(raw)) throw new Error("Browser navigation supports http, https and about:blank URLs only, without embedded credentials.");
    return raw;
  }
  private requireTab(raw: unknown): BrowserTab {
    const tab = typeof raw === "string" ? this.tabs.get(raw) : undefined;
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error("That browser tab is no longer available.");
    return tab;
  }

  private createTab(url?: string, select = true): BrowserTab {
    if (this.tabs.size >= MAX_TABS) throw new Error("Close a browser tab before opening another (20 tab limit).");
    const view = this.options.createView();
    const tab: BrowserTab = { tabId: randomUUID(), view, documentVersion: 0 };
    this.tabs.set(tab.tabId, tab);
    if (select || !this.activeTabId) this.activeTabId = tab.tabId;
    this.window?.contentView.addChildView(view);
    const contents = view.webContents;
    const guardNavigation = (event: Electron.Event, target: string) => { if (!isBrowserNavigationUrl(target)) event.preventDefault(); };
    contents.on("will-navigate", guardNavigation);
    contents.on("will-redirect", guardNavigation);
    contents.on("will-frame-navigate", (event) => guardNavigation(event, event.url));
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    contents.on("content-bounds-updated", (event) => event.preventDefault());
    contents.setWindowOpenHandler((details) => {
      if (!isBrowserNavigationUrl(details.url || "about:blank") || this.tabs.size >= MAX_TABS || this.closed) return { action: "deny" };
      // Electron 44 can deadlock when adopting a returned WebContentsView
      // synchronously from createWindow. Convert GET popups to safe owned tabs
      // after returning deny; opener-dependent flows use the external backend.
      setImmediate(() => {
        if (this.closed || this.tabs.size >= MAX_TABS) return;
        this.takeover();
        if (details.postBody) { this.error = "Popup form submissions require an external browser."; this.publish(); return; }
        this.createTab(details.url || "about:blank");
        this.error = "The site requested a popup. It opened in a browser tab for you to sign in; Resume agent when ready. Sign-ins that need the original popup require an external browser.";
        this.publish();
      });
      return { action: "deny" };
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown") this.directInput(contents.id, event, input);
    });
    contents.on("before-mouse-event", (event, mouse) => {
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel") this.directInput(contents.id, event, mouse);
    });
    contents.on("did-start-loading", () => this.publish());
    contents.on("did-stop-loading", () => this.publish());
    contents.on("did-navigate", () => this.publish());
    contents.on("did-navigate-in-page", () => { tab.documentVersion++; this.publish(); });
    contents.on("did-frame-navigate", () => { tab.documentVersion++; this.publish(); });
    contents.on("page-title-updated", () => this.publish());
    contents.on("render-process-gone", () => {
      this.invalidateLease("The browser page stopped. Reload it before resuming.");
      this.mode = "manual"; this.error = "The browser page stopped. Reload it before resuming."; this.publish();
    });
    contents.once("destroyed", () => {
      const wasOwned = this.tabs.delete(tab.tabId);
      if (wasOwned && this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      if (this.activeTabId === tab.tabId) this.activeTabId = this.tabs.keys().next().value ?? null;
      if (this.lease?.tabId === tab.tabId) this.invalidateLease("The browser tab closed.");
      this.layout(); this.publish();
    });
    if (url !== undefined) {
      tab.initialLoad = this.load(tab, this.requireUrl(url));
      void tab.initialLoad.catch((error: unknown) => {
        this.error = error instanceof Error ? error.message : "The page could not load."; this.publish();
      });
    }
    this.layout(); this.publish();
    return tab;
  }

  private directInput(contentsId: number, event: Electron.Event, input: { type: string; key?: string; x?: number; y?: number; button?: string }): void {
    if (this.mode !== "agent") return;
    const expected = this.injectingInput.get(contentsId);
    if (expected && input.type === expected.type && input.key === expected.key && input.button === expected.button &&
      (expected.x === undefined || Math.abs((input.x ?? Infinity) - expected.x) < 1) &&
      (expected.y === undefined || Math.abs((input.y ?? Infinity) - expected.y) < 1)) {
      // Exempt only this one expected synthetic event. An unrelated native
      // click/key still takes over even while a CDP input command is pending.
      this.injectingInput.delete(contentsId);
      return;
    }
    // Consume the first click/key: it cancels the agent before the person can
    // alter the page. The UI announces manual mode; subsequent input is normal.
    event.preventDefault(); this.takeover(); this.publish();
  }

  private async load(tab: BrowserTab, url: string): Promise<void> {
    this.error = undefined;
    await tab.view.webContents.loadURL(url);
  }

  private closeTab(tab: BrowserTab): void {
    if (this.lease?.tabId === tab.tabId) this.invalidateLease("The browser tab closed.");
    this.tabs.delete(tab.tabId);
    if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    if (this.activeTabId === tab.tabId) this.activeTabId = this.tabs.keys().next().value ?? null;
  }

  private layout(): void {
    for (const { tabId, view } of this.tabs.values()) {
      view.setBounds(this.rectangle);
      view.setVisible(Boolean(this.window && this.visible && this.viewportVisible && this.rectangle.width > 0 && this.rectangle.height > 0 && tabId === this.activeTabId));
    }
  }

  private takeover(): void {
    this.mode = "manual";
    this.invalidateLease("Browser control was taken over. Ask the user to Resume agent, then read the page again.");
    for (const { view } of this.tabs.values()) {
      if (view.webContents.isDestroyed()) continue;
      view.webContents.stop();
      if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
    }
  }

  private invalidateLease(reason: string): void {
    this.epoch++;
    this.lease?.controller.abort(new Error(reason));
    this.lease = null;
    // Core's screenshot finally block may lose its lease during takeover or
    // cancellation. Only this fixed cleanup runs without that lease; it never
    // reads page content or accepts agent-supplied JavaScript.
    for (const { view } of this.tabs.values()) {
      try {
        if (view.webContents.isDestroyed()) continue;
        for (const frame of view.webContents.mainFrame.framesInSubtree) {
          try {
            if (!frame.detached) void frame.executeJavaScript("document.getElementById('__atomic_agent_embedded_mask')?.remove()", false).catch(() => undefined);
          } catch { /* A frame can detach during cancellation; never block the other frames. */ }
        }
      } catch { /* A destroyed target has no remaining mask to clean. */ }
    }
  }

  private requireLease(raw: unknown): Lease {
    if (this.mode !== "agent") throw new Error("Browser is under manual control. Ask the user to Resume agent before continuing.");
    if (typeof raw !== "string" || !this.lease || raw !== this.lease.id || this.lease.epoch !== this.epoch) throw new Error("Browser control expired. Read the page again before acting.");
    return this.lease;
  }

  private async rpc(input: JsonObject): Promise<unknown> {
    if (this.closed) throw new Error("The browser is closed.");
    if (input.operation === "state") return this.mode === "agent" ? this.state() : { mode: this.mode, activeTabId: this.activeTabId, tabs: [], visible: this.visible };
    if (input.operation === "cancel") {
      if (typeof input.leaseId !== "string" || input.leaseId.length < 16 || input.leaseId.length > 128) throw new Error("Invalid browser cancellation.");
      const now = Date.now();
      for (const [id, expires] of this.cancelledLeases) if (expires < now) this.cancelledLeases.delete(id);
      this.cancelledLeases.set(input.leaseId, now + 120_000);
      if (this.cancelledLeases.size > 512) this.cancelledLeases.delete(this.cancelledLeases.keys().next().value!);
      if (this.lease?.id === input.leaseId) {
        const tab = this.tabs.get(this.lease.tabId); this.invalidateLease("Browser action was cancelled.");
        if (tab && !tab.view.webContents.isDestroyed()) { tab.view.webContents.stop(); if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach(); }
      }
      return {};
    }
    if (this.mode !== "agent") throw new Error("Browser is under manual control. Ask the user to Resume agent before continuing.");
    if (input.operation === "ready") {
      if (!this.activeTabId) this.createTab("about:blank");
      const tab = this.requireTab(this.activeTabId);
      await tab.initialLoad;
      this.visible = true; this.layout(); this.publish(); return this.state();
    }
    if (input.operation === "acquire") {
      const id = input.leaseId === undefined ? randomUUID() : input.leaseId;
      if (typeof id !== "string" || !/^[a-f\d-]{36}$/i.test(id)) throw new Error("Invalid browser lease identifier.");
      if ((this.cancelledLeases.get(id) ?? 0) > Date.now()) throw new Error("Browser action was cancelled before it acquired control.");
      if (this.lease) throw new Error("Another browser action is in progress.");
      if (!this.activeTabId) this.createTab("about:blank");
      const tab = this.requireTab(this.activeTabId);
      this.lease = { id, tabId: tab.tabId, epoch: this.epoch, controller: new AbortController() };
      return { leaseId: this.lease.id, tabId: tab.tabId, epoch: this.epoch };
    }
    const lease = this.requireLease(input.leaseId);
    if (input.operation === "release") { this.lease = null; return {}; }
    if (input.operation === "tabs") {
      const action = input.action ?? "list";
      if (action === "new") {
        const tab = this.createTab(input.url === undefined ? "about:blank" : this.requireUrl(input.url));
        lease.tabId = tab.tabId;
        if (tab.initialLoad) await this.bounded(tab.initialLoad, lease);
      } else if (action === "switch") {
        const tab = this.requireTab(input.tabId); this.activeTabId = tab.tabId; lease.tabId = tab.tabId;
      } else if (action === "close") {
        const tab = this.requireTab(input.tabId ?? this.activeTabId);
        // Keep the tool's lease pinned to the remaining active tab so its
        // post-action observation uses the same approval/takeover boundary.
        if (lease.tabId === tab.tabId) lease.tabId = "";
        this.closeTab(tab);
        if (!this.activeTabId) {
          const blank = this.createTab("about:blank");
          if (blank.initialLoad) await this.bounded(blank.initialLoad, lease);
        }
        lease.tabId = this.requireTab(this.activeTabId).tabId;
      } else if (action !== "list") throw new Error("Unknown browser tabs action.");
      this.layout(); this.publish(); return this.state();
    }
    if (input.operation === "frames") {
      if (input.tabId !== lease.tabId) throw new Error("Browser command does not own that tab.");
      const tab = this.requireTab(input.tabId);
      const nativeFrames = tab.view.webContents.mainFrame.framesInSubtree;
      if (nativeFrames.length > 1000) throw new Error("The browser frame tree exceeds the safety limit.");
      const frames = nativeFrames.map((frame) => {
        if (frame.detached) throw new Error("The browser frame tree changed. Read the page again.");
        return {
          identity: `${frame.processId}:${frame.routingId}:${frame.frameTreeNodeId}`,
          url: frame.url, processId: frame.processId, routingId: frame.routingId,
          frameTreeNodeId: frame.frameTreeNodeId, parentFrameTreeNodeId: frame.parent?.frameTreeNodeId ?? null,
          frameToken: frame.frameToken,
        };
      });
      return { frames, signature: JSON.stringify({ documentVersion: tab.documentVersion, frames }) };
    }
    if (input.operation !== "cdp") throw new Error("Unknown browser bridge operation.");
    if (input.tabId !== lease.tabId) throw new Error("Browser command does not own that tab.");
    const tab = this.requireTab(input.tabId);
    if (typeof input.method !== "string" || !CDP_METHODS.has(input.method)) throw new Error("That browser debugging method is not allowed.");
    const params = input.params === undefined ? {} : object(input.params);
    if (input.method === "Page.navigate") this.requireUrl(params.url);
    if (input.method.startsWith("Input.") && (!this.window || this.window.isDestroyed() || !this.window.isVisible() || this.window.isMinimized() ||
      !this.visible || !this.viewportVisible || this.rectangle.width <= 0 || this.rectangle.height <= 0 || this.activeTabId !== tab.tabId)) {
      throw new Error("Show the Browser pane before the agent can interact with this page.");
    }
    // CDP may address only this WebContents' main session. There is no browser
    // debugging socket, target discovery, cookie API or optional sessionId.
    const debuggerApi = tab.view.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    const isInput = input.method.startsWith("Input.");
    if (input.method === "Input.dispatchMouseEvent") {
      const types: Record<string, string> = { mousePressed: "mouseDown", mouseReleased: "mouseUp", mouseMoved: "mouseMove", mouseWheel: "mouseWheel" };
      this.injectingInput.set(tab.view.webContents.id, { type: types[String(params.type)] ?? "", x: Number(params.x), y: Number(params.y), button: params.button as string | undefined });
    } else if (input.method === "Input.dispatchKeyEvent") {
      this.injectingInput.set(tab.view.webContents.id, { type: params.type === "keyUp" ? "keyUp" : "keyDown", key: params.key as string | undefined });
    }
    try {
      const result = await this.bounded(debuggerApi.sendCommand(input.method, params), lease);
      this.requireLease(lease.id); return result;
    } finally { if (isInput) this.injectingInput.delete(tab.view.webContents.id); }
  }

  private bounded<T>(pending: Promise<T>, lease: Lease): Promise<T> {
    return new Promise((resolve, reject) => {
      const signal = lease.controller.signal;
      const abort = () => { cleanup(); reject(signal.reason ?? new Error("Browser action cancelled.")); };
      const timer = setTimeout(() => {
        this.invalidateLease("Browser action timed out.");
        const tab = this.tabs.get(lease.tabId);
        if (tab && !tab.view.webContents.isDestroyed()) { tab.view.webContents.stop(); if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach(); }
      }, this.options.commandTimeoutMs ?? 30_000);
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      pending.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    });
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const answer = (status: number, body: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${this.token}`;
    const authBytes = Buffer.from(auth); const expectedBytes = Buffer.from(expected);
    if (authBytes.length !== expectedBytes.length || !timingSafeEqual(authBytes, expectedBytes)) { answer(401, { error: "Unauthorized." }); return; }
    if (req.method !== "POST" || req.url !== "/browser" || req.headers.origin || req.headers["content-type"]?.split(";")[0] !== "application/json") { answer(400, { error: "Invalid browser bridge request." }); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_REQUEST_BYTES) { answer(413, { error: "Browser request is too large." }); return; }
        chunks.push(buffer);
      }
      const input = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = await this.rpc(input);
      answer(200, { result });
    } catch (error: unknown) { answer(409, { error: error instanceof Error ? error.message : "Browser command failed." }); }
  }
}
