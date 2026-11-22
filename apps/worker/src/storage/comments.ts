import {
  storageAddCommentBodySchema,
  storageChangeCommentBodySchema,
  type StorageComment,
  type StorageCommentResponse,
  type StorageCommentsResponse,
} from "@omni/contracts";
import type { StorageComment as CommentRow } from "@omni/db";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../context.ts";
import { checkRateLimit, clientIp, tooManyRequests } from "../rate-limiter.ts";
import { notifyMembers } from "../realtime.ts";
import { zValidator } from "../validator.ts";
import { memberStorage, refused } from "./http.ts";

function commentDoor(c: Context<AppEnv>) {
  const shared = c.var.shared;
  if (!shared) return { files: memberStorage(c), orgId: c.var.member.orgId, guest: false };
  if (!shared.comments) throw new HTTPException(403, { message: "you cannot comment here" });
  return { files: shared.comments, orgId: shared.root.node.orgId, guest: shared.via === "link" };
}

function announceComments(c: Context<AppEnv>, orgId: string, nodeId: string) {
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(orgId));
  c.executionCtx.waitUntil(
    stub
      .commentsChanged(nodeId)
      .catch((error: unknown) => c.var.log.warn("storage.comments_announce_failed", { error })),
  );
}

const wireComment = (comment: CommentRow) => {
  const result: StorageComment = {
    ...comment,
    createdAt: comment.createdAt.toISOString(),
    editedAt: comment.editedAt?.toISOString() ?? null,
    resolvedAt: comment.resolvedAt?.toISOString() ?? null,
  };
  return result;
};

export const storageComments = new Hono<AppEnv>()
  .get("/files/:id/comments", async (c) => {
    const listed = await commentDoor(c).files.comments(c.req.param("id"));
    if (listed.status !== "ok") return refused(c, listed.status);
    return c.json({
      contentVersion: listed.contentVersion,
      comments: listed.comments.map(wireComment),
    } satisfies StorageCommentsResponse);
  })

  .post("/files/:id/comments", zValidator("json", storageAddCommentBodySchema), async (c) => {
    const door = commentDoor(c);
    if (door.guest) {
      const key = `${c.req.param("shareId")}:${clientIp(c.req.raw)}`;
      const wait = await checkRateLimit(c.env, c.var.config, "storageLinkComment", key);
      if (wait) return tooManyRequests(c, wait, "storageLinkComment");
    }
    const added = await door.files.addComment(c.req.param("id"), c.req.valid("json"));
    if (added.status !== "ok") return refused(c, added.status);
    await notifyMembers(c.env, c.var.db, { ...added.notified, threadId: null, kind: "comment" });
    announceComments(c, door.orgId, c.req.param("id"));
    return c.json({ comment: wireComment(added.comment) } satisfies StorageCommentResponse, 201);
  })

  .patch(
    "/files/:id/comments/:commentId",
    zValidator("json", storageChangeCommentBodySchema),
    async (c) => {
      const { id, commentId } = c.req.param();
      const { files, orgId } = commentDoor(c);
      const change = c.req.valid("json");
      const changed =
        "body" in change
          ? await files.editComment(id, commentId, change.body)
          : await files.resolveComment(id, commentId, change.resolved);
      if (changed.status !== "ok") return refused(c, changed.status);
      announceComments(c, orgId, id);
      return c.json({ comment: wireComment(changed.comment) } satisfies StorageCommentResponse);
    },
  )

  .delete("/files/:id/comments/:commentId", async (c) => {
    const { id, commentId } = c.req.param();
    const door = commentDoor(c);
    const deleted = await door.files.deleteComment(id, commentId);
    if (deleted.status !== "ok") return refused(c, deleted.status);
    announceComments(c, door.orgId, id);
    return c.body(null, 204);
  });
