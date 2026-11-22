import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import {
  storageNodes,
  storageUploadLinks,
  storageUploadParts,
  storageUploads,
  storageUploadTargets,
} from "../schema/storage.ts";
import {
  grantDoor,
  linkState,
  memberDoor,
  storagePolicyOf,
  type Door,
  type LinkVisitor,
} from "./access.ts";
import { chainOf, inTrash, type NodeRow } from "./core.ts";
import {
  linkDetail,
  newShareId,
  readSharing,
  recordShareEvent,
  sharingOperations,
  type ChangeLinkResult,
  type SharedThing,
  type SharingResult,
  type StorageLinkAccess,
  type StorageLinkSettings,
} from "./sharing.ts";
import { placeOf, resolvePlace } from "./tree.ts";

type UploadRow = typeof storageUploads.$inferSelect;
type LinkRow = typeof storageUploadLinks.$inferSelect;

/** A file still uploading, as a link to it or to its folder shows it. */
export interface UploadingFile {
  /** The upload's id: the file's id once it completes. */
  id: string;
  name: string;
  size: number;
  mimeType: string | null;
  space: UploadRow["space"];
  /** Bytes of the parts stored so far. */
  uploadedBytes: number;
  createdAt: Date;
}

/** The most uploads a folder's link lists at once. */
export const UPLOADING_LISTED = 200;

const NOT_FOUND = { status: "not_found" } as const;
const FORBIDDEN = { status: "forbidden" } as const;
const POLICY = { status: "policy" } as const;

const stillUploading = (uploadId?: string) =>
  and(
    uploadId ? eq(storageUploads.id, uploadId) : undefined,
    isNull(storageUploads.nodeId),
    gt(storageUploads.expiresAt, new Date()),
    sql`not exists (select 1 from ${storageUploadTargets} where ${storageUploadTargets.uploadId} = ${storageUploads.id})`,
  );

const uploadedBytes = sql<string>`coalesce((select sum(${storageUploadParts.size}) from ${storageUploadParts} where ${storageUploadParts.uploadId} = ${storageUploads.id}), 0)`;

const uploadingColumns = {
  id: storageUploads.id,
  name: storageUploads.name,
  size: storageUploads.size,
  mimeType: storageUploads.mimeType,
  space: storageUploads.space,
  createdAt: storageUploads.createdAt,
  uploadedBytes,
};

const toUploading = (row: Omit<UploadingFile, "uploadedBytes"> & { uploadedBytes: string }) =>
  ({ ...row, uploadedBytes: Number(row.uploadedBytes) }) satisfies UploadingFile;

/**
 * The files still uploading into `folderId`, by name, at most `UPLOADING_LISTED`: new files
 * only, since a new version of a file already shows as that file. The caller has checked who
 * may list the folder.
 */
export async function uploadingIn(ex: Db, folderId: string) {
  const rows = await ex
    .select(uploadingColumns)
    .from(storageUploads)
    .where(and(eq(storageUploads.parentId, folderId), stillUploading()))
    .orderBy(asc(sql`lower(${storageUploads.name})`), asc(storageUploads.id))
    .limit(UPLOADING_LISTED);
  return rows.map(toUploading);
}

async function placeIsLive(ex: Db, upload: Pick<UploadRow, "parentId">) {
  if (!upload.parentId) return true;
  const chain = await chainOf(ex, upload.parentId);
  return chain !== null && !inTrash(chain);
}

/** The link carrying `shareId` on a file still uploading, with that upload; null when none. */
export async function uploadLinkOf(ex: Db, shareId: string) {
  const [row] = await ex
    .select({ link: storageUploadLinks, upload: storageUploads })
    .from(storageUploadLinks)
    .innerJoin(storageUploads, eq(storageUploads.id, storageUploadLinks.uploadId))
    .where(and(eq(storageUploadLinks.shareId, shareId), stillUploading()));
  if (!row || !(await placeIsLive(ex, row.upload))) return null;
  return row;
}

async function membersReach(ex: Db, upload: UploadRow, visitor: LinkVisitor) {
  if (!visitor.userId) return false;
  if (visitor.scopeOrgId && visitor.scopeOrgId !== upload.orgId) return false;
  const rows = await ex
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, visitor.userId), eq(members.organizationId, upload.orgId)));
  for (const { id } of rows) {
    if (!upload.parentId) {
      if (
        upload.space === "personal"
          ? id === upload.memberId
          : await resolvePlace(ex, memberDoor(id), placeOf(upload))
      ) {
        return true;
      }
      continue;
    }
    if (await resolvePlace(ex, memberDoor(id), { parentId: upload.parentId })) return true;
  }
  return false;
}

async function grantReaches(ex: Db, upload: UploadRow, visitor: LinkVisitor) {
  if (!visitor.userId || !upload.parentId) return false;
  const door = grantDoor(visitor.userId, visitor.scopeOrgId);
  return (await resolvePlace(ex, door, { parentId: upload.parentId })) !== null;
}

export type OpenUploadLinkResult =
  | {
      status: "open";
      orgId: string;
      upload: UploadingFile;
      /** The door it opened through, as the sharing audit records it. */
      via: "member" | "grant" | "link";
      /** False when only the link opened it and the link is view only. */
      downloads: boolean;
    }
  | { status: "locked" }
  | { status: "not_found" };

/**
 * What `/s/<shareId>` opens while the file behind it still uploads. As for a node's link: a
 * member who reaches the folder it lands in, and a person a folder above it was shared with,
 * see it whatever the link says; anyone else only while `linkState` says the link is open for
 * them.
 */
export async function openUploadLink(ex: Db, shareId: string, visitor: LinkVisitor) {
  const found = await uploadLinkOf(ex, shareId);
  if (!found) return NOT_FOUND satisfies OpenUploadLinkResult;
  const { link, upload } = found;
  const [row] = await ex
    .select(uploadingColumns)
    .from(storageUploads)
    .where(eq(storageUploads.id, upload.id));
  const open = (via: "member" | "grant" | "link", downloads: boolean) =>
    ({
      status: "open",
      orgId: upload.orgId,
      upload: toUploading(row!),
      via,
      downloads,
    }) satisfies OpenUploadLinkResult;
  if (await membersReach(ex, upload, visitor)) return open("member", true);
  if (await grantReaches(ex, upload, visitor)) return open("grant", true);
  const state = await linkState(ex, { ...link, orgId: upload.orgId }, visitor);
  if (state === "open") return open("link", link.linkDownloads);
  return (state === "locked" ? { status: "locked" } : NOT_FOUND) satisfies OpenUploadLinkResult;
}

const sharedThing = (upload: UploadRow, link: LinkRow | null) =>
  ({
    id: upload.id,
    orgId: upload.orgId,
    name: upload.name,
    shareId: link?.shareId ?? null,
    linkAccess: link?.linkAccess ?? "restricted",
    linkExpiresAt: link?.linkExpiresAt ?? null,
    linkPasswordHash: link?.linkPasswordHash ?? null,
    linkDownloads: link?.linkDownloads ?? true,
  }) satisfies SharedThing;

/**
 * Moves the link made while the file uploaded onto the file it became, in the completing
 * transaction: `/s/<shareId>` keeps its address and its settings. Returns the file's row.
 */
export async function moveUploadLink(tx: Db, uploadId: string, node: NodeRow) {
  const [link] = await tx
    .delete(storageUploadLinks)
    .where(eq(storageUploadLinks.uploadId, uploadId))
    .returning();
  if (!link) return node;
  const [row] = await tx
    .update(storageNodes)
    .set({
      shareId: link.shareId,
      linkAccess: link.linkAccess,
      linkExpiresAt: link.linkExpiresAt,
      linkPasswordHash: link.linkPasswordHash,
      linkDownloads: link.linkDownloads,
    })
    .where(eq(storageNodes.id, node.id))
    .returning();
  return row ?? node;
}

/**
 * Sharing a file before it finishes uploading: only its uploader, as a member, and only a new
 * file (a new version is shared as the file it replaces). Each call answers the sharing as
 * `nodeId` names it, the upload's id, which the file keeps. Once the upload has completed the
 * call goes to the file itself.
 */
export function uploadLinkOperations(db: Db, door: Door) {
  const files = sharingOperations(db, door);

  async function shareable(ex: Db, uploadId: string, lock = false) {
    if (door.kind !== "member") return FORBIDDEN;
    const query = ex.select().from(storageUploads).where(eq(storageUploads.id, uploadId));
    const [upload] = await (lock ? query.for("update") : query);
    if (!upload || !(await door.ownsUpload(ex, upload.memberId))) return NOT_FOUND;
    if (upload.nodeId) return { status: "complete" as const, nodeId: upload.nodeId };
    const [live] = await ex
      .select({ id: storageUploads.id })
      .from(storageUploads)
      .where(stillUploading(uploadId));
    if (!live) return NOT_FOUND;
    const resolved = await resolvePlace(ex, door, placeOf(upload));
    if (!resolved) return NOT_FOUND;
    if (resolved.access && !resolved.access.share) return FORBIDDEN;
    const above = upload.parentId ? ((await chainOf(ex, upload.parentId)) ?? []) : [];
    return { status: "ok" as const, upload, above };
  }

  async function linkRow(ex: Db, uploadId: string) {
    const [row] = await ex
      .select()
      .from(storageUploadLinks)
      .where(eq(storageUploadLinks.uploadId, uploadId));
    return row ?? null;
  }

  function changeLink(
    uploadId: string,
    change: (link: LinkRow | null) => Partial<LinkRow> & { shareId: string },
    onFile: () => Promise<ChangeLinkResult>,
    reset = false,
  ) {
    return db
      .transaction<ChangeLinkResult | { status: "complete" }>(async (tx) => {
        const found = await shareable(tx, uploadId, true);
        if (found.status === "complete") return found;
        if (found.status !== "ok") return found;
        const { upload, above } = found;
        const set = change(await linkRow(tx, uploadId));
        if (set.linkAccess === "anyone" && !(await storagePolicyOf(tx, upload.orgId)).publicLinks) {
          return POLICY;
        }
        const [link] = await tx
          .insert(storageUploadLinks)
          .values({ uploadId, orgId: upload.orgId, ...set })
          .onConflictDoUpdate({ target: storageUploadLinks.uploadId, set })
          .returning();
        await recordShareEvent(tx, {
          orgId: upload.orgId,
          nodeId: uploadId,
          kind: "link_changed",
          via: door.kind,
          actorMemberId: await door.actor(tx, upload.orgId),
          detail: { ...linkDetail(set, reset), uploading: true },
        });
        return {
          status: "ok",
          sharing: await readSharing(tx, [sharedThing(upload, link!), ...above]),
        } satisfies ChangeLinkResult;
      })
      .then((result) => (result.status === "complete" ? onFile() : result));
  }

  return {
    async uploadSharing(uploadId: string) {
      const found = await shareable(db, uploadId);
      if (found.status === "complete") return files.sharing(found.nodeId);
      if (found.status !== "ok") return found satisfies SharingResult;
      const link = await linkRow(db, uploadId);
      return {
        status: "ok",
        sharing: await readSharing(db, [sharedThing(found.upload, link), ...found.above]),
      } satisfies SharingResult;
    },

    setUploadLinkAccess(uploadId: string, linkAccess: StorageLinkAccess) {
      return changeLink(
        uploadId,
        (link) => ({ shareId: link?.shareId ?? newShareId(), linkAccess }),
        () => files.setLinkAccess(uploadId, linkAccess),
      );
    },

    setUploadLinkSettings(uploadId: string, settings: StorageLinkSettings) {
      return changeLink(
        uploadId,
        (link) => ({
          shareId: link?.shareId ?? newShareId(),
          ...(settings.expiresAt !== undefined ? { linkExpiresAt: settings.expiresAt } : {}),
          ...(settings.passwordHash !== undefined
            ? { linkPasswordHash: settings.passwordHash }
            : {}),
          ...(settings.downloads !== undefined ? { linkDownloads: settings.downloads } : {}),
        }),
        () => files.setLinkSettings(uploadId, settings),
      );
    },

    resetUploadLink(uploadId: string) {
      return changeLink(
        uploadId,
        () => ({ shareId: newShareId() }),
        () => files.resetLink(uploadId),
        true,
      );
    },
  };
}
