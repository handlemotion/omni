// Comments on a file (ADR 0043 decisions 4 and 5), under `/api/storage` and again under
// `/api/storage/shared/:shareId` for a person the file was shared with. Split out of
// `storage.ts` by concern. A member, an Editor and a Commenter read and write them; a Viewer and
// a link alone get `403`.
import { z } from "zod";

const isoDate = z.iso.datetime();
const id = z.string().min(1);
/** A fraction of a PDF page's width or height. */
const fraction = z.number().min(0).max(1);
const line = z.number().int().positive();

/**
 * Where a thread points. On a PDF page, a box in fractions of the page, so it holds at any zoom;
 * lines and cells count from 1; `file` is the whole file.
 */
export const storageCommentAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file") }),
  z
    .object({
      kind: z.literal("pdf"),
      page: line,
      x: fraction,
      y: fraction,
      width: fraction,
      height: fraction,
    })
    .refine((box) => box.x + box.width <= 1 && box.y + box.height <= 1, {
      message: "the box must fit on the page",
    }),
  z
    .object({ kind: z.literal("lines"), start: line, end: line })
    .refine((lines) => lines.end >= lines.start, { message: "end must not come before start" }),
  z.object({
    kind: z.literal("cell"),
    sheet: z.string().min(1).max(255).optional(),
    row: line,
    column: line,
  }),
]);

const body = z.string().trim().min(1).max(10_000);

export const storageCommentSchema = z.object({
  id,
  /** The thread's root; null on the root itself. */
  parentId: id.nullable(),
  /** The file's `contentVersion` the comment was made on. */
  contentVersion: z.number().int().nonnegative(),
  /** Where the thread points; null on a reply. */
  anchor: storageCommentAnchorSchema.nullable(),
  body: z.string(),
  /** Null once the author has left. */
  authorName: z.string().nullable(),
  /** Written by the reader: only they edit or delete it. */
  mine: z.boolean(),
  createdAt: isoDate,
  editedAt: isoDate.nullable(),
  /** A root only: when the thread was resolved, and by whom. */
  resolvedAt: isoDate.nullable(),
  resolvedByName: z.string().nullable(),
});

/**
 * `GET /files/:id/comments`: every comment on the file, oldest first; a thread is a root and the
 * comments whose `parentId` is it. `contentVersion` is the file's now: a thread made on an
 * earlier one points at content that has since been replaced.
 */
export const storageCommentsResponseSchema = z.object({
  contentVersion: z.number().int().nonnegative(),
  comments: z.array(storageCommentSchema),
});

/**
 * `POST /files/:id/comments`: starts a thread at `anchor` (the whole file when absent) on the
 * content the author was looking at, `contentVersion` (the file's current one when absent), or
 * with `parentId` replies to that comment's thread, which opens it again if it was resolved. A
 * reply has no anchor. Answers `201 { comment }`; a `contentVersion` the file has not reached
 * answers `409 version_conflict`.
 */
export const storageAddCommentBodySchema = z.union([
  z
    .object({
      body,
      anchor: storageCommentAnchorSchema.optional(),
      contentVersion: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z.object({ body, parentId: id }).strict(),
]);

/**
 * `PATCH /files/:id/comments/:commentId`: with `body`, changes a comment the reader wrote
 * (`403` for anyone else's); with `resolved`, resolves the comment's thread or opens it again,
 * which anyone who may comment does, and answers the thread's root. One of the two.
 * `DELETE` the same deletes a comment the reader wrote, a root with its replies (`204`).
 */
export const storageChangeCommentBodySchema = z.union([
  z.object({ body }).strict(),
  z.object({ resolved: z.boolean() }).strict(),
]);
export const storageCommentResponseSchema = z.object({ comment: storageCommentSchema });

export type StorageCommentAnchor = z.infer<typeof storageCommentAnchorSchema>;
export type StorageComment = z.infer<typeof storageCommentSchema>;
export type StorageCommentsResponse = z.infer<typeof storageCommentsResponseSchema>;
export type StorageAddCommentBody = z.infer<typeof storageAddCommentBodySchema>;
export type StorageChangeCommentBody = z.infer<typeof storageChangeCommentBodySchema>;
export type StorageCommentResponse = z.infer<typeof storageCommentResponseSchema>;
