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

/** The lanes a member can file a thread in (`threads.triage`). `unsure` is only ever a list filter. */
export const THREAD_LANES = ["needs_reply", "waiting_on_them", "fyi", "noise"] as const;

export type ThreadLane = (typeof THREAD_LANES)[number];

/**
 * `PUT /api/threads/:id/lane`: files the thread in `lane` as this member's choice, on a personal
 * or a shared mailbox. The answer is `ThreadLaneResponse`; 404 when the member cannot
 * see the thread.
 */
export const threadLaneBodySchema = z.object({ lane: z.enum(THREAD_LANES) });

export type ThreadLaneBody = z.infer<typeof threadLaneBodySchema>;

export interface ThreadLaneResponse {
  triage: ThreadLane;
  changed: boolean;
}
