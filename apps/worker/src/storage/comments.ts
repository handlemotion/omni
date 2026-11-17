// A file's comments (ADR 0043 decisions 4 and 5): list, add, edit, resolve, delete. Written
// against `writeDoor` like the rest of `changes.ts`, so a member and a person the file was shared
// with use the same routes; `@omni/db` decides who may (a member, an Editor or a Commenter), and
// a link alone reaches none of them. A comment is not the file's content: nothing here changes
// its revision, so nothing is announced to sync clients.
import {
  storageAddCommentBodySchema,
  storageChangeCommentBodySchema,
  type StorageComment,
  type StorageCommentResponse,
  type StorageCommentsResponse,
} from "@omni/contracts";
import type { StorageComment as CommentRow } from "@omni/db";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { notifyMembers } from "../realtime.ts";
import { zValidator } from "../validator.ts";
import { refused, writeDoor } from "./http.ts";

const wireComment = (comment: CommentRow): StorageComment => ({
  ...comment,
  createdAt: comment.createdAt.toISOString(),
  editedAt: comment.editedAt?.toISOString() ?? null,
  resolvedAt: comment.resolvedAt?.toISOString() ?? null,
});

export const storageComments = new Hono<AppEnv>()
  .get("/files/:id/comments", async (c) => {
    const listed = await writeDoor(c).files.comments(c.req.param("id"));
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({
      contentVersion: listed.contentVersion,
      comments: listed.comments.map(wireComment),
    } satisfies StorageCommentsResponse);
  })

  .post("/files/:id/comments", zValidator("json", storageAddCommentBodySchema), async (c) => {
    const added = await writeDoor(c).files.addComment(c.req.param("id"), c.req.valid("json"));
    if (added.status !== "ok") return refused(c, added.status);
    // The file's owner and the thread's writers, in the file's workspace (see `notifyComment`).
    await notifyMembers(c.env, c.var.db, { ...added.notified, threadId: null, kind: "comment" });
    return c.json({ comment: wireComment(added.comment) } satisfies StorageCommentResponse, 201);
  })

  .patch(
    "/files/:id/comments/:commentId",
    zValidator("json", storageChangeCommentBodySchema),
    async (c) => {
      const { id, commentId } = c.req.param();
      const { files } = writeDoor(c);
      const change = c.req.valid("json");
      const changed =
        "body" in change
          ? await files.editComment(id, commentId, change.body)
          : await files.resolveComment(id, commentId, change.resolved);
      if (changed.status !== "ok") return refused(c, changed.status);
      return c.json({ comment: wireComment(changed.comment) } satisfies StorageCommentResponse);
    },
  )

  .delete("/files/:id/comments/:commentId", async (c) => {
    const { id, commentId } = c.req.param();
    const deleted = await writeDoor(c).files.deleteComment(id, commentId);
    if (deleted.status !== "ok") return refused(c, deleted.status);
    return c.body(null, 204);
  });
