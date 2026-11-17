// Comments on a file (ADR 0043 decisions 4 and 5): rows in `storage_comments`, never bytes in the
// file. A thread is a root, which carries the anchor and the resolved state, and its replies. A
// member, an editor and a commenter read a file's comments and write their own; a viewer and a
// link alone see none. Comments are not content: writing one leaves the file's revision alone, so
// a sync client never downloads a file again because someone commented on it, and a locked file
// still takes comments.
import { and, asc, eq, inArray, isNull, sql, type Column } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { storageComments, type StorageCommentAnchor } from "../schema/storage.ts";
import { readsComments, type Door } from "./access.ts";
import { inTrash, type NodeRow } from "./core.ts";
import { notifyComment } from "./comment-notifications.ts";
import { reach } from "./tree.ts";

export type { StorageCommentAnchor };

export interface StorageComment {
  id: string;
  /** The thread's root; null on the root itself. */
  parentId: string | null;
  /** The file's `contentVersion` the comment was made on. */
  contentVersion: number;
  /** Where the thread points; null on a reply. */
  anchor: StorageCommentAnchor | null;
  body: string;
  /** Null once the author is gone. */
  authorName: string | null;
  /** The author's picture, when they have one. */
  authorImage: string | null;
  /** Written by the person asking: only they edit or delete it. */
  mine: boolean;
  createdAt: Date;
  editedAt: Date | null;
  /** A root only: when the thread was resolved, and by whom. */
  resolvedAt: Date | null;
  resolvedByName: string | null;
}

type NotFound = { status: "not_found" };
type Forbidden = { status: "forbidden" };
export type CommentsResult =
  | { status: "ok"; contentVersion: number; comments: StorageComment[] }
  | NotFound
  | Forbidden;
export type CommentResult = { status: "ok"; comment: StorageComment } | NotFound | Forbidden;
export type AddCommentResult =
  /** `notified`: the file's workspace and the members told about it, for the realtime nudge. */
  | { status: "ok"; comment: StorageComment; notified: { orgId: string; memberIds: string[] } }
  | NotFound
  | Forbidden
  /** The content version named is one the file has not reached. */
  | { status: "version_conflict" };
export type DeleteCommentResult = { status: "ok" } | NotFound | Forbidden;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

const author = alias(members, "comment_author");
const authorUser = alias(users, "comment_author_user");
const resolver = alias(members, "comment_resolver");
const resolverUser = alias(users, "comment_resolver_user");

/** A person's name, or their address while they have not set one (a magic-link sign-up). */
const displayName = (user: { name: Column; email: Column }) =>
  sql<string | null>`coalesce(nullif(${user.name}, ''), ${user.email})`;

/** A live file whose comments the door's holder may read and add to, or why not. */
async function commentable(ex: Db, door: Door, nodeId: string) {
  const found = await reach(ex, door, nodeId);
  if (!found || found.node.kind !== "file" || inTrash(found.chain)) return NOT_FOUND;
  if (!readsComments(found.access)) return FORBIDDEN;
  return { status: "ok", node: found.node } as const;
}

/** The file's comments, or the ones named, oldest first, as `door`'s holder sees them. */
async function readComments(ex: Db, door: Door, node: NodeRow, ids?: string[]) {
  const rows = await ex
    .select({
      comment: storageComments,
      authorName: displayName(authorUser),
      authorImage: authorUser.image,
      resolvedByName: displayName(resolverUser),
    })
    .from(storageComments)
    .leftJoin(author, eq(author.id, storageComments.authorMemberId))
    .leftJoin(authorUser, eq(authorUser.id, author.userId))
    .leftJoin(resolver, eq(resolver.id, storageComments.resolvedByMemberId))
    .leftJoin(resolverUser, eq(resolverUser.id, resolver.userId))
    .where(
      and(eq(storageComments.nodeId, node.id), ids ? inArray(storageComments.id, ids) : undefined),
    )
    .orderBy(asc(storageComments.createdAt), asc(storageComments.id));
  // Asked once per author, not per comment: a thread is mostly two or three people.
  const authors = new Set(rows.flatMap((row) => row.comment.authorMemberId ?? []));
  const mine = new Set<string>();
  for (const memberId of authors) {
    // `ownsUpload` answers whether a member is the door's holder, which is the question here.
    if (await door.ownsUpload(ex, memberId)) mine.add(memberId);
  }
  return rows.map(
    ({ comment, authorName, authorImage, resolvedByName }) =>
      ({
        id: comment.id,
        parentId: comment.parentId,
        contentVersion: comment.contentVersion,
        anchor: comment.anchor,
        body: comment.body,
        authorName,
        authorImage,
        mine: comment.authorMemberId !== null && mine.has(comment.authorMemberId),
        createdAt: comment.createdAt,
        editedAt: comment.editedAt,
        resolvedAt: comment.resolvedAt,
        resolvedByName,
      }) satisfies StorageComment,
  );
}

const one: (ex: Db, door: Door, node: NodeRow, id: string) => Promise<CommentResult> = async (
  ex,
  door,
  node,
  id,
) => {
  const [comment] = await readComments(ex, door, node, [id]);
  return comment ? { status: "ok", comment } : NOT_FOUND;
};

/** A comment on this file, with the id of its thread's root. */
async function findComment(ex: Db, nodeId: string, id: string) {
  const [row] = await ex
    .select()
    .from(storageComments)
    .where(and(eq(storageComments.id, id), eq(storageComments.nodeId, nodeId)));
  return row ? { ...row, rootId: row.parentId ?? row.id } : null;
}

export function commentOperations(db: Db, door: Door) {
  /** A comment the door's holder wrote, on a file they still may comment on. */
  async function ownComment(ex: Db, nodeId: string, id: string) {
    const found = await commentable(ex, door, nodeId);
    if (found.status !== "ok") return found;
    const comment = await findComment(ex, nodeId, id);
    if (!comment) return NOT_FOUND;
    const own = comment.authorMemberId && (await door.ownsUpload(ex, comment.authorMemberId));
    return own ? ({ status: "ok", node: found.node, comment } as const) : FORBIDDEN;
  }

  return {
    /** The file's comments, oldest first, and the content version the file is at now. */
    async comments(nodeId: string) {
      const found = await commentable(db, door, nodeId);
      if (found.status !== "ok") return found satisfies CommentsResult;
      return {
        status: "ok",
        contentVersion: found.node.contentVersion,
        comments: await readComments(db, door, found.node),
      } satisfies CommentsResult;
    },

    /**
     * Starts a thread at `anchor` (the whole file when none) on the content the author viewed,
     * `contentVersion`, or the current content when none: an anchor read off version 1 stays on
     * version 1 when someone saved version 2 meanwhile. Or replies to the thread `parentId`
     * belongs to. A reply to a resolved thread opens it again.
     */
    addComment(
      nodeId: string,
      input: {
        body: string;
        anchor?: StorageCommentAnchor;
        contentVersion?: number;
        parentId?: string;
      },
    ) {
      return db.transaction<AddCommentResult>(async (tx) => {
        const found = await commentable(tx, door, nodeId);
        if (found.status !== "ok") return found satisfies AddCommentResult;
        const current = found.node.contentVersion;
        const viewed = input.parentId ? current : (input.contentVersion ?? current);
        if (viewed > current) return { status: "version_conflict" } satisfies AddCommentResult;
        const authorMemberId = await door.actor(tx, found.node.orgId);
        if (!authorMemberId) return FORBIDDEN satisfies AddCommentResult;
        let rootId: string | null = null;
        if (input.parentId) {
          const parent = await findComment(tx, nodeId, input.parentId);
          if (!parent) return NOT_FOUND satisfies AddCommentResult;
          rootId = parent.rootId;
          await tx
            .update(storageComments)
            .set({ resolvedAt: null, resolvedByMemberId: null })
            .where(eq(storageComments.id, rootId));
        }
        const [row] = await tx
          .insert(storageComments)
          .values({
            orgId: found.node.orgId,
            nodeId,
            parentId: rootId,
            contentVersion: viewed,
            anchor: rootId ? null : (input.anchor ?? { kind: "file" }),
            body: input.body,
            authorMemberId,
            // From this clock, as the list orders by it next to rows written the same way.
            createdAt: new Date(),
          })
          .returning({ id: storageComments.id });
        const added = await one(tx, door, found.node, row!.id);
        if (added.status !== "ok") return added satisfies AddCommentResult;
        const memberIds = await notifyComment(tx, {
          node: found.node,
          commentId: row!.id,
          rootId,
          authorMemberId,
          body: input.body,
        });
        return {
          ...added,
          notified: { orgId: found.node.orgId, memberIds },
        } satisfies AddCommentResult;
      });
    },

    /** Changes the body of a comment the holder wrote. */
    async editComment(nodeId: string, id: string, body: string) {
      const found = await ownComment(db, nodeId, id);
      if (found.status !== "ok") return found satisfies CommentResult;
      await db
        .update(storageComments)
        .set({ body, editedAt: sql`now()` })
        .where(eq(storageComments.id, id));
      return one(db, door, found.node, id) satisfies Promise<CommentResult>;
    },

    /** Deletes a comment the holder wrote; a thread's root takes its replies with it. */
    async deleteComment(nodeId: string, id: string) {
      const found = await ownComment(db, nodeId, id);
      if (found.status !== "ok") return found satisfies DeleteCommentResult;
      await db.delete(storageComments).where(eq(storageComments.id, id));
      return { status: "ok" } satisfies DeleteCommentResult;
    },

    /**
     * Resolves the thread `id` belongs to, or opens it again. Anyone who may comment does it;
     * resolving a resolved thread keeps who resolved it first. Answers the thread's root.
     */
    async resolveComment(nodeId: string, id: string, resolved: boolean) {
      const found = await commentable(db, door, nodeId);
      if (found.status !== "ok") return found satisfies CommentResult;
      const comment = await findComment(db, nodeId, id);
      if (!comment) return NOT_FOUND satisfies CommentResult;
      if (resolved) {
        const memberId = await door.actor(db, found.node.orgId);
        await db
          .update(storageComments)
          .set({ resolvedAt: sql`now()`, resolvedByMemberId: memberId })
          .where(and(eq(storageComments.id, comment.rootId), isNull(storageComments.resolvedAt)));
      } else {
        await db
          .update(storageComments)
          .set({ resolvedAt: null, resolvedByMemberId: null })
          .where(eq(storageComments.id, comment.rootId));
      }
      return one(db, door, found.node, comment.rootId) satisfies Promise<CommentResult>;
    },
  };
}
