import { describe, expect, it, vi } from "vitest";
import { EmbeddedBrowserBackend } from "./embedded-browser-backend.js";
import { embeddedAxLines, type EmbeddedAxNode } from "./embedded-browser-aria.js";
import type { EmbeddedBrowserRequest } from "./embedded-browser-transport.js";

function harness(options: { timeoutMs?: number } = {}) {
  let epoch = 0;
  let leaseId: string | null = null;
  let leaseCount = 0;
  let url = "https://example.com/";
  let loader = "document-1";
  let readyState = "complete";
  let actionable = true;
  let parentActionable = true;
  let frameChanged = false;
  let redirectDuringRead = false;
  let crossProcessFrame = false;
  let nestedFrame = false;
  let holdAcquire = false;
  let pendingMethod: string | undefined;
  const requests: EmbeddedBrowserRequest[] = [];
  const nodes: EmbeddedAxNode[] = [
    { nodeId: "root", role: { value: "RootWebArea" }, backendDOMNodeId: 1, childIds: ["button", "field", "region"] },
    { nodeId: "button", role: { value: "button" }, name: { value: "Read secret123" }, backendDOMNodeId: 2 },
    { nodeId: "field", role: { value: "textbox" }, name: { value: "Verification code" }, backendDOMNodeId: 3, childIds: ["value"] },
    { nodeId: "value", role: { value: "StaticText" }, name: { value: "secret123" }, backendDOMNodeId: 4 },
    { nodeId: "region", role: { value: "region" }, name: { value: "Details" }, backendDOMNodeId: 5, childIds: ["child"] },
    { nodeId: "child", role: { value: "link" }, name: { value: "More details" }, backendDOMNodeId: 6 },
  ];
  const state = () => ({ mode: "agent", activeTabId: "tab-1", tabs: [{ tabId: "tab-1", url, title: "Fixture" }] });
  const requestFetch = vi.fn<typeof fetch>(async (_endpoint, init) => {
    const input = JSON.parse(String(init?.body)) as EmbeddedBrowserRequest;
    requests.push(input);
    const answer = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });
    if (input.operation === "ready" || input.operation === "state" || input.operation === "tabs") return answer(state());
    if (input.operation === "acquire") {
      leaseId = input.leaseId ?? `lease-${++leaseCount}`;
      if (holdAcquire) return new Promise((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }); });
      return answer({ leaseId, tabId: "tab-1", epoch });
    }
    if (input.operation === "release" || input.operation === "cancel") { leaseId = null; return answer({}); }
    if (input.leaseId !== leaseId) return new Response(JSON.stringify({ error: "Browser control expired. Read the page again." }), { status: 409 });
    if (input.operation === "frames") return answer({ signature: `${url}:${loader}:${crossProcessFrame}:${nestedFrame}`, frames: [
      { identity: "root", url, processId: 1, parentFrameTreeNodeId: null },
      { identity: "child", url: "https://frame.example/", processId: 1, parentFrameTreeNodeId: 1 },
      ...(nestedFrame ? [{ identity: "nested", url: "https://nested.example/", processId: 1, parentFrameTreeNodeId: 2 }] : []),
      ...(crossProcessFrame ? [{ identity: "hidden", url: "https://blocked.example/hidden-frame", processId: 2, parentFrameTreeNodeId: 1 }] : []),
    ] });
    if (input.method === pendingMethod) return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    switch (input.method) {
      case "Page.getFrameTree": return answer({ frameTree: { frame: { id: "frame-1", url, loaderId: loader }, childFrames: [{ frame: { id: "frame-2", url: "https://frame.example/", loaderId: "child-1" },
        ...(nestedFrame ? { childFrames: [{ frame: { id: "frame-3", url: "https://nested.example/", loaderId: "nested-1" } }] } : {}) }] } });
      case "Page.createIsolatedWorld": return answer({ executionContextId: 1 });
      case "Accessibility.getFullAXTree":
        if (redirectDuringRead) { url = "https://blocked.example/"; loader = "blocked-document"; }
        return answer({ nodes });
      case "Accessibility.getPartialAXTree": return answer({ nodes: nodes.filter((node) => node.backendDOMNodeId === input.params?.backendNodeId) });
      case "Accessibility.getChildAXNodes": return answer({ nodes: nodes.filter((node) => nodes.find((parent) => parent.nodeId === input.params?.id)?.childIds?.includes(node.nodeId)) });
      case "DOM.resolveNode": return answer({ object: { objectId: `object-${input.params?.backendNodeId}` } });
      case "Runtime.callFunctionOn": {
        const source = String(input.params?.functionDeclaration);
        if (source.includes("describeElementInPage") || source.includes("target.closest")) return answer({ result: { value: {
          tag: "button", targetTag: "button", role: "button", name: "Read", type: "button", autocomplete: null, fieldHints: "", editable: false,
          inForm: false, formAction: null, formMethod: null, inSearchForm: false, isSubmit: false, href: null, frameUrl: "https://frame.example/",
        } } });
        if (source.includes("parent frame hit test")) return answer({ result: { value: parentActionable } });
        if (source.includes("local iframe content geometry")) return answer({ result: { value: input.params?.objectId === "object-101" ? { x: 30, y: 40, width: 400, height: 300 } : { x: 200, y: 100, width: 400, height: 300 } } });
        if (source.includes("elementFromPoint")) return answer({ result: { value: actionable ? { x: 60, y: 25 } : null } });
        return answer({ result: { value: true } });
      }
      case "Runtime.evaluate": {
        const expression = String(input.params?.expression);
        if (expression === "document.title") return answer({ result: { value: "Fixture" } });
        if (expression === "document.readyState") return answer({ result: { value: readyState } });
        if (expression.includes("collectSecretFieldValuesInPage") || expression.includes("codeField")) return answer({ result: { value: expression.includes("secrets:") ? { title: "Fixture", secrets: ["secret123"] } : ["secret123"] } });
        if (expression.includes("scrollWidth")) return answer({ result: { value: { x: 0, y: 0, width: 800, height: 600, scrollWidth: 800, scrollHeight: 1200, dpr: 1 } } });
        if (expression === "({width:innerWidth,height:innerHeight})") return answer({ result: { value: { width: 400, height: 300 } } });
        return answer({ result: {} });
      }
      case "DOM.getBoxModel": return answer({ model: { content: input.params?.backendNodeId === 100 ? [200, 100, 600, 100, 600, 400, 200, 400] : [10, 10, 110, 10, 110, 40, 10, 40] } });
      case "DOM.getFrameOwner": return answer({ backendNodeId: input.params?.frameId === "frame-3" ? 101 : 100 });
      case "Page.navigate": url = String(input.params?.url); loader = "document-2"; return answer({ loaderId: loader });
      case "Page.captureScreenshot": if (frameChanged) loader = "racing-document"; return answer({ data: Buffer.from("jpeg").toString("base64") });
      default: return answer({});
    }
  });
  const backend = new EmbeddedBrowserBackend({ endpoint: "http://127.0.0.1:1234/browser", token: "private", fetch: requestFetch, ...options });
  return { backend, requests, nodes, takeover() { epoch++; leaseId = null; }, setActionable(value: boolean) { actionable = value; },
    setReady(value: string) { readyState = value; }, changeFrameDuringShot() { frameChanged = true; }, hold(method?: string) { pendingMethod = method; },
    redirectDuringRead() { redirectDuringRead = true; }, changePage() { url = "https://blocked.example/"; loader = "blocked-document"; },
    addCrossProcessFrame() { crossProcessFrame = true; }, holdAcquire(value: boolean) { holdAcquire = value; },
    coverParentFrame() { parentActionable = false; }, addNestedFrame() { nestedFrame = true; } };
}

describe("embedded browser backend", () => {
  it("masks values, includes every frame URL and keeps refs stable across leases", async () => {
    const h = harness();
    const first = await h.backend.snapshot();
    expect(first.text).toContain("Read ••••");
    expect(first.text).not.toContain("secret123");
    expect(first.frameUrls).toEqual(["https://example.com/", "https://frame.example/"]);
    expect((await h.backend.snapshot()).refs).toEqual(first.refs);
    h.takeover();
    expect(await h.backend.hasRef(first.refs[1]!)).toBe(false);
    await h.backend.shutdown();
  });

  it("holds one tab lease across preflight, approval inspection and the native action", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    const ref = snapshot.refs[1]!;
    const start = h.requests.length;
    await h.backend.withSignal(new AbortController().signal, async () => {
      expect(await h.backend.hasRef(ref)).toBe(true);
      expect((await h.backend.describeRef(ref))?.pageUrl).toBe("https://frame.example/");
      await h.backend.click({ ref });
    });
    const calls = h.requests.slice(start);
    expect(calls.filter((call) => call.operation === "acquire")).toHaveLength(1);
    expect(new Set(calls.filter((call) => call.operation === "cdp").map((call) => call.leaseId)).size).toBe(1);
    expect(calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params?.type)).toEqual(["mousePressed", "mouseReleased"]);
    await h.backend.shutdown();
  });

  it("refuses occluded/disabled elements before injecting input", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    h.setActionable(false);
    await expect(h.backend.click({ ref: snapshot.refs[1]! })).rejects.toThrow("covered");
    expect(h.requests.some((call) => call.method?.startsWith("Input."))).toBe(false);
    await h.backend.shutdown();
  });

  it("rejects an approval obtained before manual takeover", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    await expect(h.backend.withSignal(new AbortController().signal, async () => {
      await h.backend.describeRef(snapshot.refs[1]!);
      h.takeover();
      await h.backend.click({ ref: snapshot.refs[1]! });
    })).rejects.toThrow("expired");
    expect(h.requests.some((call) => call.method?.startsWith("Input."))).toBe(false);
    await h.backend.shutdown();
  });

  it("refuses refs when a page redirects while approval is pending", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    await expect(h.backend.withSignal(new AbortController().signal, async () => {
      await h.backend.describeRef(snapshot.refs[1]!);
      h.changePage();
      await h.backend.click({ ref: snapshot.refs[1]! });
    })).rejects.toThrow("stale");
    expect(h.requests.some((call) => call.method?.startsWith("Input."))).toBe(false);
    await h.backend.shutdown();
  });

  it("discards accessibility content that races a redirect to a blocked page", async () => {
    const h = harness();
    h.redirectDuringRead();
    await expect(h.backend.snapshot()).rejects.toThrow("changed during the accessibility read");
    await h.backend.shutdown();
  });

  it("reads only the requested AX subtree for region views", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    const region = /region "Details" \[ref=(e\d+)\]/.exec(snapshot.text)?.[1];
    expect(region).toBeDefined();
    const start = h.requests.length;
    const partial = await h.backend.snapshot({ ref: region, full: true });
    expect(partial.regionRef).toBe(region);
    expect(partial.text).toContain("More details");
    expect(partial.text).not.toContain("Verification code");
    expect(h.requests.slice(start).some((call) => call.method === "Accessibility.getFullAXTree")).toBe(false);
    await h.backend.shutdown();
  });

  it("includes hidden cross-process frame URLs and refuses screenshots it cannot mask", async () => {
    const h = harness();
    h.addCrossProcessFrame();
    const snapshot = await h.backend.snapshot();
    expect(snapshot.frameUrls).toContain("https://blocked.example/hidden-frame");
    expect(snapshot.text).toContain("cross-process frame content unavailable");
    await expect(h.backend.screenshot({ maxSide: 1280, quality: 70 })).rejects.toThrow("mask every embedded frame");
    expect(h.requests.some((call) => call.method === "Page.captureScreenshot")).toBe(false);
    await h.backend.shutdown();
  });

  it("reads in-process child AX trees and maps their click coordinates to the root viewport", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    const childText = snapshot.text.slice(snapshot.text.indexOf('- iframe "https://frame.example/"'));
    const childButton = /button "Read ••••" \[ref=(e\d+)\]/.exec(childText)?.[1];
    expect(childButton).toBeDefined();
    expect(h.requests.some((call) => call.method === "Accessibility.getFullAXTree" && call.params?.frameId === "frame-2")).toBe(true);
    await h.backend.click({ ref: childButton! });
    expect(h.requests.find((call) => call.method === "Input.dispatchMouseEvent")?.params).toMatchObject({ x: 260, y: 125 });
    await h.backend.shutdown();
  });

  it("refuses iframe clicks when an ancestor document overlays the iframe", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    const childText = snapshot.text.slice(snapshot.text.indexOf('- iframe "https://frame.example/"'));
    const childButton = /button "Read ••••" \[ref=(e\d+)\]/.exec(childText)?.[1];
    h.coverParentFrame();
    await expect(h.backend.click({ ref: childButton! })).rejects.toThrow("covered in its parent");
    expect(h.requests.some((call) => call.method?.startsWith("Input."))).toBe(false);
    await h.backend.shutdown();
  });

  it("composes local coordinates through nested iframe parents exactly once", async () => {
    const h = harness();
    h.addNestedFrame();
    const snapshot = await h.backend.snapshot();
    const nestedText = snapshot.text.slice(snapshot.text.indexOf('- iframe "https://nested.example/"'));
    const nestedButton = /button "Read ••••" \[ref=(e\d+)\]/.exec(nestedText)?.[1];
    expect(nestedButton).toBeDefined();
    await h.backend.click({ ref: nestedButton! });
    expect(h.requests.find((call) => call.method === "Input.dispatchMouseEvent")?.params).toMatchObject({ x: 290, y: 165 });
    expect(h.requests.some((call) => call.method === "DOM.getBoxModel")).toBe(false);
    await h.backend.shutdown();
  });

  it("cancels a queued browser tool promptly without releasing a preceding tool's place", async () => {
    const h = harness();
    let releaseFirst!: () => void;
    let firstStarted = false;
    let thirdStarted = false;
    const first = h.backend.withSignal(new AbortController().signal, async () => {
      firstStarted = true;
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await vi.waitFor(() => expect(firstStarted).toBe(true));
    const controller = new AbortController();
    const second = h.backend.withSignal(controller.signal, () => h.backend.currentUrl());
    const third = h.backend.withSignal(new AbortController().signal, async () => { thirdStarted = true; });
    controller.abort(new Error("queued turn stopped"));
    await expect(second).rejects.toThrow("queued turn stopped");
    expect(thirdStarted).toBe(false);
    releaseFirst();
    await Promise.all([first, third]);
    expect(thirdStarted).toBe(true);
    await h.backend.shutdown();
  });

  it("cancels a known acquisition id when the server creates a lease but its reply is lost", async () => {
    const h = harness();
    h.holdAcquire(true);
    const controller = new AbortController();
    const pending = h.backend.withSignal(controller.signal, () => h.backend.currentUrl());
    await vi.waitFor(() => expect(h.requests.some((call) => call.operation === "acquire")).toBe(true));
    const acquireId = h.requests.find((call) => call.operation === "acquire")?.leaseId;
    controller.abort(new Error("cancelled during acquire"));
    await expect(pending).rejects.toThrow("cancelled during acquire");
    expect(h.requests.some((call) => call.operation === "cancel" && call.leaseId === acquireId)).toBe(true);
    h.holdAcquire(false);
    expect(await h.backend.currentUrl()).toBe("https://example.com/");
    await h.backend.shutdown();
  });

  it("retains isolated frame contexts rather than reopening them for each warm read", async () => {
    const h = harness();
    await h.backend.snapshot();
    const initial = h.requests.filter((call) => call.method === "Page.createIsolatedWorld").length;
    await h.backend.snapshot();
    expect(h.requests.filter((call) => call.method === "Page.createIsolatedWorld")).toHaveLength(initial);
    h.changePage();
    await h.backend.snapshot();
    expect(h.requests.filter((call) => call.method === "Page.createIsolatedWorld")).toHaveLength(initial * 2);
    await h.backend.shutdown();
  });

  it("aborts in-flight commands and revokes their lease on cancellation", async () => {
    const h = harness();
    const snapshot = await h.backend.snapshot();
    h.hold("Runtime.callFunctionOn");
    const controller = new AbortController();
    const pending = h.backend.withSignal(controller.signal, () => h.backend.click({ ref: snapshot.refs[1]! }));
    await vi.waitFor(() => expect(h.requests.some((call) => call.method === "Runtime.callFunctionOn")).toBe(true));
    controller.abort(new Error("user stopped turn"));
    await expect(pending).rejects.toThrow("user stopped turn");
    expect(h.requests.some((call) => call.operation === "cancel")).toBe(true);
    expect(h.requests.some((call) => call.method?.startsWith("Input."))).toBe(false);
    await h.backend.shutdown();
  });

  it("cancels a failed operation's lease when the transport times out independently of the turn", async () => {
    const h = harness({ timeoutMs: 20 });
    const snapshot = await h.backend.snapshot();
    h.hold("Runtime.callFunctionOn");
    await expect(h.backend.click({ ref: snapshot.refs[1]! })).rejects.toThrow("timed out");
    expect(h.requests.some((call) => call.operation === "cancel")).toBe(true);
    h.hold();
    expect(await h.backend.currentUrl()).toBe("https://example.com/");
    await h.backend.shutdown();
  });

  it("rejects unsupported networkidle before navigation and bounds load waits", async () => {
    const h = harness();
    await expect(h.backend.navigate({ url: "https://example.com/", waitUntil: "networkidle" })).rejects.toThrow("networkidle");
    expect(h.requests.some((call) => call.method === "Page.navigate")).toBe(false);
    h.setReady("loading");
    await expect(h.backend.navigate({ url: "https://example.com/next", timeoutMs: 1 })).rejects.toThrow("timed out");
    await h.backend.shutdown();
  });

  it("discards a screenshot when an existing frame navigates during capture", async () => {
    const h = harness();
    h.changeFrameDuringShot();
    await expect(h.backend.screenshot({ maxSide: 1280, quality: 70 })).rejects.toThrow("changed during");
    await h.backend.shutdown();
  });
});

it("never serializes field values or editable descendants", () => {
  const nodes: EmbeddedAxNode[] = [
    { nodeId: "1", role: { value: "textbox" }, name: { value: "Password" }, backendDOMNodeId: 1, childIds: ["2"] },
    { nodeId: "2", role: { value: "StaticText" }, name: { value: "do-not-publish" }, backendDOMNodeId: 2 },
  ];
  expect(embeddedAxLines(nodes, (id) => `e${id}`)).toBe('- textbox "Password" [ref=e1]');
});
