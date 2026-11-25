import type { BrowserBackend } from "./browser-backend.js";
import {
  EMPTY_DOMAIN_POLICY,
  type BrowserDomainPolicy,
} from "./browser-domain-policy.js";
import { readAriaView, type AriaSnapshotStore, type AriaViewContext } from "./aria-view.js";
import type { ToolContext } from "../tool-registry.js";

export interface CapturedWorldSnapshot {
  kind: "browser";
  digest: string;
  text: string;
}

/** Automatic action feedback stays small; explicit full reads remain available. */
export const POST_ACTION_MAX_CHARS = 8_000;

/**
 * Best-effort ARIA snapshot right after a navigation/search/action, so the
 * step-executor can fold it into `session.worldSnapshot` and the model
 * observes the current page in the next prompt's `### world` section.
 * Navigation/search use the model's default (`aria-view.ts`). Click/type
 * feedback uses the interactive view capped at 8k chars (or the smaller
 * context budget), avoiding a second inference just to request fresh refs.
 *
 * Swallows snapshot failures on purpose: the mutating tool (navigate,
 * search, …) already succeeded, and we do not want an ARIA timeout to
 * flip the tool status to `error`. Callers just skip the field when
 * `undefined` is returned. A page on a blocked host
 * (`browser.blockedDomains`), or embedding one in a frame, is never
 * captured: its content must not reach the model. In the user's own
 * Chrome a site not cleared this session (a redirect went elsewhere) is
 * not captured either; browser.read_aria asks for it (`gate-page-read.ts`).
 */
export async function captureWorldSnapshot(
  backend: BrowserBackend,
  ctx: Pick<ToolContext, "modelMode" | "contextWindowTokens" | "sessionId"> & Partial<Pick<ToolContext, "signal">>,
  policy: BrowserDomainPolicy = EMPTY_DOMAIN_POLICY,
  store?: AriaSnapshotStore,
  afterAction = false,
): Promise<CapturedWorldSnapshot | undefined> {
  const view: AriaViewContext = {
    ...(ctx.modelMode ? { modelMode: ctx.modelMode } : {}),
    ...(ctx.contextWindowTokens !== undefined ? { contextWindowTokens: ctx.contextWindowTokens } : {}),
    sessionId: ctx.sessionId,
  };
  try {
    ctx.signal?.throwIfAborted();
    const result = await readAriaView(backend, afterAction ? { mode: "interactive", maxChars: POST_ACTION_MAX_CHARS } : {}, view, policy, store);
    ctx.signal?.throwIfAborted();
    if (result.kind !== "ok") return undefined;
    return { kind: "browser", digest: result.view.digest, text: result.view.text };
  } catch {
    return undefined;
  }
}
