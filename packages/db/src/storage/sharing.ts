// Sharing (ADR 0034 decision 4): people added by address, and the one link every shared node
// has. Only a member who can write the node shares it; every request checks the grant, so a
// change here is immediate.
import { normalizeAddress } from "@omni/mail-core/addresses";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { organizations } from "../schema/auth.ts";
import { storageGrants, storageNodes } from "../schema/storage.ts";
import type { Door } from "./access.ts";
import { inTrash, MAX_WALK, pageSize, toNode, type NodeRow, type StorageNode } from "./core.ts";
import { reach, type Forbidden, type NotFound } from "./tree.ts";

export type StorageLinkAccess = (typeof storageNodes.linkAccess.enumValues)[number];
export type StorageGrantRole = (typeof storageGrants.role.enumValues)[number];

export interface StoragePerson {
  email: string;
  role: StorageGrantRole;
  createdAt: Date;
}

export interface StorageSharing {
  nodeId: string;
  /** Null until the node is first shared. The link is `/s/<shareId>` in both modes. */
  shareId: string | null;
  linkAccess: StorageLinkAccess;
  people: StoragePerson[];
  /** People who reach the node through a folder above it. */
  inherited: (StoragePerson & { nodeId: string; nodeName: string })[];
}

export type SharingResult = { status: "ok"; sharing: StorageSharing } | NotFound | Forbidden;
export type PutGrantResult =
  /** `created` is false when the person was already there and only their role changed. */
  | { status: "ok"; created: boolean; shareId: string; person: StoragePerson; node: StorageNode }
  | NotFound
  | Forbidden
  | { status: "invalid_email" };
export type RemoveGrantResult = { status: "ok" } | NotFound | Forbidden;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

/** 22 base64url characters: 128 bits from the CSPRNG, derived from nothing. */
export function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function readSharing(ex: Db, chain: NodeRow[]): Promise<StorageSharing> {
  const node = chain[0]!;
  const names = new Map(chain.map((row) => [row.id, row.name]));
  const grants = await ex
    .select()
    .from(storageGrants)
    .where(inArray(storageGrants.nodeId, [...names.keys()]))
    .orderBy(storageGrants.createdAt, storageGrants.id);
  const person = (grant: (typeof grants)[number]): StoragePerson => ({
    email: grant.email,
    role: grant.role,
    createdAt: grant.createdAt,
  });
  return {
    nodeId: node.id,
    shareId: node.shareId,
    linkAccess: node.linkAccess,
    people: grants.filter((grant) => grant.nodeId === node.id).map(person),
    inherited: grants
      .filter((grant) => grant.nodeId !== node.id)
      .map((grant) => ({
        ...person(grant),
        nodeId: grant.nodeId,
        nodeName: names.get(grant.nodeId) ?? "",
      })),
  };
}

export function sharingOperations(db: Db, door: Door) {
  /** A live node the holder may share, or why not. */
  async function shareable(ex: Db, nodeId: string) {
    const found = await reach(ex, door, nodeId);
    if (!found || inTrash(found.chain)) return NOT_FOUND;
    if (!found.access.share) return FORBIDDEN;
    return { status: "ok" as const, ...found };
  }

  /** Changes the node's link under a row lock, so the first share makes exactly one `share_id`. */
  function changeLink(
    nodeId: string,
    change: (node: NodeRow) => { shareId: string; linkAccess?: StorageLinkAccess },
  ): Promise<SharingResult> {
    return db.transaction(async (tx): Promise<SharingResult> => {
      const found = await shareable(tx, nodeId);
      if (found.status !== "ok") return found;
      const [node] = await tx
        .select()
        .from(storageNodes)
        .where(eq(storageNodes.id, nodeId))
        .for("update");
      if (!node) return NOT_FOUND;
      const [row] = await tx
        .update(storageNodes)
        .set(change(node))
        .where(eq(storageNodes.id, nodeId))
        .returning();
      return { status: "ok", sharing: await readSharing(tx, [row!, ...found.chain.slice(1)]) };
    });
  }

  return {
    /** Who has access: the people on the node, those on folders above it, and its link. */
    async sharing(nodeId: string): Promise<SharingResult> {
      const found = await shareable(db, nodeId);
      if (found.status !== "ok") return found;
      return { status: "ok", sharing: await readSharing(db, found.chain) };
    },

    /** `anyone` opens the link to whoever holds it; `restricted` closes it again at once. */
    setLinkAccess(nodeId: string, linkAccess: StorageLinkAccess): Promise<SharingResult> {
      return changeLink(nodeId, (node) => ({
        shareId: node.shareId ?? newShareId(),
        linkAccess,
      }));
    },

    /** Gives the node a new link. The old one opens nothing from now on. */
    resetLink(nodeId: string): Promise<SharingResult> {
      return changeLink(nodeId, () => ({ shareId: newShareId() }));
    },

    /** Adds a person by address, or changes their role. */
    putGrant(nodeId: string, email: string, role: StorageGrantRole): Promise<PutGrantResult> {
      const address = normalizeAddress(email);
      if (!/^[^@\s]+@[^@\s]+$/.test(address)) return Promise.resolve({ status: "invalid_email" });
      return db.transaction(async (tx): Promise<PutGrantResult> => {
        const found = await shareable(tx, nodeId);
        if (found.status !== "ok") return found;
        const [node] = await tx
          .update(storageNodes)
          .set({ shareId: sql`coalesce(${storageNodes.shareId}, ${newShareId()})` })
          .where(eq(storageNodes.id, nodeId))
          .returning();
        if (!node?.shareId) return NOT_FOUND;
        const [grant] = await tx
          .insert(storageGrants)
          .values({
            orgId: node.orgId,
            nodeId,
            email: address,
            role,
            createdByMemberId: await door.actor(tx, node.orgId),
            // From this clock, not the database's: a cursor compares it at millisecond precision.
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
        return { status: "ok", created, shareId: node.shareId, person, node: toNode(node) };
      });
    },

    /** Removes a person. Their next request finds nothing. */
    async removeGrant(nodeId: string, email: string): Promise<RemoveGrantResult> {
      const found = await shareable(db, nodeId);
      if (found.status !== "ok") return found;
      const removed = await db
        .delete(storageGrants)
        .where(
          and(eq(storageGrants.nodeId, nodeId), eq(storageGrants.email, normalizeAddress(email))),
        )
        .returning({ id: storageGrants.id });
      return removed.length > 0 ? { status: "ok" } : NOT_FOUND;
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
  // Null when the node, or a folder above it, is in Trash: a grant opens nothing there.
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
      role: mine.role,
      sharedAt: mine.sharedAt,
      orgName: organizations.name,
    })
    .from(mine)
    .innerJoin(storageNodes, eq(storageNodes.id, mine.nodeId))
    .innerJoin(organizations, eq(organizations.id, storageNodes.orgId))
    .where(after)
    .orderBy(desc(mine.sharedAt), desc(mine.nodeId))
    .limit(limit + 1);
  const items: SharedWithMeItem[] = rows.slice(0, limit).map((row) => ({
    node: toNode(row.node),
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
