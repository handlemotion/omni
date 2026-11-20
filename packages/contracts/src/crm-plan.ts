import { z } from "zod";

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime();
const day = z.iso.date();

export const CRM_PLAN_TITLE_MAX = 300;
export const CRM_PLAN_DESCRIPTION_MAX = 20_000;

export const crmMilestoneStatusSchema = z.enum(["planned", "in_progress", "done"]);
export const crmDeliverableStatusSchema = z.enum([
  "draft",
  "in_review",
  "approved",
  "changes_requested",
]);

export const crmMilestoneSchema = z.object({
  id,
  dealId: id,
  title: z.string(),
  description: z.string().nullable(),
  targetOn: day.nullable(),
  status: crmMilestoneStatusSchema,
  /** The team's order, from 0. */
  position: z.number().int(),
  /** Set while it is done. */
  completedAt: isoDate.nullable(),
  createdByMemberId: id.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const crmDeliverableSchema = z.object({
  id,
  dealId: id,
  milestoneId: id.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  /** A Drive file. */
  nodeId: id.nullable(),
  dueOn: day.nullable(),
  status: crmDeliverableStatusSchema,
  /** Shown on the client portal. */
  clientVisible: z.boolean(),
  /** The client's last answer, with their note. */
  reviewNote: z.string().nullable(),
  reviewedAt: isoDate.nullable(),
  reviewedByEmail: z.string().nullable(),
  createdByMemberId: id.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

/** `GET /deals/:id/plan`: every milestone in order, and every deliverable oldest first. */
export const crmPlanResponseSchema = z.object({
  milestones: z.array(crmMilestoneSchema),
  deliverables: z.array(crmDeliverableSchema),
});

const title = z.string().max(CRM_PLAN_TITLE_MAX);
const description = z.string().max(CRM_PLAN_DESCRIPTION_MAX).nullable().optional();

/** `POST /deals/:id/milestones`: added last. */
export const crmCreateMilestoneBodySchema = z.object({
  title,
  description,
  targetOn: day.nullable().optional(),
  status: crmMilestoneStatusSchema.optional(),
});

/** `PATCH /milestones/:id`: only the fields it names. `position` moves it, from 0. */
export const crmUpdateMilestoneBodySchema = crmCreateMilestoneBodySchema.partial().extend({
  position: z.number().int().min(0).max(1000).optional(),
});

/** `POST /deals/:id/deliverables`. `milestoneId` is one of the deal's; `nodeId` a file you can open. */
export const crmCreateDeliverableBodySchema = z.object({
  title,
  description,
  milestoneId: id.nullable().optional(),
  nodeId: id.nullable().optional(),
  dueOn: day.nullable().optional(),
  status: crmDeliverableStatusSchema.optional(),
  clientVisible: z.boolean().optional(),
});

/** `PATCH /deliverables/:id`: only the fields it names. */
export const crmUpdateDeliverableBodySchema = crmCreateDeliverableBodySchema.partial();

export const crmMilestoneResponseSchema = z.object({ milestone: crmMilestoneSchema });
export const crmDeliverableResponseSchema = z.object({ deliverable: crmDeliverableSchema });

export type CrmMilestone = z.infer<typeof crmMilestoneSchema>;
export type CrmDeliverable = z.infer<typeof crmDeliverableSchema>;
export type CrmPlanResponse = z.infer<typeof crmPlanResponseSchema>;
export type CrmCreateMilestoneBody = z.infer<typeof crmCreateMilestoneBodySchema>;
export type CrmUpdateMilestoneBody = z.infer<typeof crmUpdateMilestoneBodySchema>;
export type CrmCreateDeliverableBody = z.infer<typeof crmCreateDeliverableBodySchema>;
export type CrmUpdateDeliverableBody = z.infer<typeof crmUpdateDeliverableBodySchema>;
export type CrmMilestoneResponse = z.infer<typeof crmMilestoneResponseSchema>;
export type CrmDeliverableResponse = z.infer<typeof crmDeliverableResponseSchema>;
