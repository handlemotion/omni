import { z } from "zod";

const isoDate = z.iso.datetime();

/** Who wrote in a session: a member, an agent acting for one, or unknown (before stamping). */
export const storageHistoryAuthorSchema = z.object({
  kind: z.enum(["member", "agent", "unknown"]),
  name: z.string().nullable(),
  agent: z.string().nullable(),
});

/** One editing session of a doc's history (`docs/spec/docs.md`, "History"). */
export const storageHistorySessionSchema = z.object({
  id: z.string(),
  startedAt: isoDate,
  endedAt: isoDate,
  authors: z.array(storageHistoryAuthorSchema),
  /** The file's content version once the session was saved. */
  contentVersion: z.number().int().nonnegative(),
  /** Whether the page as it was at the session's end is still kept, so it can be restored. */
  restorable: z.boolean(),
  /**
   * The version holding that page, to restore with `POST /files/:id/versions/:versionId/restore`
   * (which edits the live document); null when it is the file's content now, or gone.
   */
  versionId: z.string().nullable(),
});

/** `GET /files/:id/history`: the doc's sessions, newest first. Editors only. */
export const storageHistoryResponseSchema = z.object({
  sessions: z.array(storageHistorySessionSchema),
  keepDays: z.number().int().positive(),
});

const blockChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("same"), text: z.string() }),
  z.object({ kind: z.literal("added"), text: z.string() }),
  z.object({ kind: z.literal("removed"), text: z.string() }),
  z.object({ kind: z.literal("moved"), text: z.string() }),
  z.object({
    kind: z.literal("changed"),
    before: z.string(),
    after: z.string(),
    words: z.array(
      z.object({
        value: z.string(),
        added: z.boolean().optional(),
        removed: z.boolean().optional(),
      }),
    ),
  }),
]);

/**
 * `GET /files/:id/history/:sessionId`: what the session changed, block by block, from the page
 * before it to the page at its end, and the counts the list shows.
 */
export const storageHistorySessionResponseSchema = z.object({
  session: storageHistorySessionSchema,
  /**
   * False when the page before or after the session can no longer be rebuilt (its baseline or a
   * version it needs is gone): `blocks` is then empty, never a guess.
   */
  available: z.boolean(),
  blocks: z.array(blockChangeSchema),
  counts: z.object({ added: z.number(), removed: z.number(), changed: z.number() }),
});

export type StorageHistoryResponse = z.infer<typeof storageHistoryResponseSchema>;
export type StorageHistorySessionResponse = z.infer<typeof storageHistorySessionResponseSchema>;
