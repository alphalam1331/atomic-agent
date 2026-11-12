import { openaiError } from "./openai-errors.js";
import {
  parseJsonBody,
  readRawBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";
import { checkSecretHeader, verifyWebhookRequest } from "./webhook-signature.js";
import { renderWebhookTemplate } from "./webhook-template.js";
import type { WebhookConfig } from "../config/index.js";
import { TaskValidationError } from "../tasks/index.js";

/**
 * `POST /api/webhooks/:name` — generic inbound webhook route. Resolves
 * the named binding from `config.webhooks`, authenticates against the
 * binding's optional `secret` (in addition to the global API key on the
 * main server) by the `x-webhook-secret` header, a GitHub
 * `x-hub-signature-256` or a Stripe `stripe-signature` HMAC
 * (`webhook-signature.ts`, ATO-625), renders `userMessageTemplate` against the JSON body, and
 * materialises the result as a task via `TaskRunner.create`. The
 * handler NEVER calls `runTurn` directly — that invariant is what
 * keeps per-session FIFO intact under external triggers.
 *
 * Session resolution mirrors the docs in `config-schema.ts`:
 *  - `ephemeral`  -> no sessionId, runner creates one lazily per task
 *  - `persistent` -> reuse sessionId from `webhook-sessions.json`;
 *    first hit creates + persists a fresh session
 *  - `named`      -> use the configured sessionId verbatim
 *
 * Responses:
 *  - 202 `{ taskId }` on success
 *  - 404 when the webhook name is unknown or `tasks.enabled` is false
 *  - 401 on a bad/missing secret or signature (only when the config
 *    declares a secret; compared in constant time, see `secretEquals`)
 *  - 403 `webhook_secret_required` when `requireSecret` is set and the
 *    binding has no secret (the tunnel gateway: there is no API key
 *    in front of it, so a binding without a secret is never reachable)
 *  - 400 on invalid JSON body, unknown template fields, or schedule validation
 */
export interface WebhookHandlerOptions {
  /** Refuse bindings without a `secret` (the public tunnel gateway). */
  requireSecret?: boolean;
}

export function createWebhookHandler(
  options: WebhookHandlerOptions = {},
): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: ctx.params.name ?? "<unknown>",
        status: "rejected",
      });
      return;
    }
    const name = ctx.params.name;
    if (!name) {
      sendError(res, 400, openaiError("webhook name is required"));
      return;
    }
    // Own keys only: `constructor` or `__proto__` must not resolve to
    // something off Object.prototype.
    const webhooks = ctx.runtime.config.webhooks;
    const webhook = Object.hasOwn(webhooks, name) ? webhooks[name] : undefined;
    if (!webhook) {
      sendError(res, 404, openaiError(`webhook not found: ${name}`));
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: name,
        status: "rejected",
      });
      return;
    }
    const reject = (status: number, message: string, code?: string): void => {
      sendError(res, status, openaiError(message, "invalid_request_error", null, code ?? null));
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: name,
        status: "rejected",
      });
    };
    if (options.requireSecret && !webhook.secret) {
      reject(
        403,
        `webhook ${name} has no secret, so it is not reachable through the tunnel`,
        "webhook_secret_required",
      );
      return;
    }
    // A wrong plain secret header is refused before the body is read.
    if (webhook.secret && checkSecretHeader(req.headers, webhook.secret) === false) {
      reject(401, "invalid webhook secret");
      return;
    }
    let rawBody: Buffer;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      reject(400, err instanceof Error ? err.message : "invalid body");
      return;
    }
    if (webhook.secret && verifyWebhookRequest(req.headers, rawBody, webhook.secret) === null) {
      reject(401, "invalid webhook secret");
      return;
    }
    let body: unknown = {};
    try {
      body = parseJsonBody<unknown>(rawBody);
    } catch (err) {
      reject(400, err instanceof Error ? err.message : "invalid body");
      return;
    }
    const userMessage = renderWebhookTemplate(
      webhook.userMessageTemplate,
      body,
    );
    const sessionId = resolveWebhookSessionId(webhook, name, ctx.runtime);
    try {
      const created = ctx.runtime.taskRunner.create({
        ...(sessionId ? { sessionId } : {}),
        userMessage,
        origin: "http",
        triggerSource: "webhook",
        maxAttempts: ctx.runtime.config.tasks.maxAttempts,
        maxSteps: null,
        ...(webhook.schedule ? { schedule: webhook.schedule } : {}),
      });
      ctx.runtime.metrics.recordWebhookReceived({
        webhookName: name,
        status: "accepted",
      });
      sendJson(res, 202, { taskId: created.id, sessionId: created.sessionId });
    } catch (err) {
      if (err instanceof TaskValidationError) {
        sendError(
          res,
          400,
          openaiError(err.message, "invalid_request_error", err.field),
        );
        ctx.runtime.metrics.recordWebhookReceived({
          webhookName: name,
          status: "rejected",
        });
        return;
      }
      throw err;
    }
  };
}

/**
 * Resolve `sessionId` for a webhook hit based on the binding's
 * `sessionMode`. The lookup side-effects only for `persistent`
 * mode — the first hit creates a fresh session via
 * `runtime.createSession` and persists the mapping so subsequent hits
 * (and process restarts) reuse the same id.
 */
function resolveWebhookSessionId(
  webhook: WebhookConfig,
  name: string,
  runtime: {
    createSession(input?: { metadata?: Record<string, unknown> }): {
      id: string;
    };
    webhookSessionStore: {
      get(name: string): string | null;
      set(name: string, sessionId: string): void;
    };
  },
): string | null {
  const mode = webhook.sessionMode ?? "ephemeral";
  if (mode === "ephemeral") return null;
  if (mode === "named") {
    return webhook.sessionId ?? null;
  }
  const existing = runtime.webhookSessionStore.get(name);
  if (existing) return existing;
  const fresh = runtime.createSession({
    metadata: { webhookName: name, webhookPersistent: true },
  });
  runtime.webhookSessionStore.set(name, fresh.id);
  return fresh.id;
}
