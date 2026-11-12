import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateWebhookSecret } from "./route-webhooks-admin.js";
import { startTestHarness, type Harness } from "./test-harness.js";
import { standardWebhookKey } from "../config/webhook-config.js";

/** ATO-445: the desktop's Webhooks screen lists, adds and removes routes over these. */
describe("/api/webhooks admin routes", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  const configOnDisk = () =>
    JSON.parse(readFileSync(join(harness.stateDir, "config.json"), "utf8")) as {
      webhooks?: Record<string, Record<string, unknown>>;
    };

  const create = (body: unknown) =>
    fetch(`${harness.baseUrl}/api/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists saved routes without their secrets", async () => {
    harness = await startTestHarness({
      webhooks: {
        gh: { userMessageTemplate: "t", secret: "top-secret", verify: "github" },
        plain: { userMessageTemplate: "p" },
      },
    });
    const res = await fetch(`${harness.baseUrl}/api/webhooks`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("top-secret");
    const payload = JSON.parse(text) as { webhooks: Array<Record<string, unknown>>; presets: string[] };
    expect(payload.presets).toEqual(["header", "github", "stripe", "standard"]);
    expect(payload.webhooks).toEqual([
      {
        name: "gh",
        path: "/api/webhooks/gh",
        verify: "github",
        sessionMode: "ephemeral",
        userMessageTemplate: "t",
        hasSecret: true,
        live: true,
      },
      {
        name: "plain",
        path: "/api/webhooks/plain",
        verify: "header",
        sessionMode: "ephemeral",
        userMessageTemplate: "p",
        hasSecret: false,
        live: true,
      },
    ]);
  });

  it("creates a github route, returns the secret once, and it answers without a restart", async () => {
    harness = await startTestHarness();
    const res = await create({ name: "gh", verify: "github", userMessageTemplate: "event {{body.action}}" });
    expect(res.status).toBe(201);
    const { webhook, secret } = (await res.json()) as { webhook: Record<string, unknown>; secret: string };
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(webhook).toMatchObject({ name: "gh", verify: "github", hasSecret: true, live: true });
    expect(configOnDisk().webhooks?.gh).toMatchObject({ verify: "github", secret });

    const list = await (await fetch(`${harness.baseUrl}/api/webhooks`)).text();
    expect(list).not.toContain(secret);

    const body = '{"action":"opened"}';
    const hit = await fetch(`${harness.baseUrl}/api/webhooks/gh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
      body,
    });
    expect(hit.status).toBe(202);
  });

  it("needs the pasted signing secret for stripe", async () => {
    harness = await startTestHarness();
    const missing = await create({ name: "pay", verify: "stripe", userMessageTemplate: "paid" });
    expect(missing.status).toBe(400);
    const pasted = await create({ name: "pay", verify: "stripe", userMessageTemplate: "paid", secret: "whsec_abc" });
    expect(pasted.status).toBe(201);
    expect(configOnDisk().webhooks?.pay).toMatchObject({ verify: "stripe", secret: "whsec_abc" });
  });

  it("generates a whsec_ key for standard", async () => {
    harness = await startTestHarness();
    const res = await create({ name: "std", verify: "standard", userMessageTemplate: "s" });
    expect(res.status).toBe(201);
    const { secret } = (await res.json()) as { secret: string };
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(standardWebhookKey(secret)?.length).toBe(24);
  });

  it("refuses a duplicate, a bad name, an unknown preset and an empty template", async () => {
    harness = await startTestHarness({ webhooks: { taken: { userMessageTemplate: "t" } } });
    expect((await create({ name: "taken", userMessageTemplate: "x" })).status).toBe(409);
    expect((await create({ name: "has space", userMessageTemplate: "x" })).status).toBe(400);
    expect((await create({ name: "__proto__", userMessageTemplate: "x" })).status).toBe(400);
    expect((await create({ name: "ok", verify: "gitlab", userMessageTemplate: "x" })).status).toBe(400);
    expect((await create({ name: "ok", userMessageTemplate: "" })).status).toBe(400);
    expect(Object.keys(configOnDisk().webhooks ?? {})).toEqual(["taken"]);
  });

  it("deletes a route from the file and the running agent", async () => {
    harness = await startTestHarness({
      webhooks: { gone: { userMessageTemplate: "t" }, kept: { userMessageTemplate: "k" } },
    });
    const res = await fetch(`${harness.baseUrl}/api/webhooks/gone`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(Object.keys(configOnDisk().webhooks ?? {})).toEqual(["kept"]);
    const hit = await fetch(`${harness.baseUrl}/api/webhooks/gone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(hit.status).toBe(404);
    expect((await fetch(`${harness.baseUrl}/api/webhooks/gone`, { method: "DELETE" })).status).toBe(404);
  });

  it("generateWebhookSecret gives a fresh value each time", () => {
    expect(generateWebhookSecret("header")).not.toBe(generateWebhookSecret("header"));
  });
});
