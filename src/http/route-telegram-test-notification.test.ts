import { afterEach, describe, expect, it, vi } from "vitest";

import type { TestNotificationDelivery } from "../channels/telegram/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("POST /api/telegram/test-notification", () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness?.cleanup();
    harness = null;
  });

  function request(token?: string, body?: unknown) {
    return fetch(`${harness!.baseUrl}/api/telegram/test-notification`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("requires bearer auth before attempting delivery", async () => {
    harness = await startTestHarness({ apiKey: "test-notification-secret" });
    const send = vi.spyOn(harness.runtime.telegramChannel!, "sendTestNotification").mockResolvedValue("sent");
    expect((await request()).status).toBe(401);
    expect((await request("wrong-token")).status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    const res = await request("test-notification-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "sent" });
    expect(send.mock.calls).toEqual([[]]);
  });

  it("does not pass a client message or recipient into the channel", async () => {
    harness = await startTestHarness();
    const send = vi.spyOn(harness.runtime.telegramChannel!, "sendTestNotification").mockResolvedValue("sent");
    const res = await request(undefined, { chatId: 1234, message: "client text" });
    expect(res.status).toBe(200);
    expect(send.mock.calls).toEqual([[]]);
  });

  it.each([
    ["channel_not_up", 409, "telegram_not_running"],
    ["not_paired", 409, "telegram_not_paired"],
    ["delivery_failed", 502, "telegram_delivery_failed"],
  ] as const)("reports %s without claiming delivery", async (delivery: TestNotificationDelivery, status, code) => {
    harness = await startTestHarness();
    vi.spyOn(harness.runtime.telegramChannel!, "sendTestNotification").mockResolvedValue(delivery);
    const res = await request();
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: { code } });
  });

  it("reports an unavailable channel", async () => {
    harness = await startTestHarness();
    (harness.runtime as { telegramChannel: unknown }).telegramChannel = null;
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "telegram_unavailable" } });
  });

  it("never returns a transport exception containing credentials", async () => {
    harness = await startTestHarness();
    vi.spyOn(harness.runtime.telegramChannel!, "sendTestNotification").mockRejectedValue(
      new Error("failed https://api.telegram.org/bot123:secret/sendMessage"),
    );
    const res = await request();
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("telegram_delivery_failed");
    expect(body).not.toContain("123:secret");
  });
});
