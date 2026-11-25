import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  AriaSnapshot, BrowserBackend, ClickInput, NavigateInput, RefDescription, ScreenshotInput,
  ScreenshotResult, ScrollInput, ScrollResult, SearchInput, TabInfo, TabsInput, TypeInput,
} from "./browser-backend.js";
import { describeElementInPage, toRefDescription, type RawElementFacts } from "./describe-element.js";
import { summariseAriaSnapshot } from "./aria-compressor.js";
import { embeddedAxLines, type EmbeddedAxNode } from "./embedded-browser-aria.js";
import { EmbeddedBrowserTransport, type EmbeddedBrowserTransportOptions } from "./embedded-browser-transport.js";
import { collectSecretFieldValuesInPage, ONE_TIME_CODE_HINT, redactSecretFieldValues, SECRET_AUTOCOMPLETE_TOKENS } from "./redact-secret-fields.js";
import { searchUrlFor } from "./search-engines.js";
import { planShot, type CssRect } from "./screenshot-geometry.js";

interface EmbeddedTab { tabId: string; url: string; title: string }
interface EmbeddedState { mode: "agent" | "manual"; activeTabId: string | null; tabs: EmbeddedTab[] }
interface Lease { leaseId: string; tabId: string; epoch: number }
interface NativeFrames { signature: string; frames: Array<{ identity: string; url: string; processId: number; parentFrameTreeNodeId: number | null }> }
interface Operation extends Lease { signal: AbortSignal; nativeFrames?: NativeFrames; failed?: boolean }
interface FrameTree { frame: { id: string; url: string; loaderId?: string }; childFrames?: FrameTree[] }
interface RemoteValue<T> { result: { value?: T; objectId?: string }; exceptionDetails?: unknown }
interface NodeRef { tabId: string; epoch: number; backendNodeId: number; frameId: string }

/**
 * The desktop owns Chromium and its persisted profile. This backend holds only
 * a private HTTP capability, never an Electron/global CDP browser connection.
 * A tool's lease pins one owned tab across inspection, approval and action;
 * manual takeover invalidates the lease at the desktop before another command.
 */
export class EmbeddedBrowserBackend implements BrowserBackend {
  private readonly transport: EmbeddedBrowserTransport;
  private readonly operations = new AsyncLocalStorage<Operation>();
  private readonly controllers = new Set<AbortController>();
  private readonly refs = new Map<string, NodeRef>();
  private readonly nodeRefs = new Map<string, string>();
  private readonly documents = new Map<string, string>();
  private readonly frameWorlds = new Map<string, number>();
  private lastEpoch: number | undefined;
  private nextRef = 1;
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;
  private stopped = false;

  constructor(options: EmbeddedBrowserTransportOptions) {
    this.transport = new EmbeddedBrowserTransport(options);
  }

  ensureReady(): Promise<void> {
    return this.prepareReady(this.operations.getStore()?.signal);
  }

  private prepareReady(signal?: AbortSignal): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Embedded browser has shut down"));
    this.ready ??= this.transport.request({ operation: "ready" }, signal).then(() => undefined).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async withSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const current = this.operations.getStore();
    if (current) {
      signal.throwIfAborted();
      return operation();
    }
    const previous = this.queue;
    let unlock!: () => void;
    const ticket = new Promise<void>((resolve) => { unlock = resolve; });
    this.queue = previous.then(() => ticket);
    try { await withAbort(previous, signal); }
    catch (error) { unlock(); throw error; }
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    this.controllers.add(controller);
    let lease: Lease | undefined;
    let completed = false;
    const requestedLeaseId = randomUUID();
    let acquiring = false;
    try {
      signal.throwIfAborted();
      await this.prepareReady(controller.signal);
      signal.throwIfAborted();
      acquiring = true;
      lease = await this.transport.request<Lease>({ operation: "acquire", leaseId: requestedLeaseId }, controller.signal);
      if (this.lastEpoch !== lease.epoch) {
        this.refs.clear();
        this.nodeRefs.clear();
        this.documents.clear();
        this.frameWorlds.clear();
        this.lastEpoch = lease.epoch;
      }
      const activeLease = lease;
      const cancel = () => {
        void this.transport.request({ operation: "cancel", leaseId: activeLease.leaseId }).catch(() => undefined);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        const scope: Operation = { ...lease, signal: controller.signal };
        const result = await withAbort(this.operations.run(scope, operation), controller.signal);
        controller.signal.throwIfAborted();
        completed = !scope.failed;
        return result;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.controllers.delete(controller);
      // The desktop may have acquired a lease even if its reply was lost.
      // A known client id and idempotent cancel also cover cancel-before-acquire.
      if (acquiring && (!lease || controller.signal.aborted || !completed)) {
        await this.transport.request({ operation: "cancel", leaseId: lease?.leaseId ?? requestedLeaseId }).catch(() => undefined);
      }
      if (lease) await this.transport.request({ operation: "release", leaseId: lease.leaseId }).catch(() => undefined);
      unlock();
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort(new Error("Embedded browser shut down"));
    // Cancels the sidecar's leases, not the user's embedded tabs or profile.
    await this.queue;
    this.transport.close();
    this.refs.clear();
    this.nodeRefs.clear();
    this.documents.clear();
    this.frameWorlds.clear();
  }

  snapshot(options: { depth?: number; full?: boolean; ref?: string } = {}): Promise<AriaSnapshot> {
    return this.run(async () => {
      // Bound retained ref metadata on long-lived SPAs without changing refs
      // midway through serialization of the current observation.
      if (!options.ref && this.nodeRefs.size > 50_000) { this.refs.clear(); this.nodeRefs.clear(); }
      const tree = await this.frameTree();
      const nativeBefore = this.scope().nativeFrames!;
      let refFrameId = tree.frame.id;
      const sections: Array<{ frameId: string; text: string }> = [];
      let nodes: EmbeddedAxNode[];
      let rootId: string | undefined;
      if (options.ref) {
        const ref = this.requireRef(options.ref);
        refFrameId = ref.frameId;
        await this.cdp("Accessibility.enable");
        const partial = await this.cdp<{ nodes: EmbeddedAxNode[] }>("Accessibility.getPartialAXTree", {
          backendNodeId: ref.backendNodeId, fetchRelatives: false,
        });
        nodes = partial.nodes;
        rootId = nodes[0]?.nodeId;
        if (!rootId) throw new Error(`ref '${options.ref}' is no longer present; read the page again`);
        // Fetch only descendants of the requested region, with a traversal cap.
        const seen = new Set(nodes.map((node) => node.nodeId));
        let frontier = [...nodes];
        for (let depth = 0; frontier.length && depth < (options.depth ?? 40) && seen.size < 12_000; depth += 1) {
          const next: EmbeddedAxNode[] = [];
          for (const node of frontier) {
            if (!node.childIds?.length) continue;
            const children = await this.cdp<{ nodes: EmbeddedAxNode[] }>("Accessibility.getChildAXNodes", { id: node.nodeId, frameId: refFrameId });
            for (const child of children.nodes) {
              if (!seen.has(child.nodeId)) { seen.add(child.nodeId); nodes.push(child); next.push(child); }
            }
          }
          frontier = next;
        }
      } else {
        nodes = (await this.cdp<{ nodes: EmbeddedAxNode[] }>("Accessibility.getFullAXTree", {
          frameId: tree.frame.id,
          ...(options.depth !== undefined ? { depth: options.depth } : {}),
        })).nodes;
        // Chromium's main AX tree stops at iframe boundaries, even for an
        // in-process child. Read each reachable frame explicitly.
        for (const { frame } of flattenFrames(tree).slice(1)) {
          const child = await this.cdp<{ nodes: EmbeddedAxNode[] }>("Accessibility.getFullAXTree", {
            frameId: frame.id, ...(options.depth !== undefined ? { depth: options.depth } : {}),
          });
          sections.push({ frameId: frame.id, text: embeddedAxLines(child.nodes, (id) => this.refFor(id, frame.id), { depth: options.depth }) });
        }
      }
      const frameReads = await Promise.all(flattenFrames(tree).map(async (frame) => {
        // Read title and masking values together; retain only the isolated
        // context id between reads, never page content or credentials.
        const expression = `({title:document.title,secrets:(${collectSecretFieldValuesInPage.toString()})(${JSON.stringify({ tokens: [...SECRET_AUTOCOMPLETE_TOKENS], codeHint: ONE_TIME_CODE_HINT })})})`;
        return this.frameEvaluate<{ title: string; secrets: string[] }>(frame.frame.id, expression);
      }));
      const metadata = { url: tree.frame.url, title: frameReads[0]?.title ?? "" };
      const secretValues = frameReads.flatMap((read) => read.secrets);
      let raw = embeddedAxLines(nodes, (id) => this.refFor(id, refFrameId), { rootId, depth: options.depth });
      for (const section of sections) {
        const url = flattenFrames(tree).find(({ frame }) => frame.id === section.frameId)?.frame.url ?? "";
        raw += `\n  - iframe ${JSON.stringify(url)}\n${section.text.split("\n").map((line) => `    ${line}`).join("\n")}`;
      }
      if (nativeBefore.frames.length > flattenFrames(tree).length) {
        raw += "\n… [cross-process frame content unavailable; open its URL in an agent tab to read or operate it]";
      }
      const after = await this.frameTree();
      if (frameSignature(tree) !== frameSignature(after) || nativeBefore.signature !== this.scope().nativeFrames?.signature) {
        throw new Error("The page or a frame changed during the accessibility read; read the page again");
      }
      const summary = summariseAriaSnapshot(redactSecretFieldValues(raw, secretValues), metadata,
        options.full ? { maxLines: 12_000, maxChars: 1_000_000, dropNoise: false } : {});
      return { ...metadata, ...summary, frameUrls: [...new Set([...nativeBefore.frames.map((frame) => frame.url), ...flattenFrames(tree).map((frame) => frame.frame.url)])],
        ...(options.ref ? { regionRef: options.ref } : {}) };
    });
  }

  hasRef(ref: string): Promise<boolean> {
    return this.run(async () => {
      try {
        await this.frameTree();
        return await this.onNode<boolean>(ref, "function(){return this.isConnected === true}") === true;
      } catch { return false; }
    });
  }

  describeRef(ref: string): Promise<RefDescription | null> {
    return this.run(async () => {
      try {
        await this.frameTree();
        const raw = await this.onNode<RawElementFacts>(ref, `function(){return (${describeElementInPage.toString()})(this)}`);
        return toRefDescription(raw, await this.currentUrl());
      } catch { return null; }
    });
  }

  currentUrl(): Promise<string> {
    return this.run(async () => (await this.frameTree()).frame.url);
  }

  navigate(input: NavigateInput): Promise<{ url: string; title: string }> {
    return this.run(async () => {
      if (input.waitUntil === "networkidle") {
        throw new Error("The embedded browser supports domcontentloaded and load waits; networkidle requires the external browser backend");
      }
      const result = await this.cdp<{ errorText?: string; loaderId?: string }>("Page.navigate", { url: input.url });
      if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
      this.clearTabRefs();
      const deadline = Date.now() + Math.max(1, Math.min(input.timeoutMs ?? 30_000, 120_000));
      for (;;) {
        this.scope().signal.throwIfAborted();
        const tree = await this.frameTree();
        const state = await this.evaluate<string>("document.readyState");
        const committed = !result.loaderId || tree.frame.loaderId === result.loaderId;
        if (committed && (state === "complete" || (input.waitUntil !== "load" && state === "interactive"))) {
          return this.metadata(await this.frameTree());
        }
        if (Date.now() >= deadline) throw new Error("Embedded browser navigation timed out");
        await pause(25, this.scope().signal);
      }
    });
  }

  click(input: ClickInput): Promise<{ clickedRef: string }> {
    return this.run(async () => {
      const tree = await this.frameTree();
      const ref = this.requireRef(input.ref);
      await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
      const local = await this.onNode<{ x: number; y: number } | null>(input.ref, `function(){
        if(!this.isConnected || this.matches(':disabled') || this.getAttribute('aria-disabled')==='true') return false;
        const r=this.getBoundingClientRect(),w=this.ownerDocument.defaultView,s=w.getComputedStyle(this);
        if(r.width<=0 || r.height<=0 || s.visibility!=='visible' || s.display==='none' || Number(s.opacity)===0) return false;
        const hit=this.ownerDocument.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        const control=this.closest('button,a[href],[role=button],[role=link],[role=menuitem],[role=tab]')||this;
        return !!hit && (control===hit || control.contains(hit)) ? {x:r.x+r.width/2,y:r.y+r.height/2} : null;
      }`);
      if (!local) throw new Error(`ref '${input.ref}' is disabled, hidden or covered; read the page again before clicking`);
      const point = await this.rootPoint(local, ref.frameId, tree, true);
      const { x, y } = point;
      const modifiers = (input.modifiers ?? []).reduce((bits, key) => bits | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[key]), 0);
      const button = input.button ?? "left";
      await this.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, modifiers, clickCount: 1 });
      await this.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, modifiers, clickCount: 1 });
      return { clickedRef: input.ref };
    });
  }

  type(input: TypeInput): Promise<{ typedLength: number }> {
    return this.run(async () => {
      await this.frameTree();
      const ref = this.requireRef(input.ref);
      await this.cdp("DOM.focus", { backendNodeId: ref.backendNodeId });
      await this.onNode(input.ref, `function(){
        if(this.disabled || this.readOnly) throw new Error('Field is not editable');
        if(this.ownerDocument.activeElement!==this && !this.contains(this.ownerDocument.activeElement)) throw new Error('Field lost focus');
        if(typeof this.select === 'function') this.select();
        else if(this.isContentEditable){const r=this.ownerDocument.createRange();r.selectNodeContents(this);const s=this.ownerDocument.getSelection();s.removeAllRanges();s.addRange(r)}
        else throw new Error('Ref is not a text field');
      }`);
      await this.cdp("Input.insertText", { text: input.text });
      if (input.pressEnter) {
        await this.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await this.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }
      return { typedLength: input.text.length };
    });
  }

  async search(input: SearchInput): Promise<{ url: string }> {
    const result = await this.navigate({ url: searchUrlFor(input.engine ?? "google", input.query) });
    return { url: result.url };
  }

  tabs(input: TabsInput): Promise<{ tabs: TabInfo[] }> {
    return this.run(async () => {
      const scope = this.scope();
      const before = await this.transport.request<EmbeddedState>({ operation: "state" }, scope.signal);
      const target = input.index === undefined ? undefined : before.tabs[input.index];
      if ((input.action === "switch" || input.action === "close") && !target) throw new Error("browser.tabs: index is out of range");
      const state = await this.transport.request<EmbeddedState>({ operation: "tabs", leaseId: scope.leaseId,
        action: input.action, ...(target ? { tabId: target.tabId } : {}), ...(input.url ? { url: input.url } : {}) }, scope.signal);
      if (state.activeTabId) scope.tabId = state.activeTabId;
      return { tabs: state.tabs.map((tab, index) => ({ index, url: tab.url, title: tab.title, active: tab.tabId === state.activeTabId })) };
    });
  }

  scroll(input: ScrollInput): Promise<ScrollResult> {
    return this.run(() => this.evaluate<ScrollResult>(`(() => {
      const direction=${JSON.stringify(input.direction)},amount=${JSON.stringify(input.amount ?? "page")};
      const vh=innerHeight||800,h=document.documentElement.scrollHeight;
      if(direction==='top')scrollTo({top:0,behavior:'instant'});
      else if(direction==='bottom')scrollTo({top:h,behavior:'instant'});
      else scrollBy({top:(direction==='up'?-1:1)*(typeof amount==='number'?amount:amount==='half'?Math.floor(vh/2):vh),behavior:'instant'});
      return {scrollY:Math.round(scrollY),scrollHeight:Math.round(h),viewportHeight:vh};
    })()`));
  }

  screenshot(input: ScreenshotInput): Promise<ScreenshotResult> {
    return this.run(async () => {
      const before = await this.frameTree();
      const nativeBefore = this.scope().nativeFrames!;
      const nativeMain = nativeBefore.frames.find((frame) => frame.parentFrameTreeNodeId === null) ?? nativeBefore.frames[0];
      const nativeUrls = nativeBefore.frames.map((frame) => frame.url).sort();
      const cdpUrls = flattenFrames(before).map(({ frame }) => frame.url).sort();
      if (!nativeMain || nativeBefore.frames.some((frame) => frame.processId !== nativeMain.processId) ||
          JSON.stringify(nativeUrls) !== JSON.stringify(cdpUrls)) {
        throw new Error("Cannot safely mask every embedded frame for this screenshot; open the frame in an agent tab and retry");
      }
      if (input.ref) await this.cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: this.requireRef(input.ref).backendNodeId });
      const metrics = await this.evaluate<{ x: number; y: number; width: number; height: number; scrollWidth: number; scrollHeight: number; dpr: number }>(
        "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,dpr:devicePixelRatio})");
      let rect: CssRect = input.fullPage ? { x: 0, y: 0, width: metrics.scrollWidth, height: metrics.scrollHeight }
        : { x: metrics.x, y: metrics.y, width: metrics.width, height: metrics.height };
      if (input.ref) {
        const ref = this.requireRef(input.ref);
        const local = await this.onNode<CssRect>(input.ref, "function(){const r=this.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}");
        const point = await this.rootPoint(local, ref.frameId, before);
        rect = { x: point.x + metrics.x, y: point.y + metrics.y, width: local.width * point.scaleX, height: local.height * point.scaleY };
      }
      const plan = planShot(rect, metrics.dpr, input.maxSide, input.fullPage === true);
      if (!plan) throw new Error("The screenshot region has no visible area");
      const frames = flattenFrames(before);
      const masked: string[] = [];
      let shot: { data: string };
      try {
        for (const frame of frames) {
          await this.frameEvaluate(frame.frame.id, "(() => {const id='__atomic_agent_embedded_mask';document.getElementById(id)?.remove();const s=document.createElement('style');s.id=id;s.textContent='input,textarea,[contenteditable=true]{-webkit-text-security:disc!important}';document.documentElement.appendChild(s)})()");
          masked.push(frame.frame.id);
        }
        shot = await this.cdp<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: input.quality,
          clip: { ...plan.clip, scale: plan.scale }, captureBeyondViewport: input.fullPage === true });
      } finally {
        for (const frameId of masked) await this.frameEvaluate(frameId, "document.getElementById('__atomic_agent_embedded_mask')?.remove()").catch(() => undefined);
      }
      const after = await this.frameTree();
      const beforeFrames = new Map(frames.map((frame) => [frame.frame.id, frame.frame]));
      if (nativeBefore.signature !== this.scope().nativeFrames?.signature || flattenFrames(after).some(({ frame }) => {
        const original = beforeFrames.get(frame.id);
        return !masked.includes(frame.id) || !original || original.loaderId !== frame.loaderId || original.url !== frame.url;
      })) throw new Error("The page or a frame changed during the screenshot; retry the capture");
      return { buffer: Buffer.from(shot.data, "base64"), width: plan.width, height: plan.height, mime: "image/jpeg",
        ...(await this.metadata(after)), frameUrls: [...new Set([...nativeBefore.frames.map((frame) => frame.url),
          ...this.scope().nativeFrames!.frames.map((frame) => frame.url), ...[...flattenFrames(before), ...flattenFrames(after)].map((frame) => frame.frame.url)])], clipped: plan.clipped };
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    return this.operations.getStore() ? operation() : this.withSignal(new AbortController().signal, operation);
  }
  private scope(): Operation {
    const scope = this.operations.getStore();
    if (!scope) throw new Error("Embedded browser operation has no lease");
    scope.signal.throwIfAborted();
    return scope;
  }
  private cdp<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const scope = this.scope();
    return this.transport.request<T>({ operation: "cdp", leaseId: scope.leaseId, tabId: scope.tabId, method, params }, scope.signal)
      .catch((error: unknown) => { scope.failed = true; throw error; });
  }
  private async evaluate<T>(expression: string, contextId?: number): Promise<T> {
    const value = await this.cdp<RemoteValue<T>>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true,
      ...(contextId !== undefined ? { contextId } : {}) });
    if (value.exceptionDetails) throw new Error("Could not read the embedded page");
    return value.result.value as T;
  }
  private async frameEvaluate<T>(frameId: string, expression: string): Promise<T> {
    const key = `${this.scope().tabId}:${this.scope().epoch}:${frameId}`;
    let contextId = this.frameWorlds.get(key);
    if (contextId === undefined) {
      const world = await this.cdp<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId, worldName: "atomic-agent-browser" });
      contextId = world.executionContextId;
      this.frameWorlds.set(key, contextId);
    }
    try { return await this.evaluate<T>(expression, contextId); }
    catch (error) { this.frameWorlds.delete(key); throw error; }
  }
  private async frameTree(): Promise<FrameTree> {
    const tree = (await this.cdp<{ frameTree: FrameTree }>("Page.getFrameTree")).frameTree;
    const scope = this.scope();
    const native = await this.transport.request<NativeFrames>({ operation: "frames", leaseId: scope.leaseId, tabId: scope.tabId }, scope.signal);
    scope.nativeFrames = native;
    const tabId = scope.tabId;
    const signature = `${native.signature}:${frameSignature(tree)}`;
    if (this.documents.has(tabId) && this.documents.get(tabId) !== signature) this.clearTabRefs();
    this.documents.set(tabId, signature);
    return tree;
  }
  private async metadata(tree: FrameTree): Promise<{ url: string; title: string }> {
    return { url: tree.frame.url, title: await this.evaluate<string>("document.title") };
  }
  private refFor(backendNodeId: number, frameId: string): string {
    const scope = this.scope();
    const key = `${scope.tabId}:${scope.epoch}:${frameId}:${backendNodeId}`;
    let ref = this.nodeRefs.get(key);
    if (!ref) {
      ref = `e${this.nextRef++}`;
      this.nodeRefs.set(key, ref);
      this.refs.set(ref, { tabId: scope.tabId, epoch: scope.epoch, backendNodeId, frameId });
    }
    return ref;
  }
  private requireRef(ref: string): NodeRef {
    const found = this.refs.get(ref);
    const scope = this.scope();
    if (!found || found.tabId !== scope.tabId || found.epoch !== scope.epoch) throw new Error(`ref '${ref}' is stale; call browser.read_aria`);
    return found;
  }
  private clearTabRefs(): void {
    const tabId = this.scope().tabId;
    for (const [ref, node] of this.refs) if (node.tabId === tabId) this.refs.delete(ref);
    for (const key of this.nodeRefs.keys()) if (key.startsWith(`${tabId}:`)) this.nodeRefs.delete(key);
    for (const key of this.frameWorlds.keys()) if (key.startsWith(`${tabId}:`)) this.frameWorlds.delete(key);
  }
  /** Compose DOM-local coordinates; CDP box models can already be root-relative. */
  private async rootPoint(point: { x: number; y: number }, frameId: string, tree: FrameTree, checkHit = false): Promise<{ x: number; y: number; scaleX: number; scaleY: number }> {
    const parents = new Map<string, string>();
    const collect = (parent: FrameTree) => {
      for (const child of parent.childFrames ?? []) { parents.set(child.frame.id, parent.frame.id); collect(child); }
    };
    collect(tree);
    let x = point.x, y = point.y, scaleX = 1, scaleY = 1;
    let current = frameId;
    while (current !== tree.frame.id) {
      const parent = parents.get(current);
      if (!parent) throw new Error("Cannot resolve this iframe's coordinates; open it in an agent tab");
      const owner = await this.cdp<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: current });
      const box = await this.onBackendNode<CssRect | null>(owner.backendNodeId, `function(){
        /* local iframe content geometry */
        const w=this.ownerDocument.defaultView,r=this.getBoundingClientRect(),s=w.getComputedStyle(this);
        for(let n=this;n;n=n.parentElement){const style=w.getComputedStyle(n);
          if(style.perspective!=='none' || (style.rotate!=='none' && parseFloat(style.rotate)!==0)) return null;
          if(style.transform!=='none'){const m=new w.DOMMatrix(style.transform);if(!m.is2D || Math.abs(m.b)>0.0001 || Math.abs(m.c)>0.0001 || m.a<=0 || m.d<=0)return null;}
          if(style.scale!=='none' && style.scale.split(/\\s+/).some(v=>Number(v)<=0))return null;
        }
        if(!this.offsetWidth || !this.offsetHeight)return null;
        const sx=r.width/this.offsetWidth,sy=r.height/this.offsetHeight;
        const pl=parseFloat(s.paddingLeft)||0,pr=parseFloat(s.paddingRight)||0,pt=parseFloat(s.paddingTop)||0,pb=parseFloat(s.paddingBottom)||0;
        return {x:r.x+(this.clientLeft+pl)*sx,y:r.y+(this.clientTop+pt)*sy,width:(this.clientWidth-pl-pr)*sx,height:(this.clientHeight-pt-pb)*sy};
      }`);
      if (!box) {
        throw new Error("Rotated or skewed iframes require opening the frame in an agent tab");
      }
      const viewport = await this.frameEvaluate<{ width: number; height: number }>(current, "({width:innerWidth,height:innerHeight})");
      const sx = box.width / viewport.width, sy = box.height / viewport.height;
      if (!(sx > 0 && sy > 0 && Number.isFinite(sx) && Number.isFinite(sy))) throw new Error("The iframe has no visible area");
      x = box.x + x * sx; y = box.y + y * sy; scaleX *= sx; scaleY *= sy;
      if (checkHit) {
        const visible = await this.onBackendNode<boolean>(owner.backendNodeId, `function(x,y){
          /* parent frame hit test */
          const hit=this.ownerDocument.elementFromPoint(x,y),s=this.ownerDocument.defaultView.getComputedStyle(this);
          return this.isConnected && s.visibility==='visible' && Number(s.opacity)!==0 && !!hit && (hit===this || this.contains(hit));
        }`, [x, y]);
        if (!visible) throw new Error("The iframe is hidden or covered in its parent; read the page again before clicking");
      }
      current = parent;
    }
    return { x, y, scaleX, scaleY };
  }
  private async onNode<T>(ref: string, functionDeclaration: string): Promise<T> {
    const node = this.requireRef(ref);
    return this.onBackendNode<T>(node.backendNodeId, functionDeclaration);
  }
  private async onBackendNode<T>(backendNodeId: number, functionDeclaration: string, args: unknown[] = []): Promise<T> {
    const remote = await this.cdp<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId });
    const objectId = remote.object.objectId;
    if (!objectId) throw new Error("The browser node is no longer present");
    try {
      const result = await this.cdp<RemoteValue<T>>("Runtime.callFunctionOn", { objectId, functionDeclaration, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error("Could not inspect the browser node");
      return result.result.value as T;
    } finally {
      await this.cdp("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }
}

function flattenFrames(tree: FrameTree): FrameTree[] {
  return [tree, ...(tree.childFrames ?? []).flatMap(flattenFrames)];
}

function frameSignature(tree: FrameTree): string {
  return JSON.stringify(flattenFrames(tree).map(({ frame }) => [frame.id, frame.loaderId, frame.url]).sort());
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
  });
}
