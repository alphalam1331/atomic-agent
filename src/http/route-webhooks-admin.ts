import { randomBytes } from "node:crypto";

import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  readUserConfigSnapshotSync,
  resetConfigCache,
} from "../config/index.js";
import type { WebhookConfig } from "../config/index.js";
import {
  isSafeConfigPath,
  readRawConfigTree,
  writeRawUserConfigFileSync,
} from "../config/config-paths.js";
import {
  isWebhookVerify,
  WEBHOOK_VERIFY_PRESETS,
  type WebhookVerify,
} from "../config/webhook-config.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * ATO-445: manage the `webhooks` block from the desktop without editing
 * `config.json` by hand.
 *
 *  - `GET    /api/webhooks`        — the saved routes, never their secrets
 *  - `POST   /api/webhooks`        — `{ name, verify?, userMessageTemplate,
 *    secret?, sessionMode? }`: add a route. A secret is generated unless one
 *    is given (Stripe makes its own signing secret, so `stripe` needs it
 *    pasted). The reply carries the secret once; nothing reads it back later.
 *  - `DELETE /api/webhooks/{name}` — remove a route and its persistent session mapping
 *
 * Writes go through the same raw-tree read, full revalidation and atomic
 * write as `PATCH /api/config`, and the running agent's webhook map is
 * updated in place, so a new route answers without a restart.
 */

export interface WebhookRouteView {
  name: string;
  /** Path on this agent's HTTP server the sender posts to. */
  path: string;
  verify: WebhookVerify;
  sessionMode: "ephemeral" | "persistent" | "named";
  userMessageTemplate: string;
  hasSecret: boolean;
  /** Loaded in the running agent (false for a route added to the file by hand since it started). */
  live: boolean;
}

export function webhookView(
  name: string,
  cfg: WebhookConfig,
  live: boolean,
): WebhookRouteView {
  return {
    name,
    path: `/api/webhooks/${name}`,
    verify: cfg.verify ?? "header",
    sessionMode: cfg.sessionMode ?? "ephemeral",
    userMessageTemplate: cfg.userMessageTemplate,
    hasSecret: typeof cfg.secret === "string" && cfg.secret.length > 0,
    live,
  };
}

/** A fresh secret in the shape the preset's sender expects. */
export function generateWebhookSecret(verify: WebhookVerify): string {
  if (verify === "standard") return `whsec_${randomBytes(24).toString("base64")}`;
  return randomBytes(32).toString("hex");
}

export function createListWebhooksHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const path = getConfig().paths.userConfigFile;
    ensureUserConfigFileSync(path);
    const saved = readUserConfigSnapshotSync(path).config.webhooks ?? {};
    const live = ctx.runtime.config.webhooks;
    const webhooks = Object.entries(saved).map(([name, cfg]) =>
      webhookView(name, cfg, Object.hasOwn(live, name)),
    );
    sendJson(res, 200, {
      webhooks,
      tasksEnabled: ctx.runtime.config.tasks.enabled,
      presets: WEBHOOK_VERIFY_PRESETS,
    });
  };
}

export function createCreateWebhookHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!isPlainObject(body)) {
      sendError(res, 400, openaiError("body must be a JSON object"));
      return;
    }
    const name = body.name;
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !isSafeConfigPath(name) || name === "__proto__") {
      sendError(res, 400, openaiError("name must be 1-64 letters, digits, - or _", "invalid_request_error", "name"));
      return;
    }
    const verify = body.verify ?? "header";
    if (!isWebhookVerify(verify)) {
      sendError(res, 400, openaiError(`verify must be one of ${WEBHOOK_VERIFY_PRESETS.join(", ")}`, "invalid_request_error", "verify"));
      return;
    }
    let secret: string;
    if (body.secret !== undefined && body.secret !== null && body.secret !== "") {
      if (typeof body.secret !== "string" || body.secret.trim().length === 0) {
        sendError(res, 400, openaiError("secret must be a non-empty string", "invalid_request_error", "secret"));
        return;
      }
      secret = body.secret.trim();
    } else if (verify === "stripe") {
      sendError(res, 400, openaiError("Stripe makes the signing secret: paste the whsec_… value Stripe shows for this endpoint", "invalid_request_error", "secret"));
      return;
    } else {
      secret = generateWebhookSecret(verify);
    }
    const entry: Record<string, unknown> = {
      userMessageTemplate: body.userMessageTemplate,
      secret,
      ...(verify !== "header" ? { verify } : {}),
      ...(body.sessionMode !== undefined ? { sessionMode: body.sessionMode } : {}),
    };

    const path = getConfig().paths.userConfigFile;
    ensureUserConfigFileSync(path);
    const tree = readRawConfigTree(path);
    const current = isPlainObject(tree.webhooks) ? tree.webhooks : {};
    if (Object.hasOwn(current, name)) {
      sendError(res, 409, openaiError(`webhook already exists: ${name}`, "invalid_request_error", "name"));
      return;
    }
    tree.webhooks = { ...current, [name]: entry };
    let parsed: WebhookConfig | undefined;
    try {
      parsed = parseUserConfigFile(tree).webhooks[name];
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
    if (!parsed) {
      sendError(res, 500, openaiError("webhook did not survive validation"));
      return;
    }
    writeRawUserConfigFileSync(path, tree);
    resetConfigCache();
    ctx.runtime.config.webhooks[name] = parsed;
    sendJson(res, 201, { webhook: webhookView(name, parsed, true), secret });
  };
}

export function createDeleteWebhookHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const name = ctx.params.name;
    if (!name || !isSafeConfigPath(name)) {
      sendError(res, 400, openaiError("webhook name is required"));
      return;
    }
    const path = getConfig().paths.userConfigFile;
    ensureUserConfigFileSync(path);
    const tree = readRawConfigTree(path);
    const current = isPlainObject(tree.webhooks) ? { ...tree.webhooks } : {};
    if (!Object.hasOwn(current, name)) {
      sendError(res, 404, openaiError(`webhook not found: ${name}`));
      return;
    }
    delete current[name];
    tree.webhooks = current;
    try {
      parseUserConfigFile(tree);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
    writeRawUserConfigFileSync(path, tree);
    resetConfigCache();
    delete ctx.runtime.config.webhooks[name];
    ctx.runtime.webhookSessionStore.delete(name);
    sendJson(res, 200, { deleted: name });
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
