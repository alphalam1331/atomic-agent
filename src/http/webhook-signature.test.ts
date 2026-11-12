import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  STRIPE_TOLERANCE_SECONDS,
  checkSecretHeader,
  verifyGithubSignature,
  verifyStripeSignature,
  verifyWebhookRequest,
} from "./webhook-signature.js";

const SECRET = "whsec_test_0123456789";
const BODY = Buffer.from(JSON.stringify({ action: "opened", n: 1 }));
const NOW = 1_800_000_000_000;

function hmac(data: string | Buffer): string {
  return createHmac("sha256", SECRET).update(data).digest("hex");
}

function stripeHeader(t: number, body: Buffer = BODY): string {
  return `t=${t},v1=${hmac(Buffer.concat([Buffer.from(`${t}.`), body]))}`;
}

describe("webhook signatures (ATO-625)", () => {
  it("accepts GitHub's x-hub-signature-256 and refuses a tampered body", () => {
    const sig = `sha256=${hmac(BODY)}`;
    expect(verifyGithubSignature(sig, BODY, SECRET)).toBe(true);
    expect(verifyGithubSignature(sig.toUpperCase().replace("SHA256=", "sha256="), BODY, SECRET)).toBe(true);
    expect(verifyGithubSignature(sig, Buffer.from("{}"), SECRET)).toBe(false);
    expect(verifyGithubSignature(`sha1=${hmac(BODY)}`, BODY, SECRET)).toBe(false);
    expect(verifyGithubSignature(sig, BODY, "other-secret")).toBe(false);
  });

  it("accepts Stripe's signature inside the tolerance and refuses a replay", () => {
    const t = Math.floor(NOW / 1000);
    expect(verifyStripeSignature(stripeHeader(t), BODY, SECRET, NOW)).toBe(true);
    const old = t - STRIPE_TOLERANCE_SECONDS - 1;
    expect(verifyStripeSignature(stripeHeader(old), BODY, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(stripeHeader(t), Buffer.from("{}"), SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(`t=${t}`, BODY, SECRET, NOW)).toBe(false);
    expect(verifyStripeSignature(`v1=${hmac(BODY)}`, BODY, SECRET, NOW)).toBe(false);
  });

  it("accepts any of several Stripe v1 signatures (secret roll)", () => {
    const t = Math.floor(NOW / 1000);
    const good = stripeHeader(t).split("v1=")[1];
    expect(verifyStripeSignature(`t=${t},v1=${"0".repeat(64)},v1=${good}`, BODY, SECRET, NOW)).toBe(true);
  });

  it("the first scheme present decides, and a wrong plain secret is not rescued", () => {
    const github = `sha256=${hmac(BODY)}`;
    expect(verifyWebhookRequest({ "x-webhook-secret": SECRET }, BODY, SECRET, NOW)).toBe("header");
    expect(verifyWebhookRequest({ "x-hub-signature-256": github }, BODY, SECRET, NOW)).toBe("github");
    expect(
      verifyWebhookRequest({ "stripe-signature": stripeHeader(Math.floor(NOW / 1000)) }, BODY, SECRET, NOW),
    ).toBe("stripe");
    expect(
      verifyWebhookRequest({ "x-webhook-secret": "wrong", "x-hub-signature-256": github }, BODY, SECRET, NOW),
    ).toBeNull();
    expect(verifyWebhookRequest({}, BODY, SECRET, NOW)).toBeNull();
    expect(verifyWebhookRequest({ "x-webhook-secret": "" }, BODY, "", NOW)).toBeNull();
  });

  it("checkSecretHeader says null when the header is absent", () => {
    expect(checkSecretHeader({}, SECRET)).toBeNull();
    expect(checkSecretHeader({ "x-webhook-secret": SECRET }, SECRET)).toBe(true);
    expect(checkSecretHeader({ "x-webhook-secret": "nope" }, SECRET)).toBe(false);
  });
});
