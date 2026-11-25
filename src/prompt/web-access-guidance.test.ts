import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import { buildStablePrefix, type CapabilitiesSummary } from "./stable-prefix.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "./tool-descriptors.js";
import { applyToolSearch } from "../tools/tool-search/tool-search-policy.js";
import { roleAdmits } from "../tools/tool-roles.js";
import { createEmptySessionState } from "../session/session-state.js";
import { toolResultTurn, userTurn } from "../session/conversation-turn.js";

const capabilities: CapabilitiesSummary = {
  platform: "linux", arch: "arm64", browserChannel: "chrome", workingDir: "/fixture",
  hasClipboard: false, hasWmctrl: false, hasNotifications: false,
};
const variants = [false, true].flatMap((compactPrompt) =>
  (["grammar", "native_tools"] as const).flatMap((toolTransport) =>
    (["local", "cloud"] as const).map((mode) => ({ compactPrompt, toolTransport, mode }))),
);

describe("browser-first web access", () => {
  it.each(variants)("reaches the actual $mode/$toolTransport prompt (compact=$compactPrompt) without mutable prefix data", ({ compactPrompt, toolTransport, mode }) => {
    const session = createEmptySessionState({ id: "web-access", workingDir: "/fixture" });
    session.turns = [userTurn("Read this website.", 1)];
    const input = {
      session, capabilities, skillCatalog: [],
      toolDescriptors: applyToolSearch(DEFAULT_TOOL_DESCRIPTORS, true),
      contextWindow: 200_000, tokenBudget: 30_000, compactPrompt, toolTransport,
      modelMode: { mode, source: "provider" as const, providerId: "fixture", modelId: "fixture" },
    };
    const first = buildPrompt(input);
    expect(first.stablePrefix).toMatch(/Web(?: access)?: default to `browser\.\*`/);
    expect(first.stablePrefix).toContain("available for your role");
    expect(first.stablePrefix).toContain("built-in desktop");
    expect(first.stablePrefix).toContain("`browser.search`");
    expect(first.stablePrefix).toContain("`browser.navigate`");
    expect(first.stablePrefix).toContain("`browser.read_aria` full/region");
    expect(first.stablePrefix).toMatch(/Never bypass (?:a )?browser error/);
    expect(first.stablePrefix).toMatch(/approval|declined approval/);
    expect(first.stablePrefix).toMatch(/manual takeover|manual control/);
    expect(first.stablePrefix).not.toMatch(/LAST RESORT|Last resort|ALWAYS-FIRST/);
    expect(first.messages.system).toBe(first.stablePrefix);
    expect(first.stablePrefix).toMatch(/- browser\.search —[^\n]+\n  args: \{ query: string, engine\?: string \}/);

    session.worldSnapshot = { kind: "browser", digest: "page-2", text: "url: https://mutable.example/page\n[e7] button Continue", capturedAt: 2 };
    session.turns.push(toolResultTurn({ tool: "browser.read_aria", status: "error", summary: "Browser is under manual control.", at: 3 }));
    const next = buildPrompt(input);
    expect(next.stablePrefix).toBe(first.stablePrefix);
    expect(next.stablePrefix).not.toContain("mutable.example");
    expect(next.text).toContain("mutable.example");
  });

  it.each([false, true])("keeps explicit fallback and API guidance when compact=%s", (compact) => {
    const prefix = buildStablePrefix({ toolDescriptors: DEFAULT_TOOL_DESCRIPTORS, capabilities, skillCatalog: [], compact });
    for (const tool of ["os.web.search", "os.web.fetch"]) {
      const line = prefix.split("\n").find((row) => row.startsWith(`- ${tool} —`));
      expect(line).toMatch(/Fallback/);
      expect(line).toContain("unavailable for your role");
      expect(line).toContain("explicitly request");
    }
    const http = prefix.split("\n").find((row) => row.startsWith("- os.http.request —"));
    expect(http).toContain("APIs");
    expect(http).not.toContain("use os.web.fetch");
  });

  it("does not advertise browser tools when disabled or relax read-only role restrictions", () => {
    const toolDescriptors = DEFAULT_TOOL_DESCRIPTORS.filter((tool) => !tool.name.startsWith("browser."));
    const prefix = buildStablePrefix({ toolDescriptors, capabilities, skillCatalog: [], compact: true, toolRole: "orchestrator" });
    expect(prefix).not.toMatch(/^- browser\./m);
    expect(prefix).toContain("unavailable for your role");
    expect(roleAdmits("orchestrator", "browser.navigate")).toBe(false);
    expect(roleAdmits("orchestrator", "browser.search")).toBe(false);
    expect(roleAdmits("orchestrator", "os.web.search")).toBe(true);
    expect(roleAdmits("orchestrator", "os.web.fetch")).toBe(true);
  });
});
