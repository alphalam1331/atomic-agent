import { ConfigValidationError } from "./config-validation-error.js";
import { parseNonEmptyString } from "./config-primitives.js";
import type { TaskSchedule } from "../tasks/task-types.js";

/** ATO-445: signature presets for an inbound webhook; see `WebhookConfig`. */
export type WebhookVerify = "header" | "github" | "stripe" | "standard";

export const WEBHOOK_VERIFY_PRESETS: readonly WebhookVerify[] = [
  "header",
  "github",
  "stripe",
  "standard",
];

export function isWebhookVerify(value: unknown): value is WebhookVerify {
  return (
    typeof value === "string" &&
    (WEBHOOK_VERIFY_PRESETS as readonly string[]).includes(value)
  );
}

/**
 * The key bytes a Standard Webhooks secret stands for: base64 after an
 * optional `whsec_` prefix. `null` when that is not valid non-empty base64.
 */
export function standardWebhookKey(secret: string): Buffer | null {
  const encoded = secret.startsWith("whsec_")
    ? secret.slice("whsec_".length)
    : secret;
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    return null;
  }
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

/**
 * Declarative binding between an inbound webhook URL path and the task
 * it materialises. Per-webhook config lets operators point external
 * systems (e.g. a GitHub hook, a cron-like SaaS) at atomic-agent
 * without writing code — the HTTP layer turns each hit into a task.
 *
 * `sessionMode` drives session continuity across repeated hits:
 *  - `ephemeral`   — fresh ephemeral session per hit (default when no
 *    schedule is set; matches CLI one-shot behaviour)
 *  - `persistent`  — a single session created on the first hit and
 *    reused forever; sessionId persisted in
 *    `<stateDir>/webhook-sessions.json` keyed by webhook name
 *  - `named`       — explicit `sessionId` supplied by the operator; no
 *    persistence file, no auto-creation
 *
 * `userMessageTemplate` supports `{{body.<json.path>}}` placeholders
 * against the parsed JSON request body. `secret`, when set, is
 * checked in addition to the global API-key check, the way `verify`
 * says (ATO-445, `http/webhook-signature.ts`):
 *  - `header` (default) — matched against the `x-webhook-secret` header
 *  - `github`   — HMAC of the raw body in `X-Hub-Signature-256`
 *  - `stripe`   — HMAC in `Stripe-Signature`, timestamp within 5 minutes
 *  - `standard` — Standard Webhooks `webhook-signature`; the secret is a
 *    `whsec_<base64>` key
 * Every preset but `header` needs a secret. `verify` is optional and
 * additive, so files without it keep today's behaviour and the config
 * version is unchanged.
 */
export interface WebhookConfig {
  userMessageTemplate: string;
  secret?: string;
  verify?: WebhookVerify;
  schedule?: TaskSchedule;
  sessionMode?: "ephemeral" | "persistent" | "named";
  sessionId?: string;
}

/**
 * Validate and normalise the keyed `webhooks` block. The schedule,
 * when supplied, is left as raw JSON here (cron/interval/at) — it's
 * passed to `TaskRunner.create` at dispatch time where
 * `validateSchedule` runs canonically. This keeps config parsing
 * decoupled from cron-parser, which lives behind `task-schedule.ts`.
 */
export function parseWebhookMap(
  raw: unknown,
  field: string,
): Record<string, WebhookConfig> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      field,
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const out: Record<string, WebhookConfig> = {};
  for (const [name, rawCfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        "webhook name must match [a-zA-Z0-9_-]+",
      );
    }
    if (
      rawCfg === null ||
      typeof rawCfg !== "object" ||
      Array.isArray(rawCfg)
    ) {
      throw new ConfigValidationError(
        `${field}.${name}`,
        `expected object, got ${JSON.stringify(rawCfg)}`,
      );
    }
    const cfg = rawCfg as Record<string, unknown>;
    const userMessageTemplate = parseNonEmptyString(
      cfg.userMessageTemplate,
      `${field}.${name}.userMessageTemplate`,
    );
    const sessionMode = cfg.sessionMode ?? "ephemeral";
    if (
      sessionMode !== "ephemeral" &&
      sessionMode !== "persistent" &&
      sessionMode !== "named"
    ) {
      throw new ConfigValidationError(
        `${field}.${name}.sessionMode`,
        `expected ephemeral|persistent|named, got ${JSON.stringify(sessionMode)}`,
      );
    }
    let sessionId: string | undefined;
    if (cfg.sessionId !== undefined && cfg.sessionId !== null) {
      sessionId = parseNonEmptyString(
        cfg.sessionId,
        `${field}.${name}.sessionId`,
      );
    }
    if (sessionMode === "named" && !sessionId) {
      throw new ConfigValidationError(
        `${field}.${name}.sessionId`,
        "sessionMode=named requires a non-empty sessionId",
      );
    }
    let secret: string | undefined;
    if (cfg.secret !== undefined && cfg.secret !== null) {
      secret = parseNonEmptyString(cfg.secret, `${field}.${name}.secret`);
    }
    const verify = cfg.verify ?? "header";
    if (!isWebhookVerify(verify)) {
      throw new ConfigValidationError(
        `${field}.${name}.verify`,
        `expected ${WEBHOOK_VERIFY_PRESETS.join("|")}, got ${JSON.stringify(verify)}`,
      );
    }
    if (verify !== "header" && !secret) {
      throw new ConfigValidationError(
        `${field}.${name}.secret`,
        `verify=${verify} requires a secret`,
      );
    }
    if (verify === "standard" && secret && !standardWebhookKey(secret)) {
      // Never echo the secret itself into the error.
      throw new ConfigValidationError(
        `${field}.${name}.secret`,
        "verify=standard expects a whsec_<base64> secret",
      );
    }
    let schedule: TaskSchedule | undefined;
    if (cfg.schedule !== undefined && cfg.schedule !== null) {
      schedule = parseWebhookSchedule(
        cfg.schedule,
        `${field}.${name}.schedule`,
      );
    }
    out[name] = {
      userMessageTemplate,
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
      ...(secret ? { secret } : {}),
      // Written only when it is not the default, so existing configs parse unchanged.
      ...(verify !== "header" ? { verify } : {}),
      ...(schedule ? { schedule } : {}),
    };
  }
  return out;
}

function parseWebhookSchedule(raw: unknown, field: string): TaskSchedule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(field, "expected schedule object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "at") {
    const at = obj.at;
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new ConfigValidationError(
        `${field}.at`,
        "expected finite number (Unix ms)",
      );
    }
    return { kind: "at", at };
  }
  if (obj.kind === "interval") {
    const everyMs = obj.everyMs;
    if (
      typeof everyMs !== "number" ||
      !Number.isInteger(everyMs) ||
      everyMs <= 0
    ) {
      throw new ConfigValidationError(
        `${field}.everyMs`,
        "expected positive integer",
      );
    }
    return { kind: "interval", everyMs };
  }
  if (obj.kind === "cron") {
    const expression = parseNonEmptyString(
      obj.expression,
      `${field}.expression`,
    );
    const tz = typeof obj.tz === "string" ? obj.tz : undefined;
    return { kind: "cron", expression, ...(tz ? { tz } : {}) };
  }
  throw new ConfigValidationError(
    `${field}.kind`,
    `expected at|cron|interval, got ${JSON.stringify(obj.kind)}`,
  );
}
