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

  describe("signature presets (ATO-445)", () => {
    const body = '{"action":"opened","issue":{"title":"Bug"}}';
    const hex = (key: string | Buffer, data: string) =>
      createHmac("sha256", key).update(data).digest("hex");
    const post = (name: string, headers: Record<string, string>, raw = body) =>
      fetch(`${harness.baseUrl}/api/webhooks/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: raw,
      });

    it("github: accepts the HMAC of the raw bytes and runs the template", async () => {
      harness = await startTestHarness({
        webhooks: {
          gh: { userMessageTemplate: "issue {{body.issue.title}}", secret: "gh-s", verify: "github" },
        },
      });
      const res = await post("gh", { "x-hub-signature-256": `sha256=${hex("gh-s", body)}` });
      expect(res.status).toBe(202);
      const payload = (await res.json()) as WebhookResponse;
      expect(harness.runtime.taskStore.get(payload.taskId)?.userMessage).toBe("issue Bug");
    });

    it("github: rejects a wrong, missing or plain-secret header before any task", async () => {
      harness = await startTestHarness({
        webhooks: {
          gh: { userMessageTemplate: "x", secret: "gh-s", verify: "github" },
        },
      });
      for (const headers of [
        { "x-hub-signature-256": `sha256=${hex("other", body)}` },
        {},
        // The header preset's secret does not open a github route.
        { "x-webhook-secret": "gh-s" },
      ]) {
        const res = await post("gh", headers);
        expect(res.status).toBe(401);
        const text = await res.text();
        expect(text).not.toContain("gh-s");
      }
      expect(harness.runtime.taskStore.list().length).toBe(0);
    });

    it("stripe: accepts a fresh timestamp and rejects an expired one", async () => {
      harness = await startTestHarness({
        webhooks: {
          pay: { userMessageTemplate: "paid", secret: "whsec_from_stripe", verify: "stripe" },
        },
      });
      const now = Math.floor(Date.now() / 1000);
      const fresh = await post("pay", {
        "stripe-signature": `t=${now},v1=${hex("whsec_from_stripe", `${now}.${body}`)}`,
      });
      expect(fresh.status).toBe(202);
      const old = now - 3600;
      const expired = await post("pay", {
        "stripe-signature": `t=${old},v1=${hex("whsec_from_stripe", `${old}.${body}`)}`,
      });
      expect(expired.status).toBe(401);
      expect(harness.runtime.taskStore.list().length).toBe(1);
    });

    it("standard: accepts webhook-signature v1 and rejects a tampered body", async () => {
      const key = Buffer.from("standard-webhooks-test-key-0001", "utf8");
      harness = await startTestHarness({
        webhooks: {
          std: {
            userMessageTemplate: "std {{body.action}}",
            secret: `whsec_${key.toString("base64")}`,
            verify: "standard",
          },
        },
      });
      const now = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", key).update(`msg_1.${now}.${body}`).digest("base64");
      const headers = {
        "webhook-id": "msg_1",
        "webhook-timestamp": String(now),
        "webhook-signature": `v1,${sig}`,
      };
      expect((await post("std", headers)).status).toBe(202);
      expect((await post("std", headers, body.replace("opened", "closed"))).status).toBe(401);
      expect(harness.runtime.taskStore.list().length).toBe(1);
    });
  });
});
