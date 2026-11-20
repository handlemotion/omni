import { z } from "zod";
import { crmDeliverableStatusSchema, crmMilestoneStatusSchema } from "./crm-plan.ts";

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime();
const day = z.iso.date();

/** A project as its client sees it in the list: whose it is, and where it stands. */
export const portalProjectSchema = z.object({
  id,
  name: z.string(),
  orgId: id,
  /** The studio's workspace. */
  workspaceName: z.string(),
  companyName: z.string().nullable(),
  stage: z.object({ name: z.string(), kind: z.enum(["open", "won", "done", "lost"]) }),
});

export const portalFileSchema = z.object({
  id,
  name: z.string(),
  kind: z.enum(["file", "folder"]),
  size: z.number().int(),
  mimeType: z.string().nullable(),
  updatedAt: isoDate,
  /** The link it opens under: `/s/<shareId>?node=<id>`. */
  shareId: z.string().nullable(),
});

export const portalMilestoneSchema = z.object({
  id,
  dealId: id,
  title: z.string(),
  description: z.string().nullable(),
  targetOn: day.nullable(),
  status: crmMilestoneStatusSchema,
  position: z.number().int(),
  completedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const portalDeliverableSchema = z.object({
  id,
  dealId: id,
  milestoneId: id.nullable(),
  title: z.string(),
  description: z.string().nullable(),
  nodeId: id.nullable(),
  /** The file, when the client can open it (it sits in the portal's folder). */
  file: portalFileSchema.nullable(),
  dueOn: day.nullable(),
  status: crmDeliverableStatusSchema,
  reviewNote: z.string().nullable(),
  reviewedAt: isoDate.nullable(),
  reviewedByEmail: z.string().nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const portalContractSchema = z.object({
  id,
  title: z.string(),
  status: z.enum(["sent", "signed", "ended"]),
  signedAt: isoDate.nullable(),
  effectiveOn: day.nullable(),
  expiresOn: day.nullable(),
  /** Their own signature request: sign, then download the signed copy, at `/sign/:id`. */
  signingRequestId: id.nullable(),
});

/** `GET /api/portal/projects`: every project the person is a client on. */
export const portalProjectsResponseSchema = z.object({ projects: z.array(portalProjectSchema) });

/** `GET /api/portal/projects/:id`, and the answer to a review. */
export const portalProjectResponseSchema = z.object({
  project: portalProjectSchema,
  milestones: z.array(portalMilestoneSchema),
  deliverables: z.array(portalDeliverableSchema),
  contracts: z.array(portalContractSchema),
  /** The project's `Client` folder; null until someone is added as a client. */
  folder: z
    .object({
      id,
      /** Where the client opens it and its files: `/s/<shareId>`, `?node=<id>` for one inside. */
      shareId: z.string().nullable(),
      files: z.array(portalFileSchema),
    })
    .nullable(),
});

/**
 * `POST /api/portal/projects/:id/deliverables/:deliverableId/review`: while it is in review.
 * Asking for changes needs a note.
 */
export const portalReviewBodySchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  note: z.string().max(5000).nullable().optional(),
});

export type PortalProject = z.infer<typeof portalProjectSchema>;
export type PortalFile = z.infer<typeof portalFileSchema>;
export type PortalMilestone = z.infer<typeof portalMilestoneSchema>;
export type PortalDeliverable = z.infer<typeof portalDeliverableSchema>;
export type PortalContract = z.infer<typeof portalContractSchema>;
export type PortalProjectsResponse = z.infer<typeof portalProjectsResponseSchema>;
export type PortalProjectResponse = z.infer<typeof portalProjectResponseSchema>;
export type PortalReviewBody = z.infer<typeof portalReviewBodySchema>;
