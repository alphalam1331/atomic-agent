/** Private, authenticated bridge to the desktop's agent-owned WebContentsViews. */
export interface EmbeddedBrowserTransportOptions {
  endpoint: string;
  token: string;
  /** Test seam; production uses Node's pooled HTTP implementation. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface EmbeddedBrowserRequest {
  operation: "ready" | "state" | "frames" | "acquire" | "release" | "cancel" | "tabs" | "cdp";
  leaseId?: string;
  tabId?: string;
  action?: "list" | "new" | "switch" | "close";
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
}

export class EmbeddedBrowserTransport {
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly controllers = new Set<AbortController>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: EmbeddedBrowserTransportOptions) {
    const url = new URL(options.endpoint);
    // Never forward the desktop's capability token to a remote host, redirect,
    // URL credentials or a proxy selected by page content.
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.hash || !options.token.trim()) {
      throw new Error("Embedded browser requires an authenticated loopback HTTP endpoint");
    }
    this.endpoint = url.href;
    this.requestFetch = options.fetch ?? globalThis.fetch;
  }

  request<T>(request: EmbeddedBrowserRequest, signal?: AbortSignal): Promise<T> {
    // Cancellation must be able to interrupt a CDP command already in flight.
    if (request.operation === "cancel") return this.performRequest<T>(request, signal);
    const pending = this.queue.then(() => this.performRequest<T>(request, signal));
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async performRequest<T>(request: EmbeddedBrowserRequest, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Embedded browser transport is closed");
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("Embedded browser request timed out")), this.options.timeoutMs ?? 35_000);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.requestFetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      // A pathological accessibility tree must not allocate an unbounded body.
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Embedded browser bridge returned an empty response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("Embedded browser response exceeds the safety limit");
        }
        chunks.push(next.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object") throw new Error("Invalid embedded browser response");
      if ("error" in value) throw new Error(typeof value.error === "string" ? value.error : "Embedded browser operation failed");
      if (!response.ok) throw new Error(`Embedded browser bridge rejected the request (${response.status})`);
      if (!("result" in value)) throw new Error("Invalid embedded browser response");
      signal?.throwIfAborted();
      return value.result as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    }
  }

  close(): void {
    this.closed = true;
    for (const controller of this.controllers) controller.abort(new Error("Embedded browser shut down"));
    this.controllers.clear();
  }
}

/** Both values must be supplied by desktop startup; CLI/TUI retain Playwright. */
export function embeddedBrowserOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv,
): EmbeddedBrowserTransportOptions | undefined {
  const endpoint = environment.ATOMIC_AGENT_BROWSER_ENDPOINT;
  const token = environment.ATOMIC_AGENT_BROWSER_TOKEN;
  return endpoint && token ? { endpoint, token } : undefined;
}
