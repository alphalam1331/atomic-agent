import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

describe("task management routes", () => {
  let harness: Harness;
  const token = "task-management-test-token";
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  beforeEach(async () => {
    harness = await startTestHarness({ apiKey: token });
  });

  afterEach(async () => { await harness.cleanup(); });

  const request = (method: string, path: string, body?: unknown) =>
    fetch(`${harness.baseUrl}/api/tasks/${path}`, {
      method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = () => {
    const session = harness.runtime.createSession();
    return harness.runtime.taskRunner.create({
      sessionId: session.id, userMessage: "check status", origin: "http", maxAttempts: 3,
      schedule: { kind: "at", at: Date.now() + 3_600_000 },
    });
  };

  it("requires authentication for every new write route", async () => {
    const task = create();
    for (const [method, path] of [["PATCH", task.id], ["POST", `${task.id}/stop`], ["DELETE", `${task.id}/record`]]) {
      const res = await fetch(`${harness.baseUrl}/api/tasks/${path}`, { method });
      expect(res.status).toBe(401);
    }
    expect(harness.runtime.taskStore.get(task.id)?.status).toBe("pending");
  });

  it("edits message, recurring schedule and notifications while keeping the session and id", async () => {
    const task = create();
    const schedule = { kind: "cron", expression: "0 9 * * *", tz: "Asia/Hong_Kong" };
    const res = await request("PATCH", task.id, { userMessage: "check again", schedule, notify: "telegram" });
    expect(res.status).toBe(200);
    const updated = await res.json() as { scheduledFor: number };
    expect(updated).toMatchObject({ id: task.id, sessionId: task.sessionId, userMessage: "check again", schedule, notify: "telegram", recurring: true });
    expect(updated.scheduledFor).toBeGreaterThan(Date.now());
    expect(harness.runtime.taskStore.list({ sessionId: task.sessionId!, limit: 20 })).toHaveLength(1);

    const clear = await request("PATCH", task.id, { notify: null });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ notify: null, schedule });
  });

  it.each([null, [], {}, { status: "pending" }, { userMessage: "" }, { notify: "email" }, { schedule: { kind: "interval", everyMs: 1 } }, { schedule: { kind: "cron", expression: "bad cron" } }])(
    "rejects invalid patch %j without changing the task", async (patch) => {
      const task = create();
      const res = await request("PATCH", task.id, patch);
      expect(res.status).toBe(400);
      expect(harness.runtime.taskStore.get(task.id)).toEqual(task);
    },
  );

  it("rejects malformed JSON as an invalid request", async () => {
    const task = create();
    const res = await fetch(`${harness.baseUrl}/api/tasks/${task.id}`, { method: "PATCH", headers, body: "{" });
    expect(res.status).toBe(400);
    expect(harness.runtime.taskStore.get(task.id)).toEqual(task);
  });

  it("keeps state conflicts distinct from missing tasks", async () => {
    const pending = create();
    const running = create();
    harness.runtime.taskStore.markRunning(running.id);
    const cancelled = create();
    harness.runtime.taskRunner.cancel(cancelled.id);
    expect((await request("PATCH", running.id, { userMessage: "new" })).status).toBe(409);
    expect((await request("PATCH", cancelled.id, { userMessage: "new" })).status).toBe(409);
    expect((await request("POST", `${pending.id}/stop`)).status).toBe(409);
    // The row is running, but this process owns no turn to stop.
    expect((await request("POST", `${running.id}/stop`)).status).toBe(409);
    expect((await request("DELETE", `${pending.id}/record`)).status).toBe(409);
    for (const [method, path, body] of [["PATCH", "missing", { userMessage: "new" }], ["POST", "missing/stop", undefined], ["DELETE", "missing/record", undefined]] as const) {
      expect((await request(method, path, body)).status).toBe(404);
    }
  });

  it("removes cancelled records, retaining their session and the cancellation endpoint", async () => {
    const task = create();
    expect((await request("DELETE", task.id)).status).toBe(200);
    const res = await request("DELETE", `${task.id}/record`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true, id: task.id });
    expect(harness.runtime.taskStore.get(task.id)).toBeNull();
    expect(harness.runtime.sessionStore.load(task.sessionId!)).not.toBeNull();
    expect((await request("DELETE", `${task.id}/record`)).status).toBe(404);
  });
});

describe("stopping a live task over HTTP", () => {
  let harness: Harness | null = null;
  afterEach(async () => { await harness?.cleanup(); });

  it("aborts the owned turn and keeps a recurring task's next firing", async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => { started = resolve; });
    harness = await startTestHarness({
      llamaComplete: ({ signal }) => new Promise((_resolve, reject) => {
        started();
        const aborted = () => reject(new Error("task stopped"));
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      }),
    });
    const session = harness.runtime.createSession();
    const task = harness.runtime.taskRunner.create({
      sessionId: session.id, userMessage: "keep checking", origin: "http", maxAttempts: 3,
      schedule: { kind: "interval", everyMs: 3_600_000 },
    });
    const run = harness.runtime.taskRunner.runOne(task.id);
    await active;
    const res = await fetch(`${harness.baseUrl}/api/tasks/${task.id}/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    const result = await res.json() as { task: { scheduledFor: number } };
    expect(result).toMatchObject({ stopping: false, task: { id: task.id, status: "pending", recurring: true } });
    expect(result.task.scheduledFor).toBeGreaterThan(Date.now());
    await run;
    expect(harness.runtime.taskStore.get(task.id)?.status).toBe("pending");
  });
});
