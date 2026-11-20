import { z } from "zod";

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime();

export const CRM_TASK_TITLE_MAX = 500;
export const CRM_TASK_BODY_MAX = 20_000;

export const CRM_SUBTASKS_MAX = 100;

/** A step of a task's checklist, with an id the client makes. */
export const crmSubtaskSchema = z.object({
  id,
  title: z.string().max(CRM_TASK_TITLE_MAX),
  done: z.boolean(),
});

export const crmTaskSchema = z.object({
  id,
  title: z.string(),
  body: z.string().nullable(),
  /** Its checklist, in order. Absent from a Worker older than this field. */
  subtasks: z.array(crmSubtaskSchema).optional(),
  /** At most one of the three: the record it is on. */
  companyId: id.nullable(),
  personId: id.nullable(),
  dealId: id.nullable(),
  /** That record's name. */
  recordName: z.string().nullable(),
  /** A company's first domain, for its icon. Absent from a Worker older than this field. */
  recordDomain: z.string().nullable().optional(),
  assigneeMemberId: id.nullable(),
  /** A moment: a client picking a day sends the end of that day in its time zone. */
  dueAt: isoDate.nullable(),
  /** Set while it is done. */
  completedAt: isoDate.nullable(),
  completedByMemberId: id.nullable(),
  createdByMemberId: id.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const onRecord = {
  companyId: id.nullable().optional(),
  personId: id.nullable().optional(),
  dealId: id.nullable().optional(),
};
const oneRecordAtMost = (task: { companyId?: unknown; personId?: unknown; dealId?: unknown }) =>
  [task.companyId, task.personId, task.dealId].filter(Boolean).length <= 1;
const ONE_RECORD = { message: "give at most one of companyId, personId and dealId" };

/**
 * `GET /tasks`. Open tasks come soonest due first, undated last; `status=done` most recently
 * completed first. `assignee` is a member id, `me` or `none`; `due` applies to open tasks.
 */
export const crmTasksQuerySchema = z
  .object({
    status: z.enum(["open", "done"]).optional(),
    assignee: z.union([z.literal("me"), z.literal("none"), id]).optional(),
    due: z.enum(["overdue", "upcoming", "none"]).optional(),
    company: id.optional(),
    person: id.optional(),
    deal: id.optional(),
    q: z.string().max(200).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((query) => [query.company, query.person, query.deal].filter(Boolean).length <= 1, {
    message: "give at most one of company, person and deal",
  });

/** `POST /tasks`: assigned to its creator unless `assigneeMemberId` says otherwise (null: nobody). */
export const crmCreateTaskBodySchema = z
  .object({
    title: z.string().max(CRM_TASK_TITLE_MAX),
    body: z.string().max(CRM_TASK_BODY_MAX).nullable().optional(),
    assigneeMemberId: id.nullable().optional(),
    dueAt: isoDate.nullable().optional(),
    ...onRecord,
  })
  .refine(oneRecordAtMost, ONE_RECORD);

/**
 * `PATCH /tasks/:id`: only the fields it names. `done` completes or reopens it. Naming any of
 * `companyId`, `personId` and `dealId` moves it to that record; all three null take it off.
 */
export const crmUpdateTaskBodySchema = z
  .object({
    title: z.string().max(CRM_TASK_TITLE_MAX).optional(),
    body: z.string().max(CRM_TASK_BODY_MAX).nullable().optional(),
    /** The whole checklist, replacing the one it has. Steps left blank are dropped. */
    subtasks: z.array(crmSubtaskSchema).max(CRM_SUBTASKS_MAX).optional(),
    assigneeMemberId: id.nullable().optional(),
    dueAt: isoDate.nullable().optional(),
    done: z.boolean().optional(),
    ...onRecord,
  })
  .refine(oneRecordAtMost, ONE_RECORD);

export const crmTaskResponseSchema = z.object({ task: crmTaskSchema });
export const crmTaskListResponseSchema = z.object({
  tasks: z.array(crmTaskSchema),
  nextCursor: z.string().nullable(),
});
/** `GET /tasks/counts`: open tasks. */
export const crmTaskCountsResponseSchema = z.object({
  counts: z.object({
    /** Assigned to the caller. */
    mine: z.number().int(),
    mineOverdue: z.number().int(),
    open: z.number().int(),
    overdue: z.number().int(),
  }),
});

export type CrmTask = z.infer<typeof crmTaskSchema>;
export type CrmSubtask = z.infer<typeof crmSubtaskSchema>;
export type CrmTasksQuery = z.infer<typeof crmTasksQuerySchema>;
export type CrmCreateTaskBody = z.infer<typeof crmCreateTaskBodySchema>;
export type CrmUpdateTaskBody = z.infer<typeof crmUpdateTaskBodySchema>;
export type CrmTaskResponse = z.infer<typeof crmTaskResponseSchema>;
export type CrmTaskListResponse = z.infer<typeof crmTaskListResponseSchema>;
export type CrmTaskCountsResponse = z.infer<typeof crmTaskCountsResponseSchema>;
