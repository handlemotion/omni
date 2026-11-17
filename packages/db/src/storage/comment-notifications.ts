// Who hears about a new comment (ADR 0043 decision 4): the file's owner (My files) or uploader
// (Shared), and everyone who already wrote in the comment's thread, each only while a member of
// the file's workspace, since the notification opens the file from that workspace's Storage. The
// author is never told about their own comment. One notification per comment per person, however
// often it runs.
import { and, eq, inArray, or } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { notifications } from "../schema/notifications.ts";
import { storageComments } from "../schema/storage.ts";
import type { NodeRow } from "./core.ts";

/** What a comment notification carries, for the panel's line and to open the file's comments. */
export interface CommentNotificationData {
  nodeId: string;
  nodeName: string;
  space: "personal" | "shared";
  /** The folder holding the file; null at the drive's root. */
  folderId: string | null;
  commentId: string;
  /** The comment's first words. */
  excerpt: string;
}

const EXCERPT = 140;

/** Notifies who should hear about comment `commentId` on `node`. Returns who got one. */
export async function notifyComment(
  tx: Db,
  input: {
    node: NodeRow;
    commentId: string;
    rootId: string | null;
    authorMemberId: string;
    body: string;
  },
): Promise<string[]> {
  const { node } = input;
  const owner = node.space === "personal" ? node.ownerMemberId : node.createdByMemberId;
  const writers = input.rootId
    ? await tx
        .selectDistinct({ id: storageComments.authorMemberId })
        .from(storageComments)
        .where(or(eq(storageComments.id, input.rootId), eq(storageComments.parentId, input.rootId)))
    : [];
  // My files is its owner's alone: the thread's other writers reached it through a grant.
  const candidates = [owner, ...(node.space === "shared" ? writers.map((w) => w.id) : [])];
  const wanted = [
    ...new Set(candidates.filter((id): id is string => !!id && id !== input.authorMemberId)),
  ];
  if (wanted.length === 0) return [];
  const inWorkspace = await tx
    .select({ id: members.id })
    .from(members)
    .where(and(inArray(members.id, wanted), eq(members.organizationId, node.orgId)));
  if (inWorkspace.length === 0) return [];
  const flat = input.body.replace(/\s+/g, " ").trim();
  const data: CommentNotificationData = {
    nodeId: node.id,
    nodeName: node.name,
    space: node.space,
    folderId: node.parentId,
    commentId: input.commentId,
    excerpt: flat.length > EXCERPT ? `${flat.slice(0, EXCERPT).trimEnd()}…` : flat,
  };
  const rows = await tx
    .insert(notifications)
    .values(
      inWorkspace.map(({ id }) => ({
        id: uuidv7(),
        orgId: node.orgId,
        memberId: id,
        kind: "comment" as const,
        actorMemberId: input.authorMemberId,
        data: { ...data },
        dedupeKey: `comment:${input.commentId}`,
      })),
    )
    .onConflictDoNothing()
    .returning({ memberId: notifications.memberId });
  return rows.map((r) => r.memberId);
}
