import { createHmac, timingSafeEqual } from "node:crypto";

import { secretEquals } from "./secret-equal.js";
import { standardWebhookKey, type WebhookVerify } from "../config/webhook-config.js";

/**
 * ATO-445: how an inbound webhook proves it came from the sender.
 *
 *  - `header`   — the caller sends the shared secret verbatim in
 *    `x-webhook-secret` (the original behaviour, and the default).
 *  - `github`   — `X-Hub-Signature-256: sha256=<hex>`, the HMAC-SHA256 of
 *    the raw request body keyed with the secret.
 *  - `stripe`   — `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`, the
 *    HMAC-SHA256 of `${t}.${rawBody}`; `t` must be within the tolerance.
 *  - `standard` — Standard Webhooks (also what Svix sends):
 *    `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64> …`,
 *    the HMAC-SHA256 of `${id}.${timestamp}.${rawBody}` keyed with the
 *    base64 bytes after the `whsec_` prefix of the secret.
 *
 * Every comparison is constant-time, and the HMACs are taken over the
 * exact bytes that arrived: a body that was re-serialised would not match.
 * Failure reasons never carry the secret or an expected signature.
 * The preset type and the `whsec_` key parsing live in
 * `config/webhook-config.ts`, where the config is validated.
 */
export type { WebhookVerify };

/** Replay window for the timestamped presets (Stripe and Standard Webhooks both default to 5 minutes). */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

export type WebhookVerifyResult = { ok: true } | { ok: false; reason: string };

export interface WebhookVerifyInput {
  verify: WebhookVerify;
  secret: string;
  /** Header lookup by lower-case name; `null` when absent. */
  header: (name: string) => string | null;
  rawBody: Buffer;
  nowMs?: number;
  toleranceSeconds?: number;
}

export function verifyWebhookSignature(input: WebhookVerifyInput): WebhookVerifyResult {
  switch (input.verify) {
    case "header":
      return secretEquals(input.header("x-webhook-secret"), input.secret)
        ? { ok: true }
        : { ok: false, reason: "missing or wrong x-webhook-secret header" };
    case "github":
      return verifyGithub(input);
    case "stripe":
      return verifyStripe(input);
    case "standard":
      return verifyStandard(input);
    default:
      return { ok: false, reason: "unknown verify preset" };
  }
}

function hmacSha256(key: string | Buffer, ...parts: Buffer[]): Buffer {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

/** Constant-time compare of a hex string the caller sent with the digest we computed. */
function hexMatches(provided: string, expected: Buffer): boolean {
  if (!/^[0-9a-fA-F]+$/.test(provided) || provided.length !== expected.length * 2) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), expected);
}

function base64Matches(provided: string, expected: Buffer): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(provided)) return false;
  const bytes = Buffer.from(provided, "base64");
  if (bytes.length !== expected.length) return false;
  return timingSafeEqual(bytes, expected);
}

function withinTolerance(
  timestampSeconds: number,
  nowMs: number,
  toleranceSeconds: number,
): boolean {
  return Math.abs(nowMs / 1000 - timestampSeconds) <= toleranceSeconds;
}

function parseUnixSeconds(raw: string | undefined | null): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function verifyGithub(input: WebhookVerifyInput): WebhookVerifyResult {
  const header = input.header("x-hub-signature-256");
  if (!header) return { ok: false, reason: "missing X-Hub-Signature-256 header" };
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(header.trim());
  if (!match) return { ok: false, reason: "malformed X-Hub-Signature-256 header" };
  const expected = hmacSha256(input.secret, input.rawBody);
  return hexMatches(match[1]!, expected)
    ? { ok: true }
    : { ok: false, reason: "signature does not match" };
}

function verifyStripe(input: WebhookVerifyInput): WebhookVerifyResult {
  const header = input.header("stripe-signature");
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  let timestamp: string | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") candidates.push(value);
  }
  const t = parseUnixSeconds(timestamp);
  if (t === null) return { ok: false, reason: "Stripe-Signature has no valid timestamp" };
  if (candidates.length === 0) return { ok: false, reason: "Stripe-Signature has no v1 signature" };
  if (
    !withinTolerance(
      t,
      input.nowMs ?? Date.now(),
      input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
    )
  ) {
    return { ok: false, reason: "timestamp outside the tolerance window" };
  }
  const expected = hmacSha256(input.secret, Buffer.from(`${timestamp!.trim()}.`, "utf8"), input.rawBody);
  // Check every candidate so the time taken does not say which one matched.
  let matched = false;
  for (const candidate of candidates) {
    if (hexMatches(candidate, expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature does not match" };
}

function verifyStandard(input: WebhookVerifyInput): WebhookVerifyResult {
  // Svix sends the same scheme under `svix-*` names.
  const id = input.header("webhook-id") ?? input.header("svix-id");
  const timestamp = input.header("webhook-timestamp") ?? input.header("svix-timestamp");
  const signature = input.header("webhook-signature") ?? input.header("svix-signature");
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing webhook-id, webhook-timestamp or webhook-signature header" };
  }
  const t = parseUnixSeconds(timestamp);
  if (t === null) return { ok: false, reason: "webhook-timestamp is not a Unix time in seconds" };
  if (
    !withinTolerance(
      t,
      input.nowMs ?? Date.now(),
      input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
    )
  ) {
    return { ok: false, reason: "timestamp outside the tolerance window" };
  }
  const key = standardWebhookKey(input.secret);
  if (!key) return { ok: false, reason: "configured secret is not a whsec_ base64 key" };
  const expected = hmacSha256(key, Buffer.from(`${id}.${timestamp.trim()}.`, "utf8"), input.rawBody);
  let matched = false;
  for (const entry of signature.trim().split(/\s+/)) {
    const comma = entry.indexOf(",");
    if (comma <= 0) continue;
    if (entry.slice(0, comma) !== "v1") continue;
    if (base64Matches(entry.slice(comma + 1), expected)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature does not match" };
}
