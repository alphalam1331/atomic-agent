/**
 * Reproducible browser IO benchmark, using only loopback and disposable state.
 * Run: node --import tsx scripts/benchmark-browser.mjs [label]
 * Requires a locally installed Chromium-family browser; no account or network.
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PlaywrightBackend } from "../src/tools/browser/playwright-backend.ts";
import { ariaCharBudget, readAriaView, renderAriaView } from "../src/tools/browser/aria-view.ts";
import { buildBrowserClickTool } from "../src/tools/browser/click.ts";

const sections = Array.from({ length: 80 }, (_, section) => `<section role="region" aria-label="Section ${section}">
  <h2>Section ${section}</h2>
  ${Array.from({ length: 20 }, (_, row) => `<p>Entry ${section}-${row}: fixture text that represents surrounding page content.</p><button type="button">Inspect ${section}-${row}</button>`).join("\n")}
</section>`).join("\n");
const html = `<!doctype html><html><head><title>Browser IO fixture</title></head><body>
  <button id="toggle" type="button" onclick="this.textContent=this.textContent==='Expand'?'Collapse':'Expand'">Expand</button>
  <main>${sections}</main></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No loopback address");
const url = `http://127.0.0.1:${address.port}/`;
const state = await mkdtemp(join(tmpdir(), "atomic-browser-benchmark-"));
const browsers = [];
const ctx = { workingDir: state, sessionId: "benchmark", stepIndex: 0, signal: new AbortController().signal, modelMode: "cloud", contextWindowTokens: 200_000 };
const options = { approvalRequired: false };
const samples = {};
const bytes = {};
const times = async (name, count, operation) => {
  samples[name] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const result = await operation(i);
    samples[name].push(performance.now() - start);
    if (typeof result === "string") bytes[name] = result.length;
  }
};
try {
  await times("coldStartup", 3, async (i) => {
    const backend = new PlaywrightBackend({ userDataDir: join(state, `profile-${i}`), channel: "chrome", headless: true, noSandbox: true, launchTimeoutMs: 20_000 });
    browsers.push(backend);
    await backend.ensureReady();
  });
  const backend = browsers.at(-1);
  await backend.navigate({ url });
  const full = await backend.snapshot({ full: true });
  const regionRef = /region "Section 0" \[ref=([A-Za-z0-9]+)\]/.exec(full.text)?.[1];
  const toggleRef = /button "Expand" \[ref=([A-Za-z0-9]+)\]/.exec(full.text)?.[1];
  if (!regionRef || !toggleRef) throw new Error("Fixture refs missing");
  // Warm up browser internals before measuring steady-state reads/actions.
  await readAriaView(backend, { mode: "full" }, ctx);
  await times("warmEnsureReady", 20, () => backend.ensureReady());
  await times("fullRead", 12, async () => {
    const result = await readAriaView(backend, { mode: "full" }, ctx);
    if (result.kind !== "ok") throw new Error(result.kind);
    return result.view.text;
  });
  await times("interactiveRead", 12, async () => {
    const result = await readAriaView(backend, { mode: "interactive" }, ctx);
    if (result.kind !== "ok") throw new Error(result.kind);
    return result.view.text;
  });
  // The previous implementation extracted the whole page before filtering.
  await times("wholeTreeRegionRead", 12, async () => {
    const snapshot = await backend.snapshot({ full: true });
    const view = renderAriaView({ snapshot, mode: "region", ref: regionRef, maxChars: ariaCharBudget(ctx.contextWindowTokens) });
    if ("error" in view) throw new Error(view.error);
    return view.text;
  });
  await times("regionRead", 12, async () => {
    const result = await readAriaView(backend, { mode: "region", ref: regionRef }, ctx);
    if (result.kind !== "ok") throw new Error(result.kind);
    return result.view.text;
  });
  // A locator snapshot intentionally exposes only that subtree's refs.
  // Refresh the whole-page ref map before acting on its top-level toggle.
  await backend.snapshot({ full: true });
  await times("locatorClickOnly", 12, () => backend.click({ ref: toggleRef }));
  const click = buildBrowserClickTool(backend, options);
  const current = await backend.snapshot({ full: true });
  let currentClickRef = /button "(?:Expand|Collapse)"[^\n]*\[ref=([A-Za-z0-9]+)\]/.exec(current.text)?.[1];
  if (!currentClickRef) throw new Error("Current toggle ref missing");
  await times("clickTool", 12, async () => {
    const result = await click.run({ ref: currentClickRef }, ctx);
    if (result.status !== "ok") throw new Error(result.summary);
    const world = result.details.worldSnapshot?.text ?? "";
    currentClickRef = /\[([A-Za-z0-9]+)\] button "(?:Expand|Collapse)"/.exec(world)?.[1] ?? currentClickRef;
    return world;
  });
  const metrics = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return [name, { samples: sorted.length, medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)), p95Ms: Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)].toFixed(2)), ...(name in bytes ? { observationChars: bytes[name] } : {}) }];
  }));
  console.log(JSON.stringify({ label: process.argv[2] ?? "current", node: process.version, platform: process.platform, architecture: process.arch, fixture: { sections: 80, controls: 1601, fullChars: full.text.length }, metrics }, null, 2));
} finally {
  await Promise.allSettled(browsers.map((backend) => backend.shutdown()));
  await new Promise((resolve) => server.close(resolve));
  await rm(state, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
