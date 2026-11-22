import { and, eq, inArray, or } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { notifications } from "../schema/notifications.ts";
import { storageComments } from "../schema/storage.ts";
import { memberDoor, readsComments } from "./access.ts";
import type { NodeRow } from "./core.ts";
import { reach } from "./tree.ts";

/** What a comment notification carries, for the panel's line and to open the file's comments. */
export interface CommentNotificationData {
  nodeId: string;
  nodeName: string;
  space: "personal" | "shared" | "teamspace";
  /** The teamspace holding the file, when `space` is `teamspace`. */
  teamspaceId?: string | null;
  /** The folder holding the file; null at the drive's root. */
  folderId: string | null;
  commentId: string;
  /** The comment's first words. */
  excerpt: string;
}

const EXCERPT = 140;

async function stillReaching(tx: Db, nodeId: string, memberIds: string[]) {
  const reaching: string[] = [];
  for (const id of memberIds) {
    const found = await reach(tx, memberDoor(id), nodeId);
    if (found && readsComments(found.access)) reaching.push(id);
  }
  return reaching;
}

/** Notifies who should hear about comment `commentId` on `node`. Returns who got one. */
export const notifyComment: (
  tx: Db,
  input: {
    node: NodeRow;
    commentId: string;
    rootId: string | null;
    authorMemberId: string;
    body: string;
  },
) => Promise<string[]> = async (tx, input) => {
  const { node } = input;
  const owner = node.space === "personal" ? node.ownerMemberId : node.createdByMemberId;
  const writers = input.rootId
    ? await tx
        .selectDistinct({ id: storageComments.authorMemberId })
        .from(storageComments)
        .where(or(eq(storageComments.id, input.rootId), eq(storageComments.parentId, input.rootId)))
    : [];
  const candidates = [owner, ...(node.space === "personal" ? [] : writers.map((w) => w.id))];
  const named = [
    ...new Set(candidates.filter((id): id is string => !!id && id !== input.authorMemberId)),
  ];
  const wanted = node.space === "teamspace" ? await stillReaching(tx, node.id, named) : named;
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
    ...(node.teamspaceId ? { teamspaceId: node.teamspaceId } : {}),
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
};
