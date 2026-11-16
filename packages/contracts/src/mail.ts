// Mail's HTTP API as its clients see it (ADR 0035 decision 3), for routes that cross into another
// module: what the web and iOS apps send under `/api/mail`. Error codes are rows in `ERROR_CODES`.
import { z } from "zod";

/**
 * `POST /api/mail/attachments/:id/save-to-drive` (ADR 0039 decision 3): copies the attachment
 * once into the folder `parentId` (My files or Shared), or My files' root without one. The answer
 * is Storage's `{ node }` (`StorageNodeResponse`), 201.
 */
export const mailSaveToDriveBodySchema = z.object({
  parentId: z.string().min(1).max(64).optional(),
});

export type MailSaveToDriveBody = z.infer<typeof mailSaveToDriveBodySchema>;
