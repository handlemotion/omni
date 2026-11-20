import { z } from "zod";
import { storageNodeSchema } from "./storage.ts";

const id = z.string().min(1).max(64);
const isoDate = z.iso.datetime();

/**
 * A Drive file or folder linked to a company or a deal where it lives (`docs/spec/crm.md`, "Keep the files"): a reference,
 * not a copy. `GET /companies/:id/links` and `GET /deals/:id/links` list the ones the reader can
 * open in Drive, newest first.
 */
export const crmFileLinkSchema = z.object({
  node: storageNodeSchema,
  linkedAt: isoDate,
  linkedByMemberId: id.nullable(),
});
export const crmFileLinksResponseSchema = z.object({ links: z.array(crmFileLinkSchema) });
/** `POST /companies/:id/links` and `POST /deals/:id/links`: nodes the member can open now. */
export const crmLinkFilesBodySchema = z.strictObject({
  nodeIds: z.array(id).min(1).max(200),
});

export type CrmFileLink = z.infer<typeof crmFileLinkSchema>;
export type CrmFileLinksResponse = z.infer<typeof crmFileLinksResponseSchema>;
export type CrmLinkFilesBody = z.infer<typeof crmLinkFilesBodySchema>;
