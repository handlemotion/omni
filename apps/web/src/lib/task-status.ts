import type { CrmTask } from "@omni/client";

export type TaskStatus = NonNullable<CrmTask["status"]>;
export type TaskPriority = NonNullable<CrmTask["priority"]>;

export const isClosed = (status: TaskStatus) => status === "done" || status === "cancelled";

/** A task's status as shown: an older Worker sends none, and then `completedAt` says it. */
export const statusOf = (task: Pick<CrmTask, "status" | "completedAt">) =>
  task.status ?? ((task.completedAt ? "done" : "todo") satisfies TaskStatus);

/**
 * The status and completion a change gives a task, as the Worker works them out: `status` wins
 * over `done`, and closing a closed task (or reopening an open one) keeps when it was closed.
 */
export function closureAfter(
  task: Pick<CrmTask, "status" | "completedAt" | "completedByMemberId">,
  change: { done?: boolean; status?: TaskStatus },
  self: string | null,
) {
  const current = statusOf(task);
  let status = change.status ?? current;
  if (!change.status && change.done !== undefined && change.done !== isClosed(current)) {
    status = change.done ? "done" : "todo";
  }
  if (status === current) return {};
  if (isClosed(status) === !!task.completedAt) return { status };
  return isClosed(status)
    ? { status, completedAt: new Date().toISOString(), completedByMemberId: self }
    : { status, completedAt: null, completedByMemberId: null };
}
