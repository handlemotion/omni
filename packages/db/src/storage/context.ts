import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, organizations } from "../schema/auth.ts";
import { personalSpaces } from "../schema/identity.ts";
import { storageGrants, storageNodes, storageTeamspaces, storageTexts } from "../schema/storage.ts";
import {
  grantAddresses,
  grantDoor,
  loadMember,
  memberDoor,
  type Door,
  type StorageRole,
} from "./access.ts";
import {
  inTrash,
  MAX_WALK,
  orgOfNode,
  toNode,
  type Drive,
  type StorageListCursor,
  type StorageNode,
  type StorageSpace,
} from "./core.ts";
import { inDrives, likeEscaped } from "./find.ts";
import { listSharedWith } from "./sharing.ts";
import { reachableTeamspaces } from "./teamspaces.ts";
import type { StorageTextStatus } from "./texts.ts";
import { reach, treeOperations, type ListResult } from "./tree.ts";

/** Search answers this many at most. */
export const STORAGE_CONTEXT_SEARCH_MAX = 50;
const SNIPPET_SOURCE = 50_000;
const EXCERPT_CHARS = 1_500;

/** A workspace the person reaches Drive in as a member. */
export interface ContextWorkspace {
  id: string;
  name: string;
  slug: string;
  memberId: string;
  /** A Personal space: My files only, no Shared. */
  personal: boolean;
}

/**
 * A node as an agent sees it: where it is (the workspace, the drive, the folders above it as the
 * door shows them) and how the person reaches it. `via: "grant"` is something shared with them
 * from a drive they are not a member of; `shareId` is then the link the web app opens it at.
 */
export interface ContextNode {
  node: StorageNode;
  role: StorageRole;
  via: "member" | "grant";
  workspace: { id: string; name: string; slug: string };
  path: { id: string; name: string }[];
  shareId: string | null;
}

export interface ContextHit extends ContextNode {
  /** Matching words, marked `**like this**`; empty when only the name matched. */
  snippet: string;
}

/** What a relevance judge reads about a file before anyone opens it. */
export interface ContextFile {
  id: string;
  name: string;
  /** "Acme · Shared", "Acme · My files", or "Shared with you". */
  location: string;
  modifiedAt: Date;
  contentVersion: number;
  /** The start of its current text; empty when it has none. */
  excerpt: string;
}

export interface ContextText {
  status: StorageTextStatus | "pending";
  text: string;
  truncated: boolean;
}

export type ContextRead = ContextNode & { content: ContextText | null };

type Opened = ContextNode & { door: Door };

/**
 * Drive for a person's agent, read only, across every workspace the session reaches: their My
 * files and their companies' Shared as a member, and what was shared with their addresses. Each
 * node is opened through the same member and grant doors the app uses, so nothing is reachable
 * here that the person cannot open in Drive, and nothing in Trash. `wordMatches` and
 * `recentFiles` describe candidates (best word matches; most recently changed files with text)
 * for a relevance judge before any door opens; `reveal` then opens the chosen ids in order.
 */
export function contextOperations(db: Db, userId: string, scopeOrgId?: string | null) {
  const workspaces = async (only?: string) => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        memberId: members.id,
        personal: sql<boolean>`exists (select 1 from ${personalSpaces} where ${personalSpaces.orgId} = ${organizations.id})`,
      })
      .from(members)
      .innerJoin(organizations, eq(organizations.id, members.organizationId))
      .where(
        and(
          eq(members.userId, userId),
          scopeOrgId ? eq(members.organizationId, scopeOrgId) : undefined,
          only ? eq(members.organizationId, only) : undefined,
        ),
      )
      .orderBy(organizations.name, organizations.id);
    return rows satisfies ContextWorkspace[];
  };

  const workspaceOf = async (orgId: string) => {
    const [row] = await db
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return row ?? null;
  };

  const shareIdOf = async (nodeId: string) => {
    const [row] = await db
      .select({ shareId: storageNodes.shareId })
      .from(storageNodes)
      .where(eq(storageNodes.id, nodeId));
    return row?.shareId ?? null;
  };

  const open: (nodeId: string) => Promise<Opened | null> = async (nodeId) => {
    const orgId = await orgOfNode(db, nodeId);
    if (!orgId) return null;
    const [member] = await workspaces(orgId);
    const doors: { door: Door; via: "member" | "grant" }[] = [
      ...(member ? [{ door: memberDoor(member.memberId), via: "member" as const }] : []),
      { door: grantDoor(userId, scopeOrgId), via: "grant" },
    ];
    for (const { door, via } of doors) {
      const found = await reach(db, door, nodeId);
      if (!found || inTrash(found.chain)) continue;
      const path = found.chain
        .slice(0, found.access.top + 1)
        .toReversed()
        .map((row) => ({ id: row.id, name: row.name }));
      const workspace = member ?? (await workspaceOf(orgId));
      if (!workspace) return null;
      return {
        node: toNode(found.node),
        role: found.access.role,
        via,
        workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
        path,
        shareId: via === "grant" ? await shareIdOf(path[0]!.id) : null,
        door,
      };
    }
    return null;
  };

  const grantedIn = (addresses: string[], only?: string) => sql`${storageNodes.id} in (
    with recursive granted(id, depth) as (
      select n.id, 0 from ${storageNodes} n
        join ${storageGrants} g on g.node_id = n.id
        where g.email in (${sql.join(
          addresses.map((address) => sql`${address}`),
          sql`, `,
        )}) and n.trashed_at is null ${only ? sql`and n.org_id = ${only}` : sql``}
      union all
      select c.id, granted.depth + 1 from ${storageNodes} c
        join granted on c.parent_id = granted.id
        where c.trashed_at is null and not c.team_only and granted.depth < ${MAX_WALK}
    ) select id from granted)`;

  const drivesOf = async (reached: { memberId: string }[]) =>
    (await Promise.all(reached.map((w) => memberDoor(w.memberId).drives(db)))).flat();
  const driveKey = (drive: Pick<Drive, "orgId" | "space" | "ownerMemberId" | "teamspaceId">) =>
    `${drive.orgId}:${drive.space}:${drive.ownerMemberId ?? ""}:${drive.teamspaceId ?? ""}`;

  async function scope(only?: string) {
    const drives: Drive[] = await drivesOf(await workspaces(only));
    const addresses = await grantAddresses(db, userId, scopeOrgId);
    const within = [
      ...(drives.length
        ? [sql`(${inDrives(drives, "storage_nodes")} and ${storageNodes.trashedAt} is null)`]
        : []),
      ...(addresses.length ? [grantedIn(addresses, only)] : []),
    ];
    return within.length
      ? sql`(not ${storageNodes.attached} and (${sql.join(within, sql` or `)}))`
      : null;
  }

  async function candidates(query: string, limit: number, only?: string) {
    const within = await scope(only);
    if (!within) return [];
    const words = sql`websearch_to_tsquery('simple', ${query})`;
    const nameWords = sql`to_tsvector('simple', regexp_replace(${storageNodes.name}, '[._-]+', ' ', 'g'))`;
    const named = sql`(${storageNodes.name} ilike ${`%${likeEscaped(query)}%`} or ${nameWords} @@ ${words})`;
    return db
      .select({ id: storageNodes.id })
      .from(storageNodes)
      .leftJoin(
        storageTexts,
        and(
          eq(storageTexts.nodeId, storageNodes.id),
          eq(storageTexts.contentVersion, storageNodes.contentVersion),
        ),
      )
      .where(and(within, sql`(${named} or ${storageTexts.searchVector} @@ ${words})`))
      .orderBy(
        sql`${named} desc`,
        sql`coalesce(ts_rank(${storageTexts.searchVector}, ${words}), 0) desc`,
        sql`${storageNodes.updatedAt} desc`,
        storageNodes.id,
      )
      .limit(limit);
  }

  const noTrashAbove = sql`not exists (
    with recursive up(parent_id, trashed, depth) as (
      select p.parent_id, p.trashed_at is not null, 1 from ${storageNodes} p
        where p.id = ${storageNodes.parentId}
      union all
      select p.parent_id, p.trashed_at is not null, up.depth + 1 from ${storageNodes} p
        join up on p.id = up.parent_id
        where not up.trashed and up.depth < ${MAX_WALK}
    ) select 1 from up where trashed)`;

  async function facts(ids: string[]) {
    if (!ids.length) return [] satisfies ContextFile[];
    const reachable = new Set((await drivesOf(await workspaces())).map(driveKey));
    const rows = await db
      .select({
        id: storageNodes.id,
        name: storageNodes.name,
        orgId: storageNodes.orgId,
        orgName: organizations.name,
        space: storageNodes.space,
        ownerMemberId: storageNodes.ownerMemberId,
        teamspaceId: storageNodes.teamspaceId,
        teamspaceName: storageTeamspaces.name,
        contentVersion: storageNodes.contentVersion,
        modifiedAt: storageNodes.updatedAt,
        excerpt: sql<string>`coalesce(left(${storageTexts.text}, ${EXCERPT_CHARS}), '')`,
      })
      .from(storageNodes)
      .innerJoin(organizations, eq(organizations.id, storageNodes.orgId))
      .leftJoin(storageTeamspaces, eq(storageTeamspaces.id, storageNodes.teamspaceId))
      .leftJoin(
        storageTexts,
        and(
          eq(storageTexts.nodeId, storageNodes.id),
          eq(storageTexts.contentVersion, storageNodes.contentVersion),
        ),
      )
      .where(and(inArray(storageNodes.id, ids), noTrashAbove));
    const byId = new Map(
      rows.map((row) => {
        const mine = reachable.has(driveKey(row));
        const drive =
          row.space === "shared"
            ? "Shared"
            : row.space === "teamspace"
              ? (row.teamspaceName ?? "Teamspace")
              : "My files";
        return [
          row.id,
          {
            id: row.id,
            name: row.name,
            location: mine ? `${row.orgName} · ${drive}` : "Shared with you",
            modifiedAt: row.modifiedAt,
            contentVersion: row.contentVersion ?? 0,
            excerpt: row.excerpt,
          } satisfies ContextFile,
        ];
      }),
    );
    return ids.map((id) => byId.get(id)).filter((row): row is ContextFile => !!row);
  }

  async function recent(limit: number, only?: string) {
    const within = await scope(only);
    if (!within) return [];
    return db
      .select({ id: storageNodes.id })
      .from(storageNodes)
      .innerJoin(
        storageTexts,
        and(
          eq(storageTexts.nodeId, storageNodes.id),
          eq(storageTexts.contentVersion, storageNodes.contentVersion),
        ),
      )
      .where(and(within, eq(storageTexts.status, "ok")))
      .orderBy(sql`${storageNodes.updatedAt} desc`, storageNodes.id)
      .limit(limit);
  }

  async function snippets(ids: string[], query: string) {
    if (!ids.length) return new Map<string, string>();
    const rows = await db
      .select({
        nodeId: storageTexts.nodeId,
        snippet: sql<string>`ts_headline('simple', left(${storageTexts.text}, ${SNIPPET_SOURCE}), websearch_to_tsquery('simple', ${query}), 'StartSel=**, StopSel=**, MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" … "')`,
        matched: sql<boolean>`${storageTexts.searchVector} @@ websearch_to_tsquery('simple', ${query})`,
      })
      .from(storageTexts)
      .innerJoin(
        storageNodes,
        and(
          eq(storageNodes.id, storageTexts.nodeId),
          eq(storageNodes.contentVersion, storageTexts.contentVersion),
        ),
      )
      .where(inArray(storageTexts.nodeId, ids));
    return new Map(rows.filter((row) => row.matched).map((row) => [row.nodeId, row.snippet]));
  }

  const strip = ({ door: _door, ...node }: Opened) => node satisfies ContextNode;

  async function reveal(ids: string[], query: string, limit: number) {
    const opened: Opened[] = [];
    for (const id of ids) {
      if (opened.length >= limit) break;
      const node = await open(id);
      if (node) opened.push(node);
    }
    const marked = await snippets(
      opened.map((hit) => hit.node.id),
      query,
    );
    return opened.map((hit) => ({
      ...strip(hit),
      snippet: marked.get(hit.node.id) ?? "",
    })) satisfies ContextHit[];
  }

  return {
    workspaces: () => workspaces(),

    async search(query: string, options: { limit: number; workspace?: string }) {
      const text = query.trim();
      if (!text) return [] satisfies ContextHit[];
      const limit = Math.min(options.limit, STORAGE_CONTEXT_SEARCH_MAX);
      const found = await candidates(text, limit * 3, options.workspace);
      return reveal(
        found.map((row) => row.id),
        text,
        limit,
      );
    },

    async wordMatches(query: string, options: { limit: number; workspace?: string }) {
      const text = query.trim();
      if (!text) return [] satisfies ContextFile[];
      return facts((await candidates(text, options.limit, options.workspace)).map((r) => r.id));
    },

    async recentFiles(options: { limit: number; workspace?: string }) {
      return facts((await recent(options.limit, options.workspace)).map((r) => r.id));
    },

    reveal: (ids: string[], query: string, limit: number) =>
      reveal(ids, query.trim(), Math.min(limit, STORAGE_CONTEXT_SEARCH_MAX)),

    async read(nodeIds: string[]) {
      const opened = (await Promise.all(nodeIds.map((id) => open(id)))).filter(
        (node): node is Opened => node !== null,
      );
      const files = opened.filter((hit) => hit.node.kind === "file").map((hit) => hit.node.id);
      const texts = files.length
        ? await db
            .select({
              nodeId: storageTexts.nodeId,
              contentVersion: storageTexts.contentVersion,
              status: storageTexts.status,
              text: storageTexts.text,
              truncated: storageTexts.truncated,
            })
            .from(storageTexts)
            .where(inArray(storageTexts.nodeId, files))
        : [];
      const byId = new Map(texts.map((row) => [row.nodeId, row]));
      return opened.map((hit) => {
        if (hit.node.kind !== "file") return { ...strip(hit), content: null };
        const row = byId.get(hit.node.id);
        const current = row && row.contentVersion === hit.node.contentVersion;
        return {
          ...strip(hit),
          content: current
            ? { status: row.status, text: row.text, truncated: row.truncated }
            : { status: "pending" as const, text: "", truncated: false },
        };
      }) satisfies ContextRead[];
    },

    async listFolder(
      folderId: string,
      page: { cursor?: StorageListCursor | null; limit?: number },
    ) {
      const folder = await open(folderId);
      if (!folder || folder.node.kind !== "folder") return null;
      const listed: ListResult = await treeOperations(db, folder.door).list(
        { parentId: folderId },
        page,
      );
      if (listed.status !== "ok") return null;
      return { folder: strip(folder), nodes: listed.nodes, nextCursor: listed.nextCursor };
    },

    async listDrive(
      orgId: string,
      drive: Exclude<StorageSpace, "teamspace"> | { teamspaceId: string },
      page: { cursor?: StorageListCursor | null; limit?: number },
    ) {
      const [workspace] = await workspaces(orgId);
      if (!workspace) return null;
      const place = typeof drive === "object" ? drive : { space: drive };
      const listed = await treeOperations(db, memberDoor(workspace.memberId)).list(place, page);
      if (listed.status !== "ok") return null;
      return { workspace, nodes: listed.nodes, nextCursor: listed.nextCursor };
    },

    async teamspaces() {
      const reached = await workspaces();
      const lists = await Promise.all(
        reached.map(async (w) => {
          const member = await loadMember(db, w.memberId);
          return member ? reachableTeamspaces(db, member) : [];
        }),
      );
      return lists.flat().map((t) => ({ id: t.id, orgId: t.orgId, name: t.name }));
    },

    async sharedWithMe(limit: number) {
      const addresses = await grantAddresses(db, userId, scopeOrgId);
      return (await listSharedWith(db, addresses, { limit })).items;
    },
  };
}

export type StorageContext = ReturnType<typeof contextOperations>;
