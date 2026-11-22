import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import {
  storageNodes,
  storageTeamspaceMembers,
  storageTeamspaces,
  storageUploads,
} from "../schema/storage.ts";
import type { StorageMember } from "./access.ts";
import { cleanName, deleteSubtree, lockTree, teamspaceDrive, type Drive } from "./core.ts";

export type StorageTeamspaceRole = (typeof storageTeamspaceMembers.role.enumValues)[number];

/** A teamspace as a member of its workspace sees it. */
export interface StorageTeamspace {
  id: string;
  orgId: string;
  name: string;
  private: boolean;
  /** Its chosen glyph in the sidebar; null is the default. */
  icon: string | null;
  /** The viewer's role in it; null in an open teamspace they reach without being in it. */
  role: StorageTeamspaceRole | null;
  /** May rename it, make it open or private, change who is in it and delete it. */
  manage: boolean;
  createdAt: Date;
}

export interface StorageTeamspaceMember {
  memberId: string;
  role: StorageTeamspaceRole;
  name: string;
  email: string;
  image: string | null;
}

type NotFound = { status: "not_found" };
type Forbidden = { status: "forbidden" };
const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

export type TeamspaceResult =
  | { status: "ok"; teamspace: StorageTeamspace }
  | NotFound
  | Forbidden
  | { status: "invalid_name" };
export type TeamspaceMembersResult =
  | { status: "ok"; members: StorageTeamspaceMember[] }
  | NotFound
  | Forbidden
  | { status: "not_in_workspace" }
  | { status: "last_owner" };
export type DeleteTeamspaceResult =
  | { status: "ok"; r2Keys: string[] }
  | NotFound
  | Forbidden
  | { status: "not_empty" };

interface TeamspaceRow {
  id: string;
  orgId: string;
  name: string;
  private: boolean;
  icon: string | null;
  createdAt: Date;
}

/**
 * What `member` may do in a teamspace: reach it (open and not a freelancer, or in it) and manage
 * it (an owner of it, or of the workspace).
 */
export async function teamspaceReach(ex: Db, member: StorageMember, teamspaceId: string) {
  const [row] = await ex
    .select({
      id: storageTeamspaces.id,
      orgId: storageTeamspaces.orgId,
      name: storageTeamspaces.name,
      private: storageTeamspaces.private,
      icon: storageTeamspaces.icon,
      createdAt: storageTeamspaces.createdAt,
      role: storageTeamspaceMembers.role,
    })
    .from(storageTeamspaces)
    .leftJoin(
      storageTeamspaceMembers,
      and(
        eq(storageTeamspaceMembers.teamspaceId, storageTeamspaces.id),
        eq(storageTeamspaceMembers.memberId, member.id),
      ),
    )
    .where(and(eq(storageTeamspaces.id, teamspaceId), eq(storageTeamspaces.orgId, member.orgId)));
  if (!row) return null;
  const role = row.role ?? null;
  const reach = role !== null || member.admin || (!row.private && !member.freelancer);
  if (!reach) return null;
  return toTeamspace(row, role, member.admin || role === "owner");
}

const toTeamspace = (row: TeamspaceRow, role: StorageTeamspaceRole | null, manage: boolean) =>
  ({
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    private: row.private,
    icon: row.icon,
    role,
    manage,
    createdAt: row.createdAt,
  }) satisfies StorageTeamspace;

/** Every teamspace `member` reaches, by name. */
export async function reachableTeamspaces(ex: Db, member: StorageMember) {
  const rows = await ex
    .select({
      id: storageTeamspaces.id,
      orgId: storageTeamspaces.orgId,
      name: storageTeamspaces.name,
      private: storageTeamspaces.private,
      icon: storageTeamspaces.icon,
      createdAt: storageTeamspaces.createdAt,
      role: storageTeamspaceMembers.role,
    })
    .from(storageTeamspaces)
    .leftJoin(
      storageTeamspaceMembers,
      and(
        eq(storageTeamspaceMembers.teamspaceId, storageTeamspaces.id),
        eq(storageTeamspaceMembers.memberId, member.id),
      ),
    )
    .where(
      and(
        eq(storageTeamspaces.orgId, member.orgId),
        member.admin
          ? undefined
          : or(
              sql`${storageTeamspaceMembers.memberId} is not null`,
              member.freelancer ? sql`false` : eq(storageTeamspaces.private, false),
            ),
      ),
    )
    .orderBy(sql`lower(${storageTeamspaces.name})`, asc(storageTeamspaces.id));
  return rows.map((row) =>
    toTeamspace(row, row.role ?? null, member.admin || row.role === "owner"),
  );
}

/** The drives of the teamspaces `member` reaches. */
export async function teamspaceDrives(ex: Db, member: StorageMember) {
  return (await reachableTeamspaces(ex, member)).map((t) =>
    teamspaceDrive(t.orgId, t.id),
  ) satisfies Drive[];
}

/** Whether `memberId` is an owner of the teamspace. */
export async function ownsTeamspace(ex: Db, teamspaceId: string, memberId: string) {
  const [row] = await ex
    .select({ role: storageTeamspaceMembers.role })
    .from(storageTeamspaceMembers)
    .where(
      and(
        eq(storageTeamspaceMembers.teamspaceId, teamspaceId),
        eq(storageTeamspaceMembers.memberId, memberId),
      ),
    );
  return row?.role === "owner";
}

async function workspaceMembers(ex: Db, orgId: string, memberIds: string[]) {
  if (memberIds.length === 0) return [];
  const rows = await ex
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), inArray(members.id, memberIds)));
  return rows.map((row) => row.id);
}

async function listMembers(ex: Db, teamspaceId: string) {
  return (await ex
    .select({
      memberId: storageTeamspaceMembers.memberId,
      role: storageTeamspaceMembers.role,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(storageTeamspaceMembers)
    .innerJoin(members, eq(members.id, storageTeamspaceMembers.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(storageTeamspaceMembers.teamspaceId, teamspaceId))
    .orderBy(
      sql`${storageTeamspaceMembers.role} desc`,
      sql`lower(${users.name})`,
    )) satisfies StorageTeamspaceMember[];
}

export interface NewTeamspace {
  name: string;
  private?: boolean;
  /** Members of the workspace to add besides its maker, who owns it. Others are left out. */
  memberIds?: string[];
}

/**
 * Makes a teamspace in `member`'s workspace, owned by them, with `memberIds` in it. Trusted for
 * the member it is given: the caller has loaded them.
 */
export async function createTeamspace(ex: Db, member: StorageMember, input: NewTeamspace) {
  const name = cleanName(input.name);
  if (!name) return { status: "invalid_name" } satisfies TeamspaceResult;
  return ex.transaction<TeamspaceResult>(async (tx) => {
    const [row] = await tx
      .insert(storageTeamspaces)
      .values({
        orgId: member.orgId,
        name,
        private: input.private ?? false,
        createdByMemberId: member.id,
      })
      .returning();
    const others = await workspaceMembers(
      tx,
      member.orgId,
      (input.memberIds ?? []).filter((id) => id !== member.id),
    );
    await tx.insert(storageTeamspaceMembers).values([
      { teamspaceId: row!.id, orgId: member.orgId, memberId: member.id, role: "owner" as const },
      ...others.map((memberId) => ({
        teamspaceId: row!.id,
        orgId: member.orgId,
        memberId,
        role: "member" as const,
      })),
    ]);
    return { status: "ok", teamspace: toTeamspace(row!, "owner", true) };
  });
}

/** What a member does with teamspaces: list, make, manage. */
export function teamspaceOperations(db: Db, load: () => Promise<StorageMember | null>) {
  async function managed(ex: Db, teamspaceId: string) {
    const member = await load();
    if (!member) return NOT_FOUND;
    const found = await teamspaceReach(ex, member, teamspaceId);
    if (!found) return NOT_FOUND;
    if (!found.manage) return FORBIDDEN;
    return { member, teamspace: found };
  }

  return {
    async teamspaces() {
      const member = await load();
      return member ? reachableTeamspaces(db, member) : [];
    },

    async teamspace(teamspaceId: string) {
      const member = await load();
      return member ? teamspaceReach(db, member, teamspaceId) : null;
    },

    async createTeamspace(input: NewTeamspace) {
      const member = await load();
      if (!member) return NOT_FOUND satisfies TeamspaceResult;
      return createTeamspace(db, member, input);
    },

    async updateTeamspace(
      teamspaceId: string,
      patch: { name?: string; private?: boolean; icon?: string | null },
    ) {
      const name = patch.name === undefined ? undefined : cleanName(patch.name);
      if (name === null) return { status: "invalid_name" } satisfies TeamspaceResult;
      const found = await managed(db, teamspaceId);
      if ("status" in found) return found satisfies TeamspaceResult;
      const [row] = await db
        .update(storageTeamspaces)
        .set({
          ...(name === undefined ? {} : { name }),
          ...(patch.private === undefined ? {} : { private: patch.private }),
          ...(patch.icon === undefined ? {} : { icon: patch.icon }),
        })
        .where(eq(storageTeamspaces.id, teamspaceId))
        .returning();
      if (!row) return NOT_FOUND satisfies TeamspaceResult;
      return {
        status: "ok",
        teamspace: toTeamspace(row, found.teamspace.role, true),
      } satisfies TeamspaceResult;
    },

    async teamspaceMembers(teamspaceId: string) {
      const member = await load();
      if (!member || !(await teamspaceReach(db, member, teamspaceId))) {
        return NOT_FOUND satisfies TeamspaceMembersResult;
      }
      return {
        status: "ok",
        members: await listMembers(db, teamspaceId),
      } satisfies TeamspaceMembersResult;
    },

    putTeamspaceMember(teamspaceId: string, memberId: string, role: StorageTeamspaceRole) {
      return db.transaction<TeamspaceMembersResult>(async (tx) => {
        const found = await managed(tx, teamspaceId);
        if ("status" in found) return found;
        const [inWorkspace] = await workspaceMembers(tx, found.member.orgId, [memberId]);
        if (!inWorkspace) return { status: "not_in_workspace" };
        await lockMembers(tx, teamspaceId);
        if (role === "member" && (await soleOwner(tx, teamspaceId, memberId))) {
          return { status: "last_owner" };
        }
        await tx
          .insert(storageTeamspaceMembers)
          .values({ teamspaceId, orgId: found.member.orgId, memberId, role })
          .onConflictDoUpdate({
            target: [storageTeamspaceMembers.teamspaceId, storageTeamspaceMembers.memberId],
            set: { role },
          });
        return { status: "ok", members: await listMembers(tx, teamspaceId) };
      });
    },

    joinTeamspace(teamspaceId: string) {
      return db.transaction<TeamspaceMembersResult>(async (tx) => {
        const member = await load();
        if (!member) return NOT_FOUND;
        const found = await teamspaceReach(tx, member, teamspaceId);
        if (!found) return NOT_FOUND;
        await tx
          .insert(storageTeamspaceMembers)
          .values({ teamspaceId, orgId: member.orgId, memberId: member.id, role: "member" })
          .onConflictDoNothing();
        return { status: "ok", members: await listMembers(tx, teamspaceId) };
      });
    },

    removeTeamspaceMember(teamspaceId: string, memberId: string) {
      return db.transaction<TeamspaceMembersResult>(async (tx) => {
        const member = await load();
        if (!member) return NOT_FOUND;
        const found = await teamspaceReach(tx, member, teamspaceId);
        if (!found) return NOT_FOUND;
        if (!found.manage && memberId !== member.id) return FORBIDDEN;
        await lockMembers(tx, teamspaceId);
        if (await soleOwner(tx, teamspaceId, memberId)) return { status: "last_owner" };
        await tx
          .delete(storageTeamspaceMembers)
          .where(
            and(
              eq(storageTeamspaceMembers.teamspaceId, teamspaceId),
              eq(storageTeamspaceMembers.memberId, memberId),
            ),
          );
        return { status: "ok", members: await listMembers(tx, teamspaceId) };
      });
    },

    deleteTeamspace(teamspaceId: string) {
      return db.transaction<DeleteTeamspaceResult>(async (tx) => {
        const found = await managed(tx, teamspaceId);
        if ("status" in found) return found;
        const { orgId } = found.member;
        await lockTree(tx, orgId);
        const roots = await tx
          .select({ id: storageNodes.id, trashedAt: storageNodes.trashedAt })
          .from(storageNodes)
          .where(and(eq(storageNodes.teamspaceId, teamspaceId), isNull(storageNodes.parentId)));
        const uploading = await tx
          .select({ id: storageUploads.id })
          .from(storageUploads)
          .where(and(eq(storageUploads.teamspaceId, teamspaceId), isNull(storageUploads.nodeId)))
          .limit(1);
        if (uploading.length > 0 || roots.some((root) => root.trashedAt === null)) {
          return { status: "not_empty" };
        }
        const r2Keys: string[] = [];
        for (const root of roots) r2Keys.push(...(await deleteSubtree(tx, orgId, root.id)).r2Keys);
        await tx.delete(storageTeamspaces).where(eq(storageTeamspaces.id, teamspaceId));
        return { status: "ok", r2Keys };
      });
    },
  };
}

/**
 * Every member who reaches the teamspace: its members, the workspace's owners and admins, and,
 * when it is open, every member who is not a freelancer. For telling only them what happens in
 * it (who is editing a file, a live document's changes). Empty when there is no such teamspace.
 */
export async function teamspaceAudience(ex: Db, teamspaceId: string) {
  const rows = (await ex.execute(sql`
    select m.id from ${storageTeamspaces} t
      join ${members} m on m.organization_id = t.org_id
      left join ${storageTeamspaceMembers} tm
        on tm.teamspace_id = t.id and tm.member_id = m.id
    where t.id = ${teamspaceId} and (
      tm.member_id is not null
      or 'owner' = any(string_to_array(replace(m.role, ' ', ''), ','))
      or 'admin' = any(string_to_array(replace(m.role, ' ', ''), ','))
      or (not t.private
        and not 'freelancer' = any(string_to_array(replace(m.role, ' ', ''), ',')))
    )`)) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * Makes `toMemberId` an owner of every teamspace `memberId` alone owns, before `memberId` leaves
 * the workspace and their memberships go with them. Trusted, for the member hand-over.
 */
export async function handOverTeamspaces(tx: Db, memberId: string, toMemberId: string) {
  const owned = await tx
    .select({
      teamspaceId: storageTeamspaceMembers.teamspaceId,
      orgId: storageTeamspaceMembers.orgId,
    })
    .from(storageTeamspaceMembers)
    .where(
      and(
        eq(storageTeamspaceMembers.memberId, memberId),
        eq(storageTeamspaceMembers.role, "owner"),
      ),
    );
  for (const { teamspaceId, orgId } of owned) {
    if (!(await soleOwner(tx, teamspaceId, memberId))) continue;
    await tx
      .insert(storageTeamspaceMembers)
      .values({ teamspaceId, orgId, memberId: toMemberId, role: "owner" })
      .onConflictDoUpdate({
        target: [storageTeamspaceMembers.teamspaceId, storageTeamspaceMembers.memberId],
        set: { role: "owner" },
      });
  }
}

async function lockMembers(tx: Db, teamspaceId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`storage-teamspace:${teamspaceId}`}))`,
  );
}

async function soleOwner(tx: Db, teamspaceId: string, memberId: string) {
  const owners = await tx
    .select({ memberId: storageTeamspaceMembers.memberId })
    .from(storageTeamspaceMembers)
    .where(
      and(
        eq(storageTeamspaceMembers.teamspaceId, teamspaceId),
        eq(storageTeamspaceMembers.role, "owner"),
      ),
    );
  return owners.length === 1 && owners[0]!.memberId === memberId;
}
