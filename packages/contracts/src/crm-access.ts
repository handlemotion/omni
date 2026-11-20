import { z } from "zod";

export const crmProjectScopeSchema = z.enum(["freelancer", "client"]);

/** Someone outside the team on a project. Teammates are never listed: they see every project. */
export const crmProjectAccessSchema = z.object({
  email: z.string(),
  scope: crmProjectScopeSchema,
  /** Their name, once the address belongs to an account. */
  name: z.string().nullable(),
  addedByMemberId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/** `GET /deals/:id/access`, and the answer to every change of it. */
export const crmProjectAccessResponseSchema = z.object({
  access: z.array(crmProjectAccessSchema),
});

/**
 * `PUT /deals/:id/access/:email`: adds the address to the project, or changes its scope. A
 * freelancer is also given editor on the project's Drive folder, and invited to the workspace
 * as a freelancer with `/api/workspace/invitations`.
 */
export const crmPutProjectAccessBodySchema = z.object({ scope: crmProjectScopeSchema });

export type CrmProjectScope = z.infer<typeof crmProjectScopeSchema>;
export type CrmProjectAccess = z.infer<typeof crmProjectAccessSchema>;
export type CrmProjectAccessResponse = z.infer<typeof crmProjectAccessResponseSchema>;
export type CrmPutProjectAccessBody = z.infer<typeof crmPutProjectAccessBodySchema>;
