import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { storageNodes } from "../schema/storage.ts";
import {
  insertNode,
  lockTree,
  personalDrive,
  STORAGE_NAME_MAX_LENGTH,
  type Drive,
} from "./core.ts";
import { leaveTombstones, nextRevision } from "./revision.ts";
import { handOverTeamspaces } from "./teamspaces.ts";

export type StorageHandOverResult =
  | { status: "ok"; moved: number; folderId: string | null; toMemberId: string | null }
  | { status: "no_recipient" };

const isOwner = sql`'owner' = any(string_to_array(replace(${members.role}, ' ', ''), ','))`;

function folderName(person: string) {
  // oxlint-disable-next-line no-control-regex
  const clean = person.replaceAll(/[/\\\u0000-\u001f\u007f]/g, " ").trim();
  return `Files from ${clean || "a former member"}`.slice(0, STORAGE_NAME_MAX_LENGTH);
}

/**
 * Who receives what a leaving member held: `toMemberId` (whoever removed them) when that is
 * another member of the workspace, else its oldest other owner; null when there is none.
 */
export async function handOverRecipient(
  ex: Db,
  orgId: string,
  memberId: string,
  toMemberId?: string | null,
) {
  const others = and(eq(members.organizationId, orgId), ne(members.id, memberId));
  const [named] = toMemberId
    ? await ex
        .select({ id: members.id })
        .from(members)
        .where(and(others, eq(members.id, toMemberId)))
    : [];
  if (named) return named;
  const [owner] = await ex
    .select({ id: members.id })
    .from(members)
    .where(and(others, isOwner))
    .orderBy(asc(members.createdAt), asc(members.id))
    .limit(1);
  return owner ?? null;
}

/**
 * Moves everything in `memberId`'s My files, Trash included, into a new folder
 * `Files from <name>` at the root of the My files of `toMemberId` (whoever removed them), or of
 * the workspace's oldest other owner when that is absent, not in the workspace, or the member
 * themselves. By `owner_member_id`, in one transaction. Run again it finds nothing to move and
 * changes nothing, so it is safe before every removal. A teamspace the member alone owns gets the
 * same recipient as an owner, so it never loses its last one. Shared files, grants and links stay as
 * they are. The folder sits one level above what was a root, so a tree ends one deeper each
 * time it changes hands, past the depth cap if it was at it; the walks are not bound by the cap
 * (`MAX_WALK` in `core.ts`).
 */
export async function handOverMemberStorage(
  db: Db,
  input: { memberId: string; toMemberId?: string | null },
) {
  return db.transaction<StorageHandOverResult>(async (tx) => {
    const [leaving] = await tx
      .select({ orgId: members.organizationId, name: users.name, email: users.email })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.id, input.memberId));
    if (!leaving) {
      const result: StorageHandOverResult = {
        status: "ok",
        moved: 0,
        folderId: null,
        toMemberId: null,
      };
      return result;
    }
    await lockTree(tx, leaving.orgId);
    const owned = and(
      eq(storageNodes.orgId, leaving.orgId),
      eq(storageNodes.ownerMemberId, input.memberId),
    );
    const owner = await handOverRecipient(tx, leaving.orgId, input.memberId, input.toMemberId);
    if (owner) await handOverTeamspaces(tx, input.memberId, owner.id);

    const [first] = await tx
      .select({ id: storageNodes.id })
      .from(storageNodes)
      .where(owned)
      .limit(1);
    if (!owner) {
      const result: StorageHandOverResult = first
        ? { status: "no_recipient" }
        : { status: "ok", moved: 0, folderId: null, toMemberId: null };
      return result;
    }
    if (!first) {
      const result: StorageHandOverResult = {
        status: "ok",
        moved: 0,
        folderId: null,
        toMemberId: null,
      };
      return result;
    }

    const drive: Drive = personalDrive(leaving.orgId, owner.id);
    const folder = await insertNode(tx, {
      drive,
      parentId: null,
      kind: "folder",
      name: folderName(leaving.name || leaving.email),
      createdByMemberId: owner.id,
    });
    const revision = await nextRevision(tx, leaving.orgId);
    await leaveTombstones(tx, owned, revision);
    const moved = await tx
      .update(storageNodes)
      .set({
        ownerMemberId: owner.id,
        parentId: sql`coalesce(${storageNodes.parentId}, ${folder.id})`,
        revision,
        updatedAt: sql`${storageNodes.updatedAt}`,
      })
      .where(owned)
      .returning({ id: storageNodes.id });
    const result: StorageHandOverResult = {
      status: "ok",
      moved: moved.length,
      folderId: folder.id,
      toMemberId: owner.id,
    };
    return result;
  });
}
