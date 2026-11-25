import { describe, expect, it } from "vitest";
import type { Browser } from "playwright-core";
import { PlaywrightBackend } from "./playwright-backend.js";
import { SECRET_MASK } from "./redact-secret-fields.js";

function fixture(found = true) {
  const selectors: string[] = [];
  let captures = 0;
  const locator = {
    count: async () => found ? 1 : 0,
    first: () => locator,
    ariaSnapshot: async () => { captures += 1; return '- region "Login" [ref=e3]:\n  - textbox "Verification code" [ref=e4]: 123456'; },
  };
  const frame = { url: () => "https://blocked.example/frame", evaluate: async () => ["123456"] };
  const page = {
    locator: (selector: string) => { selectors.push(selector); return locator; },
    url: () => "https://example.com/",
    title: async () => "Login",
    frames: () => [frame],
  };
  const context = { pages: () => [page], browser: () => null, close: async () => {} };
  const browser = { contexts: () => [context] } as unknown as Browser;
  const backend = new PlaywrightBackend({
    userDataDir: "/unused-disposable-fixture", channel: "chrome", headless: true,
    launchTimeoutMs: 100, cdpUrl: "http://127.0.0.1:9222", connectOverCdp: async () => browser,
  });
  return { backend, selectors, captures: () => captures };
}

describe("Playwright locator-scoped snapshots", () => {
  it("captures the selected subtree while retaining whole-page frame checks and secret masking", async () => {
    const { backend, selectors } = fixture();
    const snapshot = await backend.snapshot({ ref: "e3", full: true });
    expect(selectors).toEqual(["aria-ref=e3"]);
    expect(snapshot.regionRef).toBe("e3");
    expect(snapshot.refs).toEqual(["e3", "e4"]);
    expect(snapshot.frameUrls).toEqual(["https://blocked.example/frame"]);
    expect(snapshot.text).not.toContain("123456");
    expect(snapshot.text).toContain(SECRET_MASK);
    await backend.shutdown();
  });

  it("does not wait for a missing region ref to appear", async () => {
    const { backend, captures } = fixture(false);
    await expect(backend.snapshot({ ref: "e3" })).rejects.toThrow(/fresh refs/);
    expect(captures()).toBe(0);
    await backend.shutdown();
  });
});
