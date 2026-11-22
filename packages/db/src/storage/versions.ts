import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import {
  storageContents,
  storageNodes,
  storageVersions,
  type StorageCoauthor,
  type StorageGuest,
} from "../schema/storage.ts";
import { editsContent, type Door } from "./access.ts";
import {
  addUsage,
  chainOf,
  inTrash,
  lockTree,
  lockUsage,
  orgOfNode,
  toNode,
  type NodeRow,
  type StorageNode,
} from "./core.ts";
import { nextRevision } from "./revision.ts";
import { LOCKED, reach, type FileResult, type Locked, type NodeResult } from "./tree.ts";

/** A replaced version is kept this long, then deleted for good. */
export const STORAGE_VERSION_DAYS = 30;

/**
 * Saves are one editing session, and the file keeps one version for it, while the same member
 * saves in the app with no more than `STORAGE_SESSION_IDLE_MS` between saves, for up to
 * `STORAGE_SESSION_MS` from the session's first save. A doc saves itself seconds after typing
 * stops; without sessions an hour of writing left hundreds of versions.
 */
export const STORAGE_SESSION_IDLE_MS = 5 * 60_000;
export const STORAGE_SESSION_MS = 15 * 60_000;

/** A superseded autosave stays restorable (by id) this long, then is purged. */
export const STORAGE_SUPERSEDED_MS = 24 * 3_600_000;

/**
 * Content a file has or had. `writtenByName` is null once its writer is gone; `writtenByAgent`
 * names the agent that wrote it for them, null when they wrote it in the app.
 */
export interface StorageContent {
  size: number;
  mimeType: string | null;
  writtenAt: Date;
  writtenByName: string | null;
  writtenByAgent: string | null;
  /** Written by a guest through a link (`writtenByName` is their name), not by a member. */
  writtenByGuest: boolean;
  /** Outsiders whose typing it holds, beside its writer. */
  coauthors: StorageCoauthor[];
  /** The file's `contentVersion` while this was (or is) its content; null for old versions. */
  contentVersion: number | null;
}

export interface StorageVersion extends StorageContent {
  id: string;
  replacedAt: Date;
}

export type VersionsResult =
  | { status: "ok"; node: StorageNode; current: StorageContent; versions: StorageVersion[] }
  | { status: "not_found" }
  | { status: "forbidden" };
export type RestoreVersionResult = NodeResult | Locked;
/**
 * A checked save whose base is no longer the file's content: `contentVersion` is the file's now,
 * so the editor can fetch it, merge, and save again on top of it.
 */
export type StaleContent = { status: "version_conflict"; contentVersion: number };

/** Refuses a save based on another content than the file's current one. Null: unchecked. */
export const staleFor = (node: NodeRow, base: number | null | undefined) =>
  (base !== null && base !== undefined && node.contentVersion !== base
    ? { status: "version_conflict", contentVersion: node.contentVersion }
    : null) satisfies StaleContent | null;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;

async function currentWriter(ex: Db, node: NodeRow) {
  const [row] = await ex
    .select({
      writtenByMemberId: storageContents.writtenByMemberId,
      writtenAt: storageContents.writtenAt,
      writtenByAgent: storageContents.writtenByAgent,
      writtenByGuest: storageContents.writtenByGuest,
      coauthors: storageContents.coauthors,
      sessionEnded: storageContents.sessionEnded,
    })
    .from(storageContents)
    .where(eq(storageContents.nodeId, node.id));
  return {
    sessionEnded: row?.sessionEnded ?? false,
    writer: row
      ? {
          writtenByMemberId: row.writtenByMemberId,
          writtenAt: row.writtenAt,
          writtenByAgent: row.writtenByAgent,
          writtenByGuest: row.writtenByGuest,
          coauthors: row.coauthors,
        }
      : {
          writtenByMemberId: node.createdByMemberId,
          writtenAt: node.createdAt,
          writtenByAgent: null,
          writtenByGuest: null,
          coauthors: null,
        },
    replaced: !!row,
  };
}

/** Who a save is from: a member, or a guest through a link (with no member). */
export type StorageWriter =
  | { memberId: string; guest?: null }
  | { memberId: null; guest: StorageGuest };

const sameWriter = (
  writer: { writtenByMemberId: string | null; writtenByGuest: StorageGuest | null },
  save: StorageWriter,
) =>
  save.guest
    ? !writer.writtenByMemberId && writer.writtenByGuest?.id === save.guest.id
    : !writer.writtenByGuest && writer.writtenByMemberId === save.memberId;

/** Both lists, each outsider once (the later name wins); null when both are empty. */
export function mergeCoauthors(
  a: StorageCoauthor[] | null | undefined,
  b: StorageCoauthor[] | null | undefined,
) {
  const byKey = new Map<string, StorageCoauthor>();
  for (const one of [...(a ?? []), ...(b ?? [])]) byKey.set(`${one.kind}:${one.id}`, one);
  return byKey.size > 0 ? [...byKey.values()] : null;
}

async function continuesSession(
  ex: Db,
  node: NodeRow,
  current: Awaited<ReturnType<typeof currentWriter>>,
  save: { writer: StorageWriter; agent: string | null; at: Date; mimeType: string | null },
) {
  const { writer } = current;
  if (!current.replaced || current.sessionEnded || save.agent || writer.writtenByAgent)
    return false;
  if (save.mimeType !== node.mimeType) return false;
  if (!sameWriter(writer, save.writer)) return false;
  if (save.at.getTime() - writer.writtenAt.getTime() > STORAGE_SESSION_IDLE_MS) return false;
  const [kept] = await ex
    .select({ replacedAt: storageVersions.replacedAt })
    .from(storageVersions)
    .where(and(eq(storageVersions.nodeId, node.id), isNull(storageVersions.supersededAt)))
    .orderBy(desc(storageVersions.replacedAt), desc(storageVersions.id))
    .limit(1);
  return !!kept && save.at.getTime() - kept.replacedAt.getTime() <= STORAGE_SESSION_MS;
}

async function setContent(
  tx: Db,
  node: NodeRow,
  content: {
    size: number;
    mimeType: string | null;
    r2Key: string;
    sha256: string | null;
    writtenByMemberId: string | null;
    writtenAt: Date;
    writtenByAgent: string | null;
    writtenByGuest?: StorageGuest | null;
    coauthors?: StorageCoauthor[] | null;
  },
) {
  const { writtenByMemberId, writtenAt, writtenByAgent } = content;
  const writtenByGuest = content.writtenByGuest ?? null;
  const coauthors = content.coauthors ?? null;
  const written = { writtenByMemberId, writtenAt, writtenByAgent, writtenByGuest, coauthors };
  await tx
    .insert(storageContents)
    .values({ nodeId: node.id, orgId: node.orgId, ...written })
    .onConflictDoUpdate({
      target: storageContents.nodeId,
      set: { ...written, sessionEnded: false },
    });
  const revision = await nextRevision(tx, node.orgId);
  const [row] = await tx
    .update(storageNodes)
    .set({
      size: content.size,
      mimeType: content.mimeType,
      r2Key: content.r2Key,
      contentSha256: content.sha256,
      contentVersion: sql`${storageNodes.contentVersion} + 1`,
      revision,
    })
    .where(eq(storageNodes.id, node.id))
    .returning();
  return row ? ({ status: "ok", node: toNode(row) } as const) : NOT_FOUND;
}

async function nameOf(ex: Db, memberId: string | null) {
  if (!memberId) return null;
  const [row] = await ex
    .select({ name: users.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(members.id, memberId));
  return row?.name ?? null;
}

async function editable(ex: Db, door: Door, nodeId: string) {
  const found = await reach(ex, door, nodeId);
  if (!found || found.node.kind !== "file" || !found.node.r2Key || inTrash(found.chain)) {
    return NOT_FOUND;
  }
  if (!editsContent(found.access)) return FORBIDDEN;
  return { status: "ok", node: found.node, r2Key: found.node.r2Key } as const;
}

async function keepCurrent(
  tx: Db,
  node: NodeRow,
  r2Key: string,
  current: Awaited<ReturnType<typeof currentWriter>>,
  supersededAt: Date | null = null,
) {
  await tx.insert(storageVersions).values({
    orgId: node.orgId,
    nodeId: node.id,
    size: node.size,
    mimeType: node.mimeType,
    r2Key,
    contentVersion: node.contentVersion,
    ...current.writer,
    supersededAt,
  });
}

/**
 * Makes an uploaded object the file's content and keeps what it replaces: as a version, or as a
 * superseded autosave when the save continues the session that wrote it. Call with the tree
 * locked. The caller counts the new bytes: the replaced ones stay stored, as a version.
 */
export const replaceContent: (
  tx: Db,
  door: Door,
  nodeId: string,
  content: {
    size: number;
    mimeType: string | null;
    r2Key: string;
    sha256: string | null;
    memberId: string;
    agent?: string | null;
  },
  base?: number | null,
) => Promise<NodeResult | Locked | StaleContent> = async (
  tx,
  door,
  nodeId,
  content,
  base = null,
) => {
  const found = await editable(tx, door, nodeId);
  if (found.status !== "ok") return found;
  if (found.node.lockedAt) return LOCKED;
  const stale = staleFor(found.node, base);
  if (stale) return stale;
  const at = new Date();
  const agent = content.agent ?? null;
  const current = await currentWriter(tx, found.node);
  const writer: StorageWriter = { memberId: content.memberId };
  const save = { writer, agent, at, mimeType: content.mimeType };
  const superseded = (await continuesSession(tx, found.node, current, save)) ? at : null;
  await keepCurrent(tx, found.node, found.r2Key, current, superseded);
  return setContent(tx, found.node, {
    ...content,
    writtenByMemberId: content.memberId,
    writtenAt: at,
    writtenByAgent: agent,
    coauthors: superseded ? current.writer.coauthors : null,
  });
};

export type FoldContentResult =
  | NodeResult
  | Locked
  | StaleContent
  | { status: "full"; usedBytes: number; limitBytes: number };

/**
 * The Worker's save of a doc's live document that outsiders typed in (`docs/spec/live-sharing.md`):
 * `r2Key` already holds the text. Not through a door: the realtime object checked each record's
 * sender as it took it, and this saves the document they wrote. Keeps what it replaces as
 * uploads do, sessions included, and counts the bytes. Idempotent with `base`: a second run
 * finds the file moved on and is refused `version_conflict`.
 */
export function foldContent(
  db: Db,
  input: {
    orgId: string;
    nodeId: string;
    base: number;
    size: number;
    mimeType: string | null;
    r2Key: string;
    writer: StorageWriter;
    coauthors: StorageCoauthor[] | null;
    limitBytes: number | null;
  },
) {
  return db.transaction<FoldContentResult>(async (tx) => {
    await lockTree(tx, input.orgId);
    const usedBytes = await lockUsage(tx, input.orgId);
    const chain = await chainOf(tx, input.nodeId);
    const node = chain?.[0];
    if (!chain || !node || node.orgId !== input.orgId || node.kind !== "file" || !node.r2Key) {
      return NOT_FOUND;
    }
    if (inTrash(chain)) return NOT_FOUND;
    if (node.lockedAt) return LOCKED;
    const stale = staleFor(node, input.base);
    if (stale) return stale;
    if (input.limitBytes !== null && usedBytes + input.size > input.limitBytes) {
      return { status: "full", usedBytes, limitBytes: input.limitBytes };
    }
    const at = new Date();
    const current = await currentWriter(tx, node);
    const save = { writer: input.writer, agent: null, at, mimeType: input.mimeType };
    const superseded = (await continuesSession(tx, node, current, save)) ? at : null;
    await keepCurrent(tx, node, node.r2Key, current, superseded);
    const done = await setContent(tx, node, {
      size: input.size,
      mimeType: input.mimeType,
      r2Key: input.r2Key,
      sha256: null,
      writtenByMemberId: input.writer.memberId,
      writtenAt: at,
      writtenByAgent: null,
      writtenByGuest: input.writer.guest ?? null,
      coauthors: mergeCoauthors(superseded ? current.writer.coauthors : null, input.coauthors),
    });
    if (done.status === "ok") await addUsage(tx, input.orgId, input.size);
    return done;
  });
}

/**
 * Names outsiders whose typing the file's content at `contentVersion` holds, when a member's
 * tab saved it (their fold says so). Does nothing once the file has moved past that version.
 */
export async function addCoauthors(
  db: Db,
  input: { nodeId: string; contentVersion: number; coauthors: StorageCoauthor[] },
) {
  if (input.coauthors.length === 0) return;
  await db.transaction(async (tx) => {
    const orgId = await orgOfNode(tx, input.nodeId);
    if (!orgId) return;
    await lockTree(tx, orgId);
    const [row] = await tx
      .select({ coauthors: storageContents.coauthors, contentVersion: storageNodes.contentVersion })
      .from(storageContents)
      .innerJoin(storageNodes, eq(storageNodes.id, storageContents.nodeId))
      .where(eq(storageContents.nodeId, input.nodeId));
    if (!row || row.contentVersion !== input.contentVersion) return;
    await tx
      .update(storageContents)
      .set({ coauthors: mergeCoauthors(row.coauthors, input.coauthors) })
      .where(eq(storageContents.nodeId, input.nodeId));
  });
}

/** Whether the door's holder may write a new version of the file: what an upload to it needs. */
export async function mayReplace(ex: Db, door: Door, nodeId: string) {
  const found = await editable(ex, door, nodeId);
  if (found.status !== "ok") return found;
  return found.node.lockedAt ? LOCKED : found;
}

export function versionOperations(db: Db, door: Door) {
  return {
    async mayWrite(nodeId: string) {
      return (await mayReplace(db, door, nodeId)).status;
    },
    async endSession(nodeId: string) {
      const found = await editable(db, door, nodeId);
      if (found.status !== "ok") return found.status;
      await db
        .update(storageContents)
        .set({ sessionEnded: true })
        .where(eq(storageContents.nodeId, nodeId));
      return "ok" as const;
    },
    async versions(nodeId: string) {
      const found = await editable(db, door, nodeId);
      if (found.status !== "ok") return found satisfies VersionsResult;
      const rows = await db
        .select({
          id: storageVersions.id,
          size: storageVersions.size,
          mimeType: storageVersions.mimeType,
          writtenAt: storageVersions.writtenAt,
          replacedAt: storageVersions.replacedAt,
          writtenByName: users.name,
          writtenByAgent: storageVersions.writtenByAgent,
          guest: storageVersions.writtenByGuest,
          coauthors: storageVersions.coauthors,
          contentVersion: storageVersions.contentVersion,
        })
        .from(storageVersions)
        .leftJoin(members, eq(members.id, storageVersions.writtenByMemberId))
        .leftJoin(users, eq(users.id, members.userId))
        .where(and(eq(storageVersions.nodeId, nodeId), isNull(storageVersions.supersededAt)))
        .orderBy(desc(storageVersions.replacedAt), desc(storageVersions.id));
      const { writer } = await currentWriter(db, found.node);
      return {
        status: "ok",
        node: toNode(found.node),
        current: {
          size: found.node.size,
          mimeType: found.node.mimeType,
          writtenAt: writer.writtenAt,
          writtenByName:
            (await nameOf(db, writer.writtenByMemberId)) ?? writer.writtenByGuest?.name ?? null,
          writtenByAgent: writer.writtenByAgent,
          writtenByGuest: !!writer.writtenByGuest,
          coauthors: writer.coauthors ?? [],
          contentVersion: found.node.contentVersion,
        },
        versions: rows.map(({ guest, coauthors, ...row }) => ({
          ...row,
          writtenByName: row.writtenByName ?? guest?.name ?? null,
          writtenByGuest: !!guest,
          coauthors: coauthors ?? [],
        })),
      } satisfies VersionsResult;
    },

    async versionFile(nodeId: string, versionId: string) {
      const found = await editable(db, door, nodeId);
      if (found.status !== "ok") return NOT_FOUND satisfies FileResult;
      const [version] = await db
        .select()
        .from(storageVersions)
        .where(and(eq(storageVersions.id, versionId), eq(storageVersions.nodeId, nodeId)));
      if (!version) return NOT_FOUND satisfies FileResult;
      const file = { ...toNode(found.node), size: version.size, mimeType: version.mimeType };
      return { status: "ok", file, r2Key: version.r2Key } satisfies FileResult;
    },

    restoreVersion(nodeId: string, versionId: string) {
      return db.transaction<RestoreVersionResult>(async (tx) => {
        const orgId = await orgOfNode(tx, nodeId);
        if (!orgId) return NOT_FOUND satisfies RestoreVersionResult;
        await lockTree(tx, orgId);
        await lockUsage(tx, orgId);
        const found = await editable(tx, door, nodeId);
        if (found.status !== "ok") return found satisfies RestoreVersionResult;
        if (found.node.lockedAt) return LOCKED satisfies RestoreVersionResult;
        const [version] = await tx
          .delete(storageVersions)
          .where(and(eq(storageVersions.id, versionId), eq(storageVersions.nodeId, nodeId)))
          .returning();
        if (!version) return NOT_FOUND satisfies RestoreVersionResult;
        await keepCurrent(tx, found.node, found.r2Key, await currentWriter(tx, found.node));
        return setContent(tx, found.node, {
          ...version,
          sha256: null,
        }) satisfies Promise<RestoreVersionResult>;
      });
    },
  };
}
