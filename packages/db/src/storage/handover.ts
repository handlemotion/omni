// A company keeps its files when someone leaves (ADR 0034 decision 1): before a member row goes,
// their My files in that company move into a folder in someone else's My files. Trusted: the
// caller has already decided the member is leaving and who removed them.
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { storageNodes } from "../schema/storage.ts";
import { insertNode, lockTree, STORAGE_NAME_MAX_LENGTH, type Drive } from "./core.ts";

export type StorageHandOverResult =
  /** `folderId` is the new `Files from <name>` folder; null when there was nothing to move. */
  | { status: "ok"; moved: number; folderId: string | null; toMemberId: string | null }
  /** Nobody else in the workspace can take the files; nothing changed. */
  | { status: "no_recipient" };

const isOwner = sql`'owner' = any(string_to_array(replace(${members.role}, ' ', ''), ','))`;

/** The folder's name: a person's name may hold what a node's name may not. */
function folderName(person: string) {
  // oxlint-disable-next-line no-control-regex
  const clean = person.replaceAll(/[/\\\u0000-\u001f\u007f]/g, " ").trim();
  return `Files from ${clean || "a former member"}`.slice(0, STORAGE_NAME_MAX_LENGTH);
}

/**
 * Moves everything in `memberId`'s My files, Trash included, into a new folder
 * `Files from <name>` at the root of the My files of `toMemberId` (whoever removed them), or of
 * the workspace's oldest other owner when that is absent, not in the workspace, or the member
 * themselves. By `owner_member_id`, in one transaction. Run again it finds nothing to move and
 * changes nothing, so it is safe before every removal. Shared files, grants and links stay as
 * they are. The folder sits one level above what was a root, so a tree ends one deeper each
 * time it changes hands, past the depth cap if it was at it; the walks are not bound by the cap
 * (`MAX_WALK` in `core.ts`).
 */
export async function handOverMemberStorage(
  db: Db,
  input: { memberId: string; toMemberId?: string | null },
): Promise<StorageHandOverResult> {
  return db.transaction(async (tx): Promise<StorageHandOverResult> => {
    const [leaving] = await tx
      .select({ orgId: members.organizationId, name: users.name, email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.id, input.memberId));
    if (!leaving) return { status: "ok", moved: 0, folderId: null, toMemberId: null };
    await lockTree(tx, leaving.orgId);
    const owned = and(
      eq(storageNodes.orgId, leaving.orgId),
      eq(storageNodes.ownerMemberId, input.memberId),
    );
    const [first] = await tx
      .select({ id: storageNodes.id })
      .from(storageNodes)
      .where(owned)
      .limit(1);
    if (!first) return { status: "ok", moved: 0, folderId: null, toMemberId: null };

    const others = and(eq(members.organizationId, leaving.orgId), ne(members.id, input.memberId));
    const [named] = input.toMemberId
      ? await tx
          .select({ id: members.id })
          .from(members)
          .where(and(others, eq(members.id, input.toMemberId)))
      : [];
    const [owner] = named
      ? [named]
      : await tx
          .select({ id: members.id })
          .from(members)
          .where(and(others, isOwner))
          .orderBy(asc(members.createdAt), asc(members.id))
          .limit(1);
    if (!owner) return { status: "no_recipient" };

    const drive: Drive = { orgId: leaving.orgId, space: "personal", ownerMemberId: owner.id };
    const folder = await insertNode(tx, {
      drive,
      parentId: null,
      kind: "folder",
      name: folderName(leaving.name || leaving.email),
      createdByMemberId: owner.id,
    });
    // One statement: what was a root goes into the folder, everything changes owner. Names
    // cannot collide: the folder is new, and siblings below it all change owner together.
    const moved = await tx
      .update(storageNodes)
      .set({
        ownerMemberId: owner.id,
        parentId: sql`coalesce(${storageNodes.parentId}, ${folder.id})`,
        // Changing hands is not an edit: "Modified" stays what it was.
        updatedAt: sql`${storageNodes.updatedAt}`,
      })
      .where(owned)
      .returning({ id: storageNodes.id });
    return { status: "ok", moved: moved.length, folderId: folder.id, toMemberId: owner.id };
  });
}
