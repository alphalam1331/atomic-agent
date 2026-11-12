import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TASK_PAUSED_ERROR,
  cancelPausedTask,
  isPausedTask,
  pauseRecurringTask,
  resumeRecurringTask,
} from "./task-pause.js";
import { resolveScheduledFor } from "./task-schedule.js";
import { TaskStore } from "./task-store.js";
import type { TaskSchedule } from "./task-types.js";

const T0 = Date.UTC(2026, 10, 12, 8, 30);
const DAILY_NINE: TaskSchedule = { kind: "cron", expression: "0 9 * * *", tz: "UTC" };

describe("task pause / resume", () => {
  let tmp: string;
  let store: TaskStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-task-pause-"));
    store = new TaskStore({ dbFile: join(tmp, "tasks.sqlite") });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function createCron(schedule: TaskSchedule = DAILY_NINE): string {
    return store.create(
      {
        sessionId: "s-1",
        userMessage: "morning digest",
        origin: "telegram",
        maxAttempts: 3,
        schedule,
        scheduledFor: resolveScheduledFor(schedule, T0),
      },
      T0,
    ).id;
  }

  it("pauses a pending cron so the scheduler no longer sees it as due", () => {
    const id = createCron();
    const result = pauseRecurringTask(store, id, T0 + 1);
    expect(result.ok).toBe(true);
    const row = store.get(id)!;
    expect(row.status).toBe("blocked");
    expect(row.lastError).toBe(TASK_PAUSED_ERROR);
    expect(isPausedTask(row)).toBe(true);
    expect(store.listDue(T0 + 365 * 24 * 3_600_000)).toHaveLength(0);
  });

  it("refuses to pause twice, a running task, or a one-shot task", () => {
    const id = createCron();
    pauseRecurringTask(store, id, T0);
    expect(pauseRecurringTask(store, id, T0)).toMatchObject({
      ok: false,
      reason: "already_paused",
    });

    const runningId = createCron();
    store.markRunning(runningId, T0);
    expect(pauseRecurringTask(store, runningId, T0)).toMatchObject({
      ok: false,
      reason: "running",
    });

    const oneShot = store.create(
      { userMessage: "once", origin: "cli", maxAttempts: 1 },
      T0,
    ).id;
    expect(pauseRecurringTask(store, oneShot, T0)).toMatchObject({
      ok: false,
      reason: "not_recurring",
    });
    expect(pauseRecurringTask(store, "t-missing", T0)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("resumes on the next firing after now, skipping firings missed while paused", () => {
    const id = createCron();
    pauseRecurringTask(store, id, T0);
    // Two days later, 10:00 UTC: today's 09:00 is gone, tomorrow's is next.
    const later = Date.UTC(2026, 10, 14, 10, 0);
    const result = resumeRecurringTask(store, id, later);
    expect(result.ok).toBe(true);
    const row = store.get(id)!;
    expect(row.status).toBe("pending");
    expect(row.lastError).toBeNull();
    expect(row.scheduledFor).toBe(Date.UTC(2026, 10, 15, 9, 0));
    expect(row.sessionId).toBe("s-1");
  });

  it("does not resume a task blocked for another reason", () => {
    const id = createCron();
    store.markBlocked(id, { category: "tool", message: "session missing" }, T0);
    expect(resumeRecurringTask(store, id, T0)).toMatchObject({
      ok: false,
      reason: "not_paused",
    });
    expect(store.get(id)!.status).toBe("blocked");
  });

  it("cancels a paused task (cancel alone would leave the blocked row as it is)", () => {
    const id = createCron();
    pauseRecurringTask(store, id, T0);
    const result = cancelPausedTask(store, id, T0 + 5);
    expect(result.ok).toBe(true);
    expect(store.get(id)!.status).toBe("cancelled");
  });

  it("cancelPausedTask refuses a task that is not paused", () => {
    const id = createCron();
    expect(cancelPausedTask(store, id, T0)).toMatchObject({
      ok: false,
      reason: "not_paused",
    });
    expect(store.get(id)!.status).toBe("pending");
  });
});
