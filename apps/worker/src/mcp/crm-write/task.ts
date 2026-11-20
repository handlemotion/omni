import type { CrmTask } from "@omni/db";
import { z } from "zod";
import { announce, crmOf, type CrmWorkspace } from "../crm.ts";
import { recordRef, recordRefSchema, taskRows } from "../crm-tasks.ts";
import type { ToolContext } from "../server.ts";
import { ownerId, refusal, type Written } from "./shared.ts";

export const taskSchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this task. Leave out to add one."),
    title: z.string().min(1).max(500).optional(),
    body: z
      .string()
      .max(20_000)
      .nullable()
      .optional()
      .describe("Its description, as the app labels it."),
    assignee: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('"me", a teammate\'s email, or null for unassigned. Adding: you by default.'),
    due_at: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe("When it is due, an ISO date-time; null for none."),
    done: z.boolean().optional().describe("Changing: true completes it, false opens it again."),
    subtasks: z
      .array(
        z.object({
          id: z.string().min(1).max(100).optional().describe("Keep it on a step you keep."),
          title: z.string().min(1).max(500),
          done: z.boolean().default(false),
        }),
      )
      .max(100)
      .optional()
      .describe(
        "Its whole checklist, in order: it replaces the one it has, so send the steps you keep (with their `id`) and the new ones (without). [] clears it.",
      ),
    record: recordRefSchema.nullable().optional().describe("The record it is on; null for none."),
  })
  .describe("Add, change or complete a task. Adding needs `title`.");

type TaskInput = z.infer<typeof taskSchema>;

const dueOf = (due: string | null | undefined) =>
  due === undefined ? undefined : due === null ? null : new Date(due);

const stepsOf = (steps: TaskInput["subtasks"]) =>
  steps?.map((step) => ({
    id: step.id ?? crypto.randomUUID(),
    title: step.title,
    done: step.done,
  }));

const recordOf = (record: TaskInput["record"]) =>
  record === undefined ? undefined : record === null ? null : recordRef(record);

async function announceTask(context: ToolContext, workspace: CrmWorkspace, tasks: CrmTask[]) {
  for (const [kind, key] of [
    ["company", "companyId"],
    ["person", "personId"],
    ["deal", "dealId"],
  ] as const) {
    await announce(
      context,
      workspace,
      kind,
      tasks.map((t) => t[key]),
    );
  }
}

export const writeTask: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: TaskInput,
) => Promise<Written> = async (context, workspace, input) => {
  const crm = crmOf(context, workspace);
  const assignee = await ownerId(context, workspace, input.assignee);
  if ("error" in assignee) return assignee;
  const fields = {
    body: input.body,
    assigneeMemberId: assignee.id,
    dueAt: dueOf(input.due_at),
    record: recordOf(input.record),
  };
  let task: CrmTask;
  let before: CrmTask[] = [];
  if (input.id === undefined) {
    if (input.title === undefined) return { error: "Adding a task needs `title`." };
    if (input.done !== undefined) return { error: "`done` changes a task: give its `id`." };
    const made = await crm.createTask({ title: input.title, ...fields });
    if (made.status !== "ok") return refusal(made);
    task = made.task;
    if (input.subtasks?.length) {
      const stepped = await crm.updateTask(task.id, { subtasks: stepsOf(input.subtasks) });
      if (stepped.status !== "ok") return refusal(stepped);
      task = stepped.task;
    }
  } else {
    const found = await crm.task(input.id);
    if (found.status === "ok") before = [found.task];
    const changed = await crm.updateTask(input.id, {
      title: input.title,
      done: input.done,
      subtasks: stepsOf(input.subtasks),
      ...fields,
    });
    if (changed.status !== "ok") return refusal(changed);
    task = changed.task;
  }
  await announceTask(context, workspace, [task, ...before]);
  const [row] = await taskRows(context, workspace, [task]);
  return {
    output: { result: input.id ? "changed" : "added", task: row },
    kind: "task",
    ids: [task.id],
  } satisfies Written;
};
