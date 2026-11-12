import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

interface WebhookResponse {
  taskId: string;
  sessionId: string | null;
}

describe("POST /api/webhooks/:name", () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness) await harness.cleanup();
  });

  it("materialises an ephemeral task when no sessionMode is set", async () => {
    harness = await startTestHarness({
      webhooks: {
        ping: {
          userMessageTemplate: "hello {{body.who}}",
        },
      },
    });

    const res = await fetch(`${harness.baseUrl}/api/webhooks/ping`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ who: "omnissiah" }),
    });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as WebhookResponse;
    expect(payload.taskId).toMatch(/^t-/);
    const task = harness.runtime.taskStore.get(payload.taskId);
    expect(task).not.toBeNull();
    expect(task?.userMessage).toBe("hello omnissiah");
    expect(task?.triggerSource).toBe("webhook");
    expect(task?.sessionId).toBeNull();
  });

  it("reuses the persistent session across hits", async () => {
    harness = await startTestHarness({
      webhooks: {
        daily: {
          userMessageTemplate: "tick {{body.n}}",
          sessionMode: "persistent",
        },
      },
    });

    const first = (await fetch(`${harness.baseUrl}/api/webhooks/daily`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 1 }),
    }).then((r) => r.json())) as WebhookResponse;

    const second = (await fetch(`${harness.baseUrl}/api/webhooks/daily`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 2 }),
    }).then((r) => r.json())) as WebhookResponse;

    expect(first.sessionId).not.toBeNull();
    expect(second.sessionId).toBe(first.sessionId);
    const file = join(harness.stateDir, "webhook-sessions.json");
    expect(existsSync(file)).toBe(true);
    const map = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      string
    >;
    expect(map.daily).toBe(first.sessionId);
  });

  it("rejects when sessionMode=named without a secret matches and fails when missing", async () => {
    harness = await startTestHarness({
      webhooks: {
        secure: {
          userMessageTemplate: "auth {{body.hi}}",
          secret: "sekret",
        },
      },
    });

    const bad = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hi: "x" }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-secret": "sekret",
      },
      body: JSON.stringify({ hi: "x" }),
    });
    expect(good.status).toBe(202);
  });

  it("rejects a wrong secret of the same or a different length", async () => {
    harness = await startTestHarness({
      webhooks: {
        secure: {
          userMessageTemplate: "auth {{body.hi}}",
          secret: "sekret",
        },
      },
    });

    for (const attempt of ["sekreT", "sek", "sekret-and-more", ""]) {
      const res = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-secret": attempt,
        },
        body: JSON.stringify({ hi: "x" }),
      });
      expect(res.status).toBe(401);
    }
    expect(harness.runtime.taskStore.list().length).toBe(0);
  });

  it("accepts a GitHub or Stripe signature made with the secret (ATO-625)", async () => {
    harness = await startTestHarness({
      webhooks: {
        secure: { userMessageTemplate: "signed {{body.hi}}", secret: "whsec_0123456789" },
      },
    });
    const body = JSON.stringify({ hi: "x" });
    const hmac = (data: string): string =>
      createHmac("sha256", "whsec_0123456789").update(data).digest("hex");

    const github = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${hmac(body)}` },
      body,
    });
    expect(github.status).toBe(202);

    const t = Math.floor(Date.now() / 1000);
    const stripe = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${hmac(`${t}.${body}`)}` },
      body,
    });
    expect(stripe.status).toBe(202);

    const tampered = await fetch(`${harness.baseUrl}/api/webhooks/secure`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${hmac(body)}` },
      body: JSON.stringify({ hi: "y" }),
    });
    expect(tampered.status).toBe(401);
    expect(harness.runtime.taskStore.list().length).toBe(2);
  });

  it("GET /api/webhooks lists bindings without their secrets (ATO-625)", async () => {
    harness = await startTestHarness({
      webhooks: {
        secure: { userMessageTemplate: "x", secret: "never-shown-0123" },
        open: { userMessageTemplate: "y", sessionMode: "persistent" },
      },
    });
    const res = await fetch(`${harness.baseUrl}/api/webhooks`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("never-shown-0123");
    const payload = JSON.parse(text) as {
      tunnel: { state: string };
      webhooks: Array<Record<string, unknown>>;
    };
    expect(payload.tunnel.state).toBe("off");
    expect(payload.webhooks).toEqual(
      expect.arrayContaining([
        { name: "secure", path: "/api/webhooks/secure", hasSecret: true, sessionMode: "ephemeral", publicUrl: null },
        { name: "open", path: "/api/webhooks/open", hasSecret: false, sessionMode: "persistent", publicUrl: null },
      ]),
    );
  });

  it("returns 404 for unknown webhook names", async () => {
    harness = await startTestHarness();
    const res = await fetch(`${harness.baseUrl}/api/webhooks/nope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("passes schedule through so the task is marked recurring", async () => {
    harness = await startTestHarness({
      webhooks: {
        cronhook: {
          userMessageTemplate: "cron hit {{body.tag}}",
          sessionMode: "persistent",
          schedule: {
            kind: "interval",
            everyMs: 60_000,
          },
        },
      },
    });
    const res = await fetch(`${harness.baseUrl}/api/webhooks/cronhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "a" }),
    });
    expect(res.status).toBe(202);
    const payload = (await res.json()) as WebhookResponse;
    const task = harness.runtime.taskStore.get(payload.taskId);
    expect(task?.recurring).toBe(true);
    expect(task?.schedule?.kind).toBe("interval");
    expect(task?.scheduledFor).not.toBeNull();
  });
});
