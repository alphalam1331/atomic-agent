import { resolveScheduledFor } from "./task-schedule.js";
import type { TaskStore } from "./task-store.js";
import type { TaskRecord } from "./task-types.js";

/**
 * Pause and resume for recurring tasks (ATO-21), built only from
 * transitions the store already has, so no schema change and no second
 * scheduling path:
 *
 *  - pause:  `pending -> blocked` (`markBlocked`) with the stable
 *    `TASK_PAUSED_ERROR` as its reason. The scheduler only claims
 *    `pending` rows, so a paused task never fires.
 *  - resume: `requeueRecurring` with the next firing from
 *    `resolveScheduledFor` (the same parser and math the create path
 *    uses), exactly as the runner rearms a firing that completed.
 *
 * A row blocked for any other reason (a missing session, a refused
 * approval level) is not "paused" and is never resumed here.
 *
 * Every function runs its read and its write in one synchronous block:
 * `better-sqlite3` is synchronous, so the runner in this process cannot
 * claim the row in between.
 */

/** `last_error` of a paused task. Stable: `isPausedTask` keys on it. */
export const TASK_PAUSED_ERROR = "paused by the owner";

/** Why a pause, resume or delete did nothing. */
export type TaskPauseRefusal =
  | "not_found"
  | "not_recurring"
  | "running"
  | "already_paused"
  | "not_paused"
  | "ended";

export type TaskPauseResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: TaskPauseRefusal; task: TaskRecord | null };

/** True for a recurring task that was paused with `pauseRecurringTask`. */
export function isPausedTask(task: TaskRecord): boolean {
  return (
    task.recurring &&
    task.status === "blocked" &&
    task.lastError === TASK_PAUSED_ERROR
  );
}

/**
 * Stop a recurring task from firing until it is resumed. Only a
 * `pending` row (waiting for its next firing) can be paused: a run in
 * progress is refused (`running`) so the runner never finds its row
 * moved under it.
 */
export function pauseRecurringTask(
  store: TaskStore,
  id: string,
  now: number = Date.now(),
): TaskPauseResult {
  const task = store.get(id);
  if (!task) return { ok: false, reason: "not_found", task: null };
  if (!task.recurring || !task.schedule) {
    return { ok: false, reason: "not_recurring", task };
  }
  if (isPausedTask(task)) return { ok: false, reason: "already_paused", task };
  if (task.status === "running") return { ok: false, reason: "running", task };
  if (task.status !== "pending") return { ok: false, reason: "ended", task };
  const paused = store.markBlocked(
    id,
    { category: "cancelled", message: TASK_PAUSED_ERROR },
    now,
  );
  return { ok: true, task: paused };
}

/**
 * Rearm a paused task for its next firing after `now`. A firing that
 * fell inside the pause is skipped, not caught up.
 */
export function resumeRecurringTask(
  store: TaskStore,
  id: string,
  now: number = Date.now(),
): TaskPauseResult {
  const task = store.get(id);
  if (!task) return { ok: false, reason: "not_found", task: null };
  if (!task.recurring || !task.schedule) {
    return { ok: false, reason: "not_recurring", task };
  }
  if (!isPausedTask(task)) return { ok: false, reason: "not_paused", task };
  const next = resolveScheduledFor(task.schedule, now);
  return { ok: true, task: store.requeueRecurring(id, next, now) };
}

/**
 * Cancel a paused task. `cancel` leaves a terminal row as it is, and a
 * paused row is `blocked`, so it is rearmed first and cancelled in the
 * same synchronous block: it never becomes due in between.
 */
export function cancelPausedTask(
  store: TaskStore,
  id: string,
  now: number = Date.now(),
): TaskPauseResult {
  const resumed = resumeRecurringTask(store, id, now);
  if (!resumed.ok) return resumed;
  const cancelled = store.cancel(id, now);
  if (!cancelled) return { ok: false, reason: "not_found", task: null };
  return { ok: true, task: cancelled };
}
