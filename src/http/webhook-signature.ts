import { createHmac } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { secretEquals } from "./secret-equal.js";

/**
 * How a webhook hit proved it knows the binding's `secret` (ATO-625):
 *  - `header`: the `x-webhook-secret` header carries the secret itself
 *    (our own scripts, curl, services that let you set a header);
 *  - `github`: `x-hub-signature-256: sha256=<hex>`, the HMAC-SHA256 of
 *    the raw body keyed by the secret (GitHub cannot send a custom header);
 *  - `stripe`: `stripe-signature: t=<unix>,v1=<hex>[,v1=…]`, the
 *    HMAC-SHA256 of `<t>.<raw body>`, with `t` at most five minutes off.
 */
export type WebhookAuthMethod = "header" | "github" | "stripe";

/** Stripe's own default replay window, in seconds. */
export const STRIPE_TOLERANCE_SECONDS = 300;

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/**
 * The plain `x-webhook-secret` check, which needs no body. `null` when
 * the header is absent (the caller then reads the body and tries the
 * signatures), otherwise whether it matches, in constant time.
 */
export function checkSecretHeader(
  headers: IncomingHttpHeaders,
  secret: string,
): boolean | null {
  const provided = header(headers, "x-webhook-secret");
  if (provided === null) return null;
  return secretEquals(provided, secret);
}

/**
 * Verify a webhook hit against the binding's secret. Returns the method
 * that matched, or `null` when none did. The first scheme whose header is
 * present decides: a wrong `x-webhook-secret` is not rescued by a
 * signature header sent next to it.
 */
export function verifyWebhookRequest(
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  secret: string,
  nowMs: number = Date.now(),
): WebhookAuthMethod | null {
  if (secret.length === 0) return null;
  const plain = checkSecretHeader(headers, secret);
  if (plain !== null) return plain ? "header" : null;
  const github = header(headers, "x-hub-signature-256");
  if (github !== null) return verifyGithubSignature(github, rawBody, secret) ? "github" : null;
  const stripe = header(headers, "stripe-signature");
  if (stripe !== null) return verifyStripeSignature(stripe, rawBody, secret, nowMs) ? "stripe" : null;
  return null;
}

function hmacHex(secret: string, data: Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** GitHub: `sha256=` + hex HMAC-SHA256 of the raw body. */
export function verifyGithubSignature(
  value: string,
  rawBody: Buffer,
  secret: string,
): boolean {
  const provided = value.trim().toLowerCase();
  if (!provided.startsWith("sha256=")) return false;
  return secretEquals(provided, `sha256=${hmacHex(secret, rawBody)}`);
}

/**
 * Stripe: `t=<unix seconds>,v1=<hex>` (several `v1` while a secret is
 * being rolled). The signed payload is `<t>.<raw body>`; a timestamp more
 * than `STRIPE_TOLERANCE_SECONDS` away from now is a replay and fails.
 */
export function verifyStripeSignature(
  value: string,
  rawBody: Buffer,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  let timestamp: string | null = null;
  const candidates: string[] = [];
  for (const part of value.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === "t") timestamp = val;
    else if (key === "v1") candidates.push(val.toLowerCase());
  }
  if (timestamp === null || !/^\d{1,12}$/.test(timestamp) || candidates.length === 0) return false;
  const skew = Math.abs(nowMs / 1000 - Number(timestamp));
  if (skew > STRIPE_TOLERANCE_SECONDS) return false;
  const expected = hmacHex(
    secret,
    Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]),
  );
  // Every candidate is compared, so timing does not tell which one matched.
  let ok = false;
  for (const candidate of candidates) {
    if (secretEquals(candidate, expected)) ok = true;
  }
  return ok;
}
