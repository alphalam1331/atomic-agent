import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedBrowserTransport, embeddedBrowserOptionsFromEnvironment } from "./embedded-browser-transport.js";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });

describe("embedded browser transport", () => {
  it("uses an authenticated, pooled loopback HTTP bridge and surfaces takeover failures", async () => {
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer private-desktop-capability");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const value = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(value);
      res.setHeader("content-type", "application/json");
      if (value.operation === "acquire") { res.statusCode = 409; res.end(JSON.stringify({ error: "Browser is under manual control. Resume agent first." })); }
      else res.end(JSON.stringify({ result: { mode: "agent" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    resources.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test port");
    const bridge = new EmbeddedBrowserTransport({ endpoint: `http://127.0.0.1:${address.port}/browser`, token: "private-desktop-capability" });
    expect(await bridge.request({ operation: "state" })).toEqual({ mode: "agent" });
    await expect(bridge.request({ operation: "acquire" })).rejects.toThrow("manual control");
    expect(requests).toEqual([{ operation: "state" }, { operation: "acquire" }]);
    bridge.close();
    await expect(bridge.request({ operation: "state" })).rejects.toThrow("closed");
  });

  it.each(["https://127.0.0.1/browser", "http://example.com/browser", "http://localhost/browser", "http://user:pass@127.0.0.1/browser", "file:///browser"])("refuses sending a capability to %s", (endpoint) => {
    expect(() => new EmbeddedBrowserTransport({ endpoint, token: "secret" })).toThrow("loopback");
  });

  it("requires both desktop environment values", () => {
    expect(embeddedBrowserOptionsFromEnvironment({ ATOMIC_AGENT_BROWSER_ENDPOINT: "http://127.0.0.1:1234/browser" })).toBeUndefined();
    expect(embeddedBrowserOptionsFromEnvironment({ ATOMIC_AGENT_BROWSER_TOKEN: "secret" })).toBeUndefined();
    expect(embeddedBrowserOptionsFromEnvironment({ ATOMIC_AGENT_BROWSER_ENDPOINT: "http://127.0.0.1:1234/browser", ATOMIC_AGENT_BROWSER_TOKEN: "secret" })).toEqual({ endpoint: "http://127.0.0.1:1234/browser", token: "secret" });
  });

  it("aborts in-flight HTTP and never sends an already cancelled request", async () => {
    const requestFetch = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const bridge = new EmbeddedBrowserTransport({ endpoint: "http://127.0.0.1:1234/browser", token: "secret", fetch: requestFetch });
    const controller = new AbortController();
    const pending = bridge.request({ operation: "state" }, controller.signal);
    await vi.waitFor(() => expect(requestFetch).toHaveBeenCalledOnce());
    controller.abort(new Error("turn cancelled"));
    await expect(pending).rejects.toThrow("turn cancelled");
    await expect(bridge.request({ operation: "ready" }, controller.signal)).rejects.toThrow("turn cancelled");
    expect(requestFetch).toHaveBeenCalledOnce();
    bridge.close();
  });

  it("serializes commands while allowing cancellation to interrupt the current one", async () => {
    const requests: string[] = [];
    let complete!: () => void;
    const requestFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      requests.push(input.operation);
      if (input.operation === "cdp") await new Promise<void>((resolve) => { complete = resolve; });
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    });
    const bridge = new EmbeddedBrowserTransport({ endpoint: "http://127.0.0.1:1234/browser", token: "secret", fetch: requestFetch });
    const first = bridge.request({ operation: "cdp" });
    const second = bridge.request({ operation: "state" });
    await vi.waitFor(() => expect(requests).toEqual(["cdp"]));
    await bridge.request({ operation: "cancel" });
    expect(requests).toEqual(["cdp", "cancel"]);
    complete();
    await Promise.all([first, second]);
    expect(requests).toEqual(["cdp", "cancel", "state"]);
    bridge.close();
  });
});
