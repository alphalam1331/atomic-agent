import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type * as NodeCrypto from "node:crypto";

import {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  type WebhookVerifyInput,
} from "./webhook-signature.js";
import { standardWebhookKey } from "../config/webhook-config.js";

const BODY = Buffer.from('{"action":"opened","n":1}', "utf8");
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function headers(map: Record<string, string>): WebhookVerifyInput["header"] {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower[name] ?? null;
}

function hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

function b64(key: string | Buffer, data: string | Buffer): string {
  return createHmac("sha256", key).update(data).digest("base64");
}

describe("verify=header", () => {
  const base = { verify: "header" as const, secret: "sekret", rawBody: BODY };
  it("accepts the exact secret", () => {
    expect(verifyWebhookSignature({ ...base, header: headers({ "x-webhook-secret": "sekret" }) })).toEqual({ ok: true });
  });
  it("rejects a missing, wrong or different-length secret", () => {
    for (const h of [{}, { "x-webhook-secret": "sekreT" }, { "x-webhook-secret": "sek" }]) {
      expect(verifyWebhookSignature({ ...base, header: headers(h) }).ok).toBe(false);
    }
  });
});

describe("verify=github", () => {
  const secret = "gh-secret";
  const base = { verify: "github" as const, secret, rawBody: BODY };
  it("accepts sha256=<hex> of the raw body", () => {
    const sig = `sha256=${hex(secret, BODY)}`;
    expect(verifyWebhookSignature({ ...base, header: headers({ "X-Hub-Signature-256": sig }) })).toEqual({ ok: true });
  });
  it("accepts upper-case hex", () => {
    const sig = `sha256=${hex(secret, BODY).toUpperCase()}`;
    expect(verifyWebhookSignature({ ...base, header: headers({ "X-Hub-Signature-256": sig }) }).ok).toBe(true);
  });
  it("rejects a signature over a re-serialised body", () => {
    const reencoded = JSON.stringify(JSON.parse(BODY.toString("utf8")), null, 2);
    const sig = `sha256=${hex(secret, reencoded)}`;
    expect(verifyWebhookSignature({ ...base, header: headers({ "X-Hub-Signature-256": sig }) })).toEqual({
      ok: false,
      reason: "signature does not match",
    });
  });
  it("rejects a wrong key, a malformed header and a missing header", () => {
    expect(verifyWebhookSignature({ ...base, header: headers({ "X-Hub-Signature-256": `sha256=${hex("other", BODY)}` }) }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: headers({ "X-Hub-Signature-256": hex(secret, BODY) }) }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: headers({ "X-Hub-Signature-256": "sha256=abc" }) }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: headers({}) })).toEqual({
      ok: false,
      reason: "missing X-Hub-Signature-256 header",
    });
  });
});

describe("verify=stripe", () => {
  const secret = "whsec_stripe_made_this";
  const base = { verify: "stripe" as const, secret, rawBody: BODY, nowMs: NOW_MS };
  const sign = (t: number, key = secret) => hex(key, `${t}.${BODY.toString("utf8")}`);

  it("accepts t=..,v1=.. within the window", () => {
    const h = `t=${NOW_S},v1=${sign(NOW_S)}`;
    expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": h }) })).toEqual({ ok: true });
  });
  it("accepts when any of several v1 values matches (secret rotation)", () => {
    const h = `t=${NOW_S},v1=${sign(NOW_S, "old")},v1=${sign(NOW_S)},v0=deadbeef`;
    expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": h }) }).ok).toBe(true);
  });
  it("rejects an expired or future timestamp even with a correct signature", () => {
    const old = NOW_S - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 1;
    const future = NOW_S + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1;
    for (const t of [old, future]) {
      expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": `t=${t},v1=${sign(t)}` }) })).toEqual({
        ok: false,
        reason: "timestamp outside the tolerance window",
      });
    }
  });
  it("accepts the edge of the window", () => {
    const t = NOW_S - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
    expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": `t=${t},v1=${sign(t)}` }) }).ok).toBe(true);
  });
  it("rejects a signature moved to another timestamp", () => {
    const h = `t=${NOW_S + 1},v1=${sign(NOW_S)}`;
    expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": h }) }).ok).toBe(false);
  });
  it("rejects missing header, missing t, missing v1, wrong secret", () => {
    expect(verifyWebhookSignature({ ...base, header: headers({}) }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": `v1=${sign(NOW_S)}` }) }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": `t=${NOW_S}` }) }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, header: headers({ "Stripe-Signature": `t=${NOW_S},v1=${sign(NOW_S, "nope")}` }) }).ok).toBe(false);
  });
});

describe("verify=standard", () => {
  const keyBytes = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
  const secret = `whsec_${keyBytes.toString("base64")}`;
  const base = { verify: "standard" as const, secret, rawBody: BODY, nowMs: NOW_MS };
  const sign = (id: string, t: number, key: Buffer = keyBytes) => b64(key, `${id}.${t}.${BODY.toString("utf8")}`);

  it("decodes the whsec_ key", () => {
    expect(standardWebhookKey(secret)?.equals(keyBytes)).toBe(true);
    expect(standardWebhookKey("whsec_")).toBeNull();
    expect(standardWebhookKey("whsec_not base64!")).toBeNull();
  });
  it("accepts v1,<base64> of id.timestamp.body", () => {
    const h = headers({ "webhook-id": "msg_1", "webhook-timestamp": String(NOW_S), "webhook-signature": `v1,${sign("msg_1", NOW_S)}` });
    expect(verifyWebhookSignature({ ...base, header: h })).toEqual({ ok: true });
  });
  it("accepts one matching entry among several, and the svix-* header names", () => {
    const h = headers({
      "svix-id": "msg_2",
      "svix-timestamp": String(NOW_S),
      "svix-signature": `v1,${sign("msg_2", NOW_S, Buffer.from("other key"))} v1a,xyz v1,${sign("msg_2", NOW_S)}`,
    });
    expect(verifyWebhookSignature({ ...base, header: h }).ok).toBe(true);
  });
  it("rejects an expired timestamp", () => {
    const t = NOW_S - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 10;
    const h = headers({ "webhook-id": "msg_1", "webhook-timestamp": String(t), "webhook-signature": `v1,${sign("msg_1", t)}` });
    expect(verifyWebhookSignature({ ...base, header: h })).toEqual({ ok: false, reason: "timestamp outside the tolerance window" });
  });
  it("rejects a signature for another message id", () => {
    const h = headers({ "webhook-id": "msg_other", "webhook-timestamp": String(NOW_S), "webhook-signature": `v1,${sign("msg_1", NOW_S)}` });
    expect(verifyWebhookSignature({ ...base, header: h }).ok).toBe(false);
  });
  it("rejects any missing header", () => {
    const full = { "webhook-id": "msg_1", "webhook-timestamp": String(NOW_S), "webhook-signature": `v1,${sign("msg_1", NOW_S)}` };
    for (const drop of Object.keys(full)) {
      const partial = { ...full } as Record<string, string>;
      delete partial[drop];
      expect(verifyWebhookSignature({ ...base, header: headers(partial) }).ok).toBe(false);
    }
  });
});

describe("failure reasons", () => {
  it("never contain the secret or the expected signature", () => {
    const secret = "very-private-secret-value";
    const expected = hex(secret, BODY);
    const r = verifyWebhookSignature({
      verify: "github",
      secret,
      rawBody: BODY,
      header: headers({ "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` }),
    });
    expect(r.ok).toBe(false);
    const reason = r.ok ? "" : r.reason;
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain(expected);
  });
});

describe("constant-time path", () => {
  it("compares signatures through crypto.timingSafeEqual", async () => {
    vi.resetModules();
    const calls: number[] = [];
    vi.doMock("node:crypto", async () => {
      const actual = await vi.importActual<typeof NodeCrypto>("node:crypto");
      return {
        ...actual,
        timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
          calls.push(a.byteLength);
          return actual.timingSafeEqual(a, b);
        },
      };
    });
    const mod = await import("./webhook-signature.js");
    const secret = "gh-secret";
    const sig = `sha256=${hex(secret, BODY)}`;
    expect(mod.verifyWebhookSignature({ verify: "github", secret, rawBody: BODY, header: headers({ "X-Hub-Signature-256": sig }) }).ok).toBe(true);
    expect(calls).toEqual([32]);
    vi.doUnmock("node:crypto");
    vi.resetModules();
  });
});
