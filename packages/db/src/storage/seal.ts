// The seal (ADR 0037 decision 4 step 4, ADR 0043 decision 6): once every signer has signed, the
// Worker builds the signed copy (the PDF with an audit page) and this records it as a locked file
// beside the original. Trusted background work, keyed by the request: two runs may build a copy
// at once (the one after the last signature and the minute cron), each to an object key of its
// own, and only the run that records first under the request's row lock keeps its object.
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, organizations, users } from "../schema/auth.ts";
import { storageLocks, storageNodes, storageSignatureRequests } from "../schema/storage.ts";
import {
  addUsage,
  chainOf,
  driveOf,
  inTrash,
  insertNode,
  lockTree,
  lockUsage,
  storageObjectKey,
  toNode,
  type StorageNode,
} from "./core.ts";
import { loadRequest, withSigners, type StorageSignatureRequest } from "./signing.ts";

/** Requests one run seals at most. */
const SEAL_BATCH = 10;

/** Everything the audit page states, and where the original's bytes are. */
export interface StorageSealInput {
  request: StorageSignatureRequest;
  workspaceName: string;
  /** The sender's address; null once that member is gone. */
  sentBy: string | null;
  fileName: string;
  /** The original as it was sent. */
  r2Key: string;
  /** Where this run writes its copy: a key of its own, so a concurrent run never overwrites it. */
  sealedR2Key: string;
}

export type RecordSealResult =
  | { status: "sealed"; node: StorageNode }
  /** Another run recorded it first: this run's object is unused, and the caller deletes it. */
  | { status: "already_sealed" }
  /** Not completed, or the original is gone or changed: nothing to seal. */
  | { status: "not_sealable" };

/**
 * Completed requests with no sealed copy yet whose original still holds what was sent, oldest
 * first. One whose original was unlocked and then changed, trashed or deleted can never be
 * sealed, so it is left out here rather than holding a place in every batch.
 */
export async function unsealedSignatureRequests(db: Db): Promise<{ id: string }[]> {
  return db
    .select({ id: storageSignatureRequests.id })
    .from(storageSignatureRequests)
    .innerJoin(storageNodes, eq(storageNodes.id, storageSignatureRequests.nodeId))
    .where(
      and(
        eq(storageSignatureRequests.status, "completed"),
        isNull(storageSignatureRequests.sealedNodeId),
        eq(storageNodes.contentVersion, storageSignatureRequests.contentVersion),
        isNull(storageNodes.trashedAt),
        isNotNull(storageNodes.r2Key),
      ),
    )
    .orderBy(asc(storageSignatureRequests.completedAt), asc(storageSignatureRequests.id))
    .limit(SEAL_BATCH);
}

/** The original, live and still holding the content that was sent, or null. */
async function sentOriginal(ex: Db, request: { nodeId: string; contentVersion: number }) {
  const chain = await chainOf(ex, request.nodeId);
  const node = chain?.[0];
  if (!chain || !node?.r2Key || inTrash(chain)) return null;
  return node.contentVersion === request.contentVersion ? node : null;
}

/** What sealing `requestId` needs, or null when it is not completed or is sealed already. */
export async function storageSealInput(
  db: Db,
  requestId: string,
): Promise<StorageSealInput | null> {
  const row = await loadRequest(db, requestId);
  if (!row || row.status !== "completed") return null;
  const [sealed] = await db
    .select({ sealedNodeId: storageSignatureRequests.sealedNodeId })
    .from(storageSignatureRequests)
    .where(eq(storageSignatureRequests.id, requestId));
  if (sealed?.sealedNodeId) return null;
  const original = await sentOriginal(db, row);
  if (!original?.r2Key) return null;
  const [context] = await db
    .select({ workspaceName: organizations.name, sentBy: users.email })
    .from(storageSignatureRequests)
    .innerJoin(organizations, eq(organizations.id, storageSignatureRequests.orgId))
    .leftJoin(members, eq(members.id, storageSignatureRequests.createdByMemberId))
    .leftJoin(users, eq(users.id, members.userId))
    .where(eq(storageSignatureRequests.id, requestId));
  const [request] = await withSigners(db, [row]);
  if (!request || !context) return null;
  return {
    request,
    workspaceName: context.workspaceName,
    sentBy: context.sentBy,
    fileName: original.name,
    r2Key: original.r2Key,
    sealedR2Key: storageObjectKey(row.orgId, `sealed-${row.id}-${crypto.randomUUID()}`),
  };
}

/** "contract.pdf" → "contract (signed).pdf". */
export function sealedName(name: string) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base} (signed).pdf`;
}

/**
 * Records the sealed copy, already in the bucket at the input's `sealedR2Key`: a locked file
 * beside the original, its bytes counted toward usage (evidence is stored even over the quota),
 * and the request pointing at it with its hash. Once per request, under the request's row lock.
 */
export function recordStorageSeal(
  db: Db,
  requestId: string,
  sealed: { r2Key: string; size: number; sha256: string },
): Promise<RecordSealResult> {
  return db.transaction(async (tx): Promise<RecordSealResult> => {
    const request = await loadRequest(tx, requestId, true);
    if (!request || request.status !== "completed") return { status: "not_sealable" };
    const [current] = await tx
      .select({
        sealedNodeId: storageSignatureRequests.sealedNodeId,
        createdByMemberId: storageSignatureRequests.createdByMemberId,
      })
      .from(storageSignatureRequests)
      .where(eq(storageSignatureRequests.id, requestId));
    if (current?.sealedNodeId) return { status: "already_sealed" };
    await lockTree(tx, request.orgId);
    const original = await sentOriginal(tx, request);
    if (!original) return { status: "not_sealable" };

    await lockUsage(tx, request.orgId);
    const row = await insertNode(tx, {
      drive: driveOf(original),
      parentId: original.parentId,
      kind: "file",
      name: sealedName(original.name),
      size: sealed.size,
      mimeType: "application/pdf",
      r2Key: sealed.r2Key,
      contentSha256: sealed.sha256,
      createdByMemberId: current?.createdByMemberId ?? null,
    });
    await addUsage(tx, request.orgId, sealed.size);
    const [lock] = await tx
      .insert(storageLocks)
      .values({
        nodeId: row.id,
        orgId: request.orgId,
        lockedByMemberId: current?.createdByMemberId ?? null,
      })
      .returning({ lockedAt: storageLocks.lockedAt });
    await tx
      .update(storageSignatureRequests)
      .set({ sealedNodeId: row.id, sealedSha256: sealed.sha256 })
      .where(eq(storageSignatureRequests.id, requestId));
    return { status: "sealed", node: toNode({ ...row, lockedAt: lock?.lockedAt ?? new Date() }) };
  });
}

/**
 * The sealed copy's object, for a signer or the sender to download; null until it is sealed, and
 * null again once the file no longer holds the copy recorded (unlocked and replaced): a signer
 * gets the certificate they signed toward or nothing, never what a member put in its place.
 */
export async function sealedObject(ex: Db, requestId: string) {
  const [row] = await ex
    .select({ node: storageNodes, sealedSha256: storageSignatureRequests.sealedSha256 })
    .from(storageSignatureRequests)
    .innerJoin(storageNodes, eq(storageNodes.id, storageSignatureRequests.sealedNodeId))
    .where(eq(storageSignatureRequests.id, requestId));
  if (!row?.node.r2Key || row.node.contentSha256 !== row.sealedSha256) return null;
  return { node: toNode(row.node), r2Key: row.node.r2Key };
}
