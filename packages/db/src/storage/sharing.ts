import { normalizeAddress } from "@omni/mail-core/addresses";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, organizations } from "../schema/auth.ts";
import {
  storageGrants,
  storageLocks,
  storageNodes,
  storagePolicies,
  storageShareEvents,
} from "../schema/storage.ts";
import { companyForAddress } from "../session-scopes.ts";
import { findEmailOwner } from "../sign-in-emails.ts";
import { loadMember, storagePolicyOf, type Door, type StoragePolicy } from "./access.ts";
import { inTrash, MAX_WALK, pageSize, toNode, type NodeRow, type StorageNode } from "./core.ts";
import { reach, type Forbidden, type NotFound } from "./tree.ts";

export type StorageLinkAccess = (typeof storageNodes.linkAccess.enumValues)[number];
export type StorageGrantRole = (typeof storageGrants.$inferSelect)["role"];

export interface StoragePerson {
  email: string;
  role: StorageGrantRole;
  createdAt: Date;
}

/** What a link does beyond who it opens for. None of it applies to members or grants. */
export interface StorageLink {
  /** After this the link opens for nobody. */
  expiresAt: Date | null;
  /** A visitor gives a password before the link opens. */
  hasPassword: boolean;
  /** False: view only, nothing downloads through the link. */
  downloads: boolean;
  /**
   * What anyone holding the link may do: view, or for a doc comment or edit it live. The
   * workspace's `linkEditing` policy caps what it opens as at Commenter.
   */
  role: StorageGrantRole;
}

export interface StorageSharing {
  nodeId: string;
  /** Null until the node is first shared. The link is `/s/<shareId>` in every mode. */
  shareId: string | null;
  linkAccess: StorageLinkAccess;
  link: StorageLink;
  /** The workspace's policy, so a client offers only what it allows. */
  policy: StoragePolicy;
  people: StoragePerson[];
  /** People who reach the node through a folder above it. */
  inherited: (StoragePerson & { nodeId: string; nodeName: string })[];
}

/** A change to a link's settings; a field left out keeps its value. */
export interface StorageLinkSettings {
  expiresAt?: Date | null;
  /** An `@omni/crypto` link password hash, or null to remove the password. */
  passwordHash?: string | null;
  downloads?: boolean;
  role?: StorageGrantRole;
}

type Refused = { status: "policy" };
export type SharingResult = { status: "ok"; sharing: StorageSharing } | NotFound | Forbidden;
export type ChangeLinkResult = SharingResult | Refused;
export type PutGrantResult =
  | { status: "ok"; created: boolean; shareId: string; person: StoragePerson; node: StorageNode }
  | NotFound
  | Forbidden
  | Refused
  | { status: "invalid_email" };
export type RemoveGrantResult = { status: "ok" } | NotFound | Forbidden;
export type PolicyResult = { status: "ok"; policy: StoragePolicy } | Forbidden | NotFound;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;
const POLICY = { status: "policy" } as const;

/** 22 base64url characters: 128 bits from the CSPRNG, derived from nothing. */
export function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export interface ShareEventInput {
  orgId: string;
  nodeId: string;
  kind: (typeof storageShareEvents.kind.enumValues)[number];
  via: "member" | "grant" | "link";
  actorMemberId?: string | null;
  actorUserId?: string | null;
  detail?: Record<string, unknown>;
}

/** Appends one row to the sharing audit trail. */
export async function recordShareEvent(ex: Db, event: ShareEventInput) {
  await ex.insert(storageShareEvents).values({ ...event, detail: event.detail ?? {} });
}

/** The node carrying `shareId` and its link's settings, live or not; null when no node has it. */
export async function linkOf(ex: Db, shareId: string) {
  const [row] = await ex.select().from(storageNodes).where(eq(storageNodes.shareId, shareId));
  return row ?? null;
}

async function insideCompany(ex: Db, orgId: string, address: string) {
  if ((await companyForAddress(ex, address)) === orgId) return true;
  const owner = await findEmailOwner(ex, address);
  if (!owner) return false;
  const [member] = await ex
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, owner.userId), eq(members.organizationId, orgId)));
  return member !== undefined;
}

/** What a link's owner reads about it: on a node, or on a file still uploading. */
export type SharedThing = Pick<
  NodeRow,
  | "id"
  | "orgId"
  | "name"
  | "shareId"
  | "linkAccess"
  | "linkExpiresAt"
  | "linkPasswordHash"
  | "linkDownloads"
  | "linkRole"
>;

/** `chain` runs from the shared thing up through the folders above it. */
export async function readSharing(ex: Db, chain: [SharedThing, ...NodeRow[]] | NodeRow[]) {
  const node = chain[0]!;
  const names = new Map(chain.map((row) => [row.id, row.name]));
  const grants = await ex
    .select()
    .from(storageGrants)
    .where(inArray(storageGrants.nodeId, [...names.keys()]))
    .orderBy(storageGrants.createdAt, storageGrants.id);
  const person = (grant: (typeof grants)[number]) =>
    ({
      email: grant.email,
      role: grant.role,
      createdAt: grant.createdAt,
    }) satisfies StoragePerson;
  return {
    nodeId: node.id,
    shareId: node.shareId,
    linkAccess: node.linkAccess,
    link: {
      expiresAt: node.linkExpiresAt,
      hasPassword: node.linkPasswordHash !== null,
      downloads: node.linkDownloads,
      role: node.linkRole,
    },
    policy: await storagePolicyOf(ex, node.orgId),
    people: grants.filter((grant) => grant.nodeId === node.id).map(person),
    inherited: grants
      .filter((grant) => grant.nodeId !== node.id)
      .map((grant) => ({
        ...person(grant),
        nodeId: grant.nodeId,
        nodeName: names.get(grant.nodeId) ?? "",
      })),
  } satisfies StorageSharing;
}

export function linkDetail(change: Partial<NodeRow>, reset: boolean) {
  return {
    ...(change.linkAccess ? { linkAccess: change.linkAccess } : {}),
    ...(change.linkExpiresAt !== undefined
      ? { expiresAt: change.linkExpiresAt?.toISOString() ?? null }
      : {}),
    ...(change.linkPasswordHash !== undefined
      ? { password: change.linkPasswordHash !== null }
      : {}),
    ...(change.linkDownloads !== undefined ? { downloads: change.linkDownloads } : {}),
    ...(change.linkRole !== undefined ? { role: change.linkRole } : {}),
    ...(reset ? { reset: true } : {}),
  };
}

export function sharingOperations(db: Db, door: Door) {
  async function shareable(ex: Db, nodeId: string, evenInTrash = false) {
    const found = await reach(ex, door, nodeId);
    if (!found || (!evenInTrash && inTrash(found.chain))) return NOT_FOUND;
    if (!found.access.share) return FORBIDDEN;
    return { status: "ok" as const, ...found };
  }

  function changeLink(
    nodeId: string,
    change: (node: NodeRow) => Partial<NodeRow> & { shareId: string },
    reset = false,
  ) {
    return db.transaction<ChangeLinkResult>(async (tx) => {
      const found = await shareable(tx, nodeId);
      if (found.status !== "ok") return found satisfies ChangeLinkResult;
      const [node] = await tx
        .select()
        .from(storageNodes)
        .where(eq(storageNodes.id, nodeId))
        .for("update");
      if (!node) return NOT_FOUND satisfies ChangeLinkResult;
      const set = change(node);
      const policy = await storagePolicyOf(tx, node.orgId);
      if (set.linkAccess === "anyone" && !policy.publicLinks) {
        return POLICY satisfies ChangeLinkResult;
      }
      if (set.linkRole === "editor" && !policy.linkEditing) {
        return POLICY satisfies ChangeLinkResult;
      }
      const [row] = await tx
        .update(storageNodes)
        .set(set)
        .where(eq(storageNodes.id, nodeId))
        .returning();
      await recordShareEvent(tx, {
        orgId: node.orgId,
        nodeId,
        kind: "link_changed",
        via: door.kind,
        actorMemberId: await door.actor(tx, node.orgId),
        detail: linkDetail(set, reset),
      });
      return {
        status: "ok",
        sharing: await readSharing(tx, [row!, ...found.chain.slice(1)]),
      } satisfies ChangeLinkResult;
    });
  }

  return {
    async sharing(nodeId: string) {
      const found = await shareable(db, nodeId);
      if (found.status !== "ok") return found satisfies SharingResult;
      return { status: "ok", sharing: await readSharing(db, found.chain) } satisfies SharingResult;
    },

    setLinkAccess(nodeId: string, linkAccess: StorageLinkAccess) {
      return changeLink(nodeId, (node) => ({
        shareId: node.shareId ?? newShareId(),
        linkAccess,
      })) satisfies Promise<ChangeLinkResult>;
    },

    setLinkSettings(nodeId: string, settings: StorageLinkSettings) {
      return changeLink(nodeId, (node) => ({
        shareId: node.shareId ?? newShareId(),
        ...(settings.expiresAt !== undefined ? { linkExpiresAt: settings.expiresAt } : {}),
        ...(settings.passwordHash !== undefined ? { linkPasswordHash: settings.passwordHash } : {}),
        ...(settings.downloads !== undefined ? { linkDownloads: settings.downloads } : {}),
        ...(settings.role !== undefined ? { linkRole: settings.role } : {}),
      })) satisfies Promise<ChangeLinkResult>;
    },

    resetLink(nodeId: string) {
      return changeLink(
        nodeId,
        () => ({ shareId: newShareId() }),
        true,
      ) satisfies Promise<ChangeLinkResult>;
    },

    putGrant(nodeId: string, email: string, role: StorageGrantRole) {
      const address = normalizeAddress(email);
      if (!/^[^@\s]+@[^@\s]+$/.test(address))
        return Promise.resolve({ status: "invalid_email" }) satisfies Promise<PutGrantResult>;
      return db.transaction<PutGrantResult>(async (tx) => {
        const found = await shareable(tx, nodeId);
        if (found.status !== "ok") {
          const result: PutGrantResult = found;
          return result;
        }
        const { orgId } = found.node;
        if (
          !(await storagePolicyOf(tx, orgId)).outsideSharing &&
          !(await insideCompany(tx, orgId, address))
        ) {
          const result: PutGrantResult = POLICY;
          return result;
        }
        const [node] = await tx
          .update(storageNodes)
          .set({ shareId: sql`coalesce(${storageNodes.shareId}, ${newShareId()})` })
          .where(eq(storageNodes.id, nodeId))
          .returning();
        if (!node?.shareId) {
          const result: PutGrantResult = NOT_FOUND;
          return result;
        }
        const actorMemberId = await door.actor(tx, node.orgId);
        const [grant] = await tx
          .insert(storageGrants)
          .values({
            orgId: node.orgId,
            nodeId,
            email: address,
            role,
            createdByMemberId: actorMemberId,
            createdAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [storageGrants.nodeId, storageGrants.email],
            set: { role },
          })
          .returning({
            email: storageGrants.email,
            role: storageGrants.role,
            createdAt: storageGrants.createdAt,
            created: sql<boolean>`(xmax = 0)`,
          });
        const { created, ...person } = grant!;
        await recordShareEvent(tx, {
          orgId: node.orgId,
          nodeId,
          kind: created ? "grant_added" : "grant_changed",
          via: door.kind,
          actorMemberId,
          detail: { email: address, role },
        });
        const result: PutGrantResult = {
          status: "ok",
          created,
          shareId: node.shareId,
          person,
          node: toNode({ ...node, lockedAt: found.node.lockedAt }),
        };
        return result;
      });
    },

    removeGrant(nodeId: string, email: string) {
      return db.transaction<RemoveGrantResult>(async (tx) => {
        const found = await shareable(tx, nodeId, true);
        if (found.status !== "ok") return found satisfies RemoveGrantResult;
        const address = normalizeAddress(email);
        const removed = await tx
          .delete(storageGrants)
          .where(and(eq(storageGrants.nodeId, nodeId), eq(storageGrants.email, address)))
          .returning({ id: storageGrants.id });
        if (removed.length === 0) return NOT_FOUND satisfies RemoveGrantResult;
        await recordShareEvent(tx, {
          orgId: found.node.orgId,
          nodeId,
          kind: "grant_removed",
          via: door.kind,
          actorMemberId: await door.actor(tx, found.node.orgId),
          detail: { email: address },
        });
        return { status: "ok" } satisfies RemoveGrantResult;
      });
    },
  };
}

/** The member's workspace sharing policy: everyone reads it, owners and admins change it. */
export function policyOperations(db: Db, memberId: string) {
  return {
    async policy() {
      const member = await loadMember(db, memberId);
      if (!member) return NOT_FOUND satisfies PolicyResult;
      return {
        status: "ok",
        policy: await storagePolicyOf(db, member.orgId),
      } satisfies PolicyResult;
    },

    async setPolicy(change: Partial<StoragePolicy>) {
      const member = await loadMember(db, memberId);
      if (!member) return NOT_FOUND satisfies PolicyResult;
      if (!member.admin) return FORBIDDEN satisfies PolicyResult;
      const [row] = await db
        .insert(storagePolicies)
        .values({ orgId: member.orgId, ...change, updatedByMemberId: member.id })
        .onConflictDoUpdate({
          target: storagePolicies.orgId,
          set: { ...change, updatedByMemberId: member.id, updatedAt: new Date() },
        })
        .returning({
          publicLinks: storagePolicies.publicLinks,
          outsideSharing: storagePolicies.outsideSharing,
          linkEditing: storagePolicies.linkEditing,
        });
      return { status: "ok", policy: row! } satisfies PolicyResult;
    },
  };
}

export interface SharedWithMeCursor {
  sharedAt: Date;
  id: string;
}

export interface SharedWithMeItem {
  node: StorageNode;
  role: StorageGrantRole;
  /** The node's link: where the person opens it. */
  shareId: string | null;
  orgName: string;
  sharedAt: Date;
}

/**
 * Every live node granted to one of `addresses`, newest grant first, across workspaces. A node
 * granted to two of the person's addresses is listed once, with the stronger role.
 */
export async function listSharedWith(
  db: Db,
  addresses: string[],
  page: { cursor?: SharedWithMeCursor | null; limit?: number } = {},
) {
  if (addresses.length === 0) return { items: [] as SharedWithMeItem[], nextCursor: null };
  const limit = pageSize(page.limit);
  const live = sql`not exists (
    with recursive up(parent_id, trashed_at, depth) as (
      select n.parent_id, n.trashed_at, 0 from ${storageNodes} n where n.id = ${storageGrants.nodeId}
      union all
      select p.parent_id, p.trashed_at, up.depth + 1 from ${storageNodes} p
        join up on p.id = up.parent_id where up.depth < ${MAX_WALK}
    ) select 1 from up where trashed_at is not null)`;
  const mine = db
    .select({
      nodeId: storageGrants.nodeId,
      role: sql<StorageGrantRole>`max(${storageGrants.role})`.as("role"),
      sharedAt: sql<Date>`max(${storageGrants.createdAt})`
        .mapWith(storageGrants.createdAt)
        .as("shared_at"),
    })
    .from(storageGrants)
    .where(and(inArray(storageGrants.email, addresses), live))
    .groupBy(storageGrants.nodeId)
    .as("mine");
  const after = page.cursor
    ? sql`(${mine.sharedAt}, ${mine.nodeId}) < (${page.cursor.sharedAt.toISOString()}::timestamptz, ${page.cursor.id})`
    : undefined;
  const rows = await db
    .select({
      node: storageNodes,
      lockedAt: storageLocks.lockedAt,
      role: mine.role,
      sharedAt: mine.sharedAt,
      orgName: organizations.name,
    })
    .from(mine)
    .innerJoin(storageNodes, eq(storageNodes.id, mine.nodeId))
    .leftJoin(storageLocks, eq(storageLocks.nodeId, storageNodes.id))
    .innerJoin(organizations, eq(organizations.id, storageNodes.orgId))
    .where(after)
    .orderBy(desc(mine.sharedAt), desc(mine.nodeId))
    .limit(limit + 1);
  const items: SharedWithMeItem[] = rows.slice(0, limit).map((row) => ({
    node: toNode({ ...row.node, lockedAt: row.lockedAt }),
    role: row.role,
    shareId: row.node.shareId,
    orgName: row.orgName,
    sharedAt: row.sharedAt,
  }));
  const last = items.at(-1);
  const nextCursor: SharedWithMeCursor | null =
    rows.length > limit && last ? { sharedAt: last.sharedAt, id: last.node.id } : null;
  return { items, nextCursor };
}
