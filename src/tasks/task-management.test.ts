import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmptySessionState } from "../session/index.js";
import type { SessionState } from "../session/index.js";
import type { RunTurnResult } from "../agent/agent-contract.js";
import { TransportError } from "../llm/index.js";
import { TaskRunner, type TaskRunnerOptions, type TaskRunnerRuntime } from "./task-runner.js";
import { TASK_OWNER_GONE_ERROR, TASK_STOP_REQUESTED_ERROR, TaskStore } from "./task-store.js";
import { TaskOperationError, TaskValidationError } from "./task-types.js";

describe("task management", () => {
  let dir: string;
  let store: TaskStore;
  let session: SessionState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-management-"));
    store = new TaskStore({ dbFile: join(dir, "tasks.sqlite") });
    session = createEmptySessionState({ id: "s-manage", workingDir: dir });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function runner(runtime?: TaskRunnerRuntime, extra: Pick<TaskRunnerOptions, "sleep"> = {}) {
    return new TaskRunner({
      store,
      runtime: runtime ?? { runTurn: async (s) => ({ session: s, reason: "reply", stepCount: 1 }) },
      sessionLoader: { load: () => session },
      defaultMaxSteps: 5,
      backoff: { initialMs: 1, maxMs: 2 },
      minIntervalMs: 60_000,
      enabled: true,
      runOnCreate: false,
      ...extra,
    });
  }

  function create(recurring = false, now = 100) {
    return store.create({
      sessionId: session.id,
      userMessage: "original request",
      origin: "http",
      maxAttempts: 3,
      maxCostUsd: 10,
      maxDurationMs: 600_000,
      ...(recurring ? {
        schedule: { kind: "interval" as const, everyMs: 300_000 },
        scheduledFor: 100,
      } : {}),
    }, now);
  }

  function waiting(ignoreSignal = false) {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const runtime: TaskRunnerRuntime = {
      runTurn: (s, _message, options) => {
        signal = options?.signal;
        return new Promise<RunTurnResult>((resolve, reject) => {
          release = () => resolve({ session: s, reason: "reply", stepCount: 1, spendUsd: 0.25 });
          if (!ignoreSignal) signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    };
    return { runtime, release: () => release(), signal: () => signal };
  }

  it("edits pending intent together and resolves a changed schedule", () => {
    const task = create();
    const updated = runner().update(task.id, {
      userMessage: "revised request",
      schedule: { kind: "cron", expression: "0 9 * * *", tz: "Asia/Hong_Kong" },
      notify: "telegram",
    }, 1_000);
    expect(updated).toMatchObject({
      id: task.id, sessionId: session.id, status: "pending", userMessage: "revised request",
      recurring: true, notify: "telegram", updatedAt: 1_000, lastScheduledAt: 1_000,
    });
    expect(updated?.scheduledFor).toBeGreaterThan(1_000);
    expect(runner().update(task.id, { schedule: null, notify: null }, 2_000)).toMatchObject({
      status: "pending", recurring: false, schedule: null, scheduledFor: null, notify: null,
    });
  });

  it("preserves retry counters, used budgets, and next firing when the schedule is unchanged", () => {
    const task = create(true);
    store.markRunning(task.id, 200);
    store.recordSpend(task.id, 2);
    store.recordElapsed(task.id, 1_234);
    store.markRetry(task.id, { category: "transport", message: "retry" }, 300);
    const updated = runner().update(task.id, { userMessage: task.userMessage, schedule: task.schedule, notify: "telegram" }, 400);
    expect(updated).toMatchObject({ attempts: 1, spentUsd: 2, elapsedMs: 1_234, scheduledFor: 100, lastScheduledAt: 100, lastError: "retry" });
  });

  it("does not continue the old request's checkpoint after its message is edited", () => {
    const task = create();
    store.markRunning(task.id);
    store.recoverInterrupted({ staleAfterMs: 0, isOwnerGone: () => true });
    expect(store.get(task.id)?.lastError).toBe(TASK_OWNER_GONE_ERROR);
    expect(runner().update(task.id, { userMessage: "different task" })).toMatchObject({ lastError: null, lastErrorCategory: null });
  });

  it("rejects edits to running or terminal tasks without reactivating them", async () => {
    const task = create();
    store.markRunning(task.id);
    expect(() => runner().update(task.id, { userMessage: "changed" })).toThrow(TaskOperationError);
    store.cancel(task.id);
    expect(() => runner().update(task.id, { notify: "telegram" })).toThrow(TaskOperationError);
    expect(store.get(task.id)?.status).toBe("cancelled");
    expect(runner().update("missing", { userMessage: "changed" })).toBeNull();
  });

  it("rejects invalid edits atomically, including the configured interval floor", () => {
    const task = create();
    expect(() => runner().update(task.id, { userMessage: "changed", schedule: { kind: "interval", everyMs: 1_000 } })).toThrow(TaskValidationError);
    expect(() => store.update(task.id, { userMessage: "changed", notify: "bad" as "telegram" })).toThrow(TaskValidationError);
    expect(() => store.update(task.id, { schedule: { kind: "cron", expression: "invalid" } })).toThrow(TaskValidationError);
    expect(store.get(task.id)).toEqual(task);
  });

  it("keeps a pre-existing shorter interval when another field is edited", () => {
    const task = store.create({ sessionId: session.id, userMessage: "poll", origin: "cli", maxAttempts: 1, schedule: { kind: "interval", everyMs: 1_000 }, scheduledFor: 2_000 });
    expect(runner().update(task.id, { userMessage: "changed", schedule: task.schedule })?.scheduledFor).toBe(2_000);
  });

  it("checks due eligibility at the atomic claim while retaining explicit Run now", () => {
    const task = create(true);
    store.update(task.id, { schedule: { kind: "at", at: 5_000 } }, 1_000);
    expect(store.markRunning(task.id, 2_000, 2_000)).toBeNull();
    expect(store.get(task.id)?.attempts).toBe(0);
    expect(store.markRunning(task.id, 2_000)?.status).toBe("running");
  });

  it("honors a reschedule of pending work already captured in a due batch", async () => {
    let releaseFirst!: () => void;
    const calls: string[] = [];
    const tasks = runner({ runTurn: async (s, message) => {
      calls.push(message);
      if (calls.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return { session: s, reason: "reply", stepCount: 1 };
    } });
    const first = create();
    const second = create(false, 101);
    store.update(first.id, { userMessage: "first" });
    store.update(second.id, { userMessage: "second" });
    const due = tasks.runDue(Date.now(), 100);
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    tasks.update(second.id, { schedule: { kind: "at", at: Date.now() + 3_600_000 } });
    releaseFirst();
    expect(await due).toMatchObject({ drained: 1, completed: 1 });
    expect(calls).toEqual(["first"]);
    expect(store.get(second.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect((await tasks.runOne(second.id))?.status).toBe("completed");
    expect(calls).toEqual(["first", "second"]);
  });

  it("honors a reschedule while a retry is waiting in backoff", async () => {
    let releaseBackoff!: () => void;
    let waitingBackoff = false;
    const runTurn = vi.fn<TaskRunnerRuntime["runTurn"]>(async () => {
      throw new TransportError("unavailable", 503, "http://test.invalid");
    });
    const tasks = runner({ runTurn }, { sleep: () => {
      waitingBackoff = true;
      return new Promise<void>((resolve) => { releaseBackoff = resolve; });
    } });
    const task = create();
    const due = tasks.runDue(Date.now(), 100);
    await vi.waitFor(() => expect(waitingBackoff).toBe(true));
    tasks.update(task.id, { schedule: { kind: "at", at: Date.now() + 3_600_000 } });
    releaseBackoff();
    await due;
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(store.get(task.id)).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("stops a one-shot task durably and continues to accept other work", async () => {
    const turn = waiting();
    const tasks = runner(turn.runtime);
    const task = create();
    const running = tasks.runOne(task.id);
    await vi.waitFor(() => expect(turn.signal()).toBeDefined());
    expect(await tasks.stopTask(task.id)).toMatchObject({ task: { status: "cancelled" }, stopping: false });
    expect(turn.signal()?.aborted).toBe(true);
    expect((await running)?.status).toBe("cancelled");
    expect(await tasks.stopTask("missing")).toBeNull();
    await expect(tasks.stopTask(task.id)).rejects.toThrow(TaskOperationError);
    expect(tasks.update(create().id, { notify: "telegram" })?.status).toBe("pending");
  });

  it("stops only the current recurring firing and retains its session and schedule", async () => {
    const turn = waiting();
    const tasks = runner(turn.runtime);
    const task = create(true);
    const running = tasks.runOne(task.id);
    await vi.waitFor(() => expect(turn.signal()).toBeDefined());
    expect(await tasks.stopTask(task.id)).toMatchObject({ stopping: false, task: {
      status: "pending", sessionId: session.id, recurring: true, attempts: 0, spentUsd: null, elapsedMs: null,
    } });
    expect((await running)?.scheduledFor).toBeGreaterThan(Date.now());
  });

  it("does not claim to stop a running task owned by another runner", async () => {
    const turn = waiting();
    const owner = runner(turn.runtime);
    const task = create();
    const running = owner.runOne(task.id);
    await vi.waitFor(() => expect(turn.signal()).toBeDefined());
    await expect(runner().stopTask(task.id)).rejects.toThrow(/another agent process/);
    expect(turn.signal()?.aborted).toBe(false);
    await owner.stopTask(task.id);
    await running;
  });

  it("reports unwinding truthfully, blocks removal, and ignores a late success after stop", async () => {
    const turn = waiting(true);
    const tasks = runner(turn.runtime);
    const task = create();
    const running = tasks.runOne(task.id);
    await vi.waitFor(() => expect(turn.signal()).toBeDefined());
    expect(await tasks.stopTask(task.id, 1)).toMatchObject({ task: { status: "cancelled" }, stopping: true });
    expect(() => tasks.removeCancelled(task.id)).toThrow(/Wait for/);
    turn.release();
    expect((await running)?.status).toBe("cancelled");
    expect(tasks.removeCancelled(task.id)?.id).toBe(task.id);
    expect(store.get(task.id)).toBeNull();
    expect(tasks.removeCancelled(task.id)).toBeNull();
  });

  it("keeps an uncooperative recurring turn running until it settles, without reporting success", async () => {
    const turn = waiting(true);
    const tasks = runner(turn.runtime);
    const task = create(true);
    const running = tasks.runOne(task.id);
    await vi.waitFor(() => expect(turn.signal()).toBeDefined());
    expect(await tasks.stopTask(task.id, 1)).toMatchObject({ task: { status: "running" }, stopping: true });
    turn.release();
    expect(await running).toMatchObject({ status: "pending", attempts: 0, spentUsd: null });
  });

  it("recovers an operator-stopped recurring run at its future firing after a crash", () => {
    const task = create(true);
    const claimed = store.markRunning(task.id, 200)!;
    store.recordSpend(task.id, 2);
    store.recordElapsed(task.id, 50);
    expect(store.requestStop(task.id, claimed.startedAt, 1_000)).toMatchObject({ status: "running", scheduledFor: 301_000, lastError: TASK_STOP_REQUESTED_ERROR });
    store.recoverInterrupted({ staleAfterMs: 0, now: 2_000, isOwnerGone: () => true });
    expect(store.get(task.id)).toMatchObject({ status: "pending", scheduledFor: 301_000, attempts: 0, spentUsd: null, elapsedMs: null });
    expect(store.listDue(2_000)).toEqual([]);
  });

  it("removes only cancelled history and preserves its chat session", async () => {
    const task = create();
    const tasks = runner();
    expect(() => tasks.removeCancelled(task.id)).toThrow(TaskOperationError);
    await tasks.runOne(task.id);
    expect(() => tasks.removeCancelled(task.id)).toThrow(TaskOperationError);
    const cancelled = create();
    tasks.cancel(cancelled.id);
    expect(tasks.removeCancelled(cancelled.id)?.sessionId).toBe(session.id);
    expect(store.get(cancelled.id)).toBeNull();
  });
});
