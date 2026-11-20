import { and, asc, desc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { organizations } from "../schema/auth.ts";
import {
  storageSignatureEvents,
  storageSignatureRequests,
  storageSigners,
} from "../schema/storage.ts";
import type { Door } from "./access.ts";
import { inTrash, orgOfNode, type StorageNode } from "./core.ts";
import { lockOperations } from "./lock.ts";
import { reach } from "./tree.ts";

export const STORAGE_PDF_MIME = "application/pdf";
/** Most people one request asks to sign. */
export const STORAGE_MAX_SIGNERS = 20;

export type StorageSignatureStatus = (typeof storageSignatureRequests.status.enumValues)[number];
export type StorageSignatureEventKind = (typeof storageSignatureEvents.kind.enumValues)[number];

/** Where a step came from, for the audit trail. */
export interface StorageSigningOrigin {
  email: string;
  ip: string | null;
  userAgent: string | null;
}

export interface StorageSigner {
  id: string;
  email: string;
  name: string;
  signedAt: Date | null;
  typedName: string | null;
}

export interface StorageSignatureEvent {
  kind: StorageSignatureEventKind;
  email: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
}

export interface StorageSignatureRequest {
  id: string;
  orgId: string;
  nodeId: string;
  contentVersion: number;
  documentSha256: string;
  status: StorageSignatureStatus;
  createdAt: Date;
  completedAt: Date | null;
  voidedAt: Date | null;
  /** The signed copy with its audit page, once sealed; null until then. */
  sealedNodeId: string | null;
  sealedSha256: string | null;
  signers: StorageSigner[];
  events: StorageSignatureEvent[];
}

export type SendForSignatureResult =
  | {
      status: "ok";
      request: StorageSignatureRequest;
      /** The file, now locked. */
      node: StorageNode;
      /** The sender's workspace, for the mail that names it. */
      workspaceName: string;
    }
  | { status: "not_found" }
  | { status: "not_a_pdf" }
  | { status: "version_conflict" }
  | { status: "signature_open" };

export type SignatureRequestResult =
  | { status: "ok"; request: StorageSignatureRequest }
  | { status: "not_found" }
  | { status: "signature_closed" };

const NOT_FOUND = { status: "not_found" } as const;

const signerColumns = {
  id: storageSigners.id,
  requestId: storageSigners.requestId,
  email: storageSigners.email,
  name: storageSigners.name,
  signedAt: storageSigners.signedAt,
  typedName: storageSigners.typedName,
};

const eventColumns = {
  requestId: storageSignatureEvents.requestId,
  kind: storageSignatureEvents.kind,
  email: storageSignatureEvents.email,
  ip: storageSignatureEvents.ip,
  userAgent: storageSignatureEvents.userAgent,
  createdAt: storageSignatureEvents.createdAt,
};

const requestColumns = {
  id: storageSignatureRequests.id,
  orgId: storageSignatureRequests.orgId,
  nodeId: storageSignatureRequests.nodeId,
  contentVersion: storageSignatureRequests.contentVersion,
  documentSha256: storageSignatureRequests.documentSha256,
  status: storageSignatureRequests.status,
  createdAt: storageSignatureRequests.createdAt,
  completedAt: storageSignatureRequests.completedAt,
  voidedAt: storageSignatureRequests.voidedAt,
  sealedNodeId: storageSignatureRequests.sealedNodeId,
  sealedSha256: storageSignatureRequests.sealedSha256,
};

type RequestRow = Omit<StorageSignatureRequest, "signers" | "events">;

/** The requests with their signers (in the order they were named) and audit trail, oldest first. */
export const withSigners: (
  ex: Db,
  rows: RequestRow[],
) => Promise<StorageSignatureRequest[]> = async (ex, rows) => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [signers, events] = await Promise.all([
    ex
      .select(signerColumns)
      .from(storageSigners)
      .where(inArray(storageSigners.requestId, ids))
      .orderBy(asc(storageSigners.id)),
    ex
      .select(eventColumns)
      .from(storageSignatureEvents)
      .where(inArray(storageSignatureEvents.requestId, ids))
      .orderBy(asc(storageSignatureEvents.createdAt), asc(storageSignatureEvents.id)),
  ]);
  return rows.map((row) => ({
    ...row,
    signers: signers
      .filter((signer) => signer.requestId === row.id)
      .map(({ id, email, name, signedAt, typedName }) => ({
        id,
        email,
        name,
        signedAt,
        typedName,
      })),
    events: events
      .filter((event) => event.requestId === row.id)
      .map(({ kind, email, ip, userAgent, createdAt }) => ({
        kind,
        email,
        ip,
        userAgent,
        createdAt,
      })),
  }));
};

async function written(ex: Db, row: RequestRow | undefined) {
  const [full] = row ? await withSigners(ex, [row]) : [];
  if (!full) throw new Error("storage: a signature request just written is gone");
  return full satisfies StorageSignatureRequest;
}

export async function loadRequest(ex: Db, requestId: string, forUpdate = false) {
  const query = ex
    .select(requestColumns)
    .from(storageSignatureRequests)
    .where(eq(storageSignatureRequests.id, requestId));
  const [row] = forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

/** Appends one step to a request's audit trail. Never updated, never deleted on its own. */
export async function appendSigningEvent(
  ex: Db,
  request: { id: string; orgId: string },
  kind: StorageSignatureEventKind,
  origin: StorageSigningOrigin,
) {
  await ex.insert(storageSignatureEvents).values({
    orgId: request.orgId,
    requestId: request.id,
    kind,
    email: origin.email.toLowerCase(),
    ip: origin.ip,
    userAgent: origin.userAgent,
  });
}

/**
 * The ids of requests that will not change any more: voided, or completed and sealed. A subquery,
 * for a caller that only wants rows waiting on one of these.
 */
export function closedSignatureRequestIds(ex: Db) {
  return ex
    .select({ id: storageSignatureRequests.id })
    .from(storageSignatureRequests)
    .where(
      or(
        eq(storageSignatureRequests.status, "voided"),
        and(
          eq(storageSignatureRequests.status, "completed"),
          isNotNull(storageSignatureRequests.sealedNodeId),
        ),
      ),
    );
}

/**
 * The workspace's requests with these ids, with signers and audit trail, for a module that keeps
 * its own pointer to a request (a CRM contract). Ids from another workspace are left out.
 */
export async function storageSignatureRequestsById(ex: Db, orgId: string, ids: string[]) {
  if (ids.length === 0) return [] satisfies StorageSignatureRequest[];
  const rows = await ex
    .select(requestColumns)
    .from(storageSignatureRequests)
    .where(
      and(eq(storageSignatureRequests.orgId, orgId), inArray(storageSignatureRequests.id, ids)),
    );
  return withSigners(ex, rows);
}

export function signingOperations(db: Db, door: Door, memberId: string) {
  async function reachFile(ex: Db, nodeId: string) {
    const found = await reach(ex, door, nodeId);
    if (!found || inTrash(found.chain) || found.node.kind !== "file") return null;
    return found;
  }

  return {
    sendForSignature(
      nodeId: string,
      input: {
        contentVersion: number;
        sha256: string;
        signers: { email: string; name: string }[];
        origin: StorageSigningOrigin;
      },
    ) {
      return db
        .transaction(async (tx) => {
          const orgId = await orgOfNode(tx, nodeId);
          if (!orgId) {
            const result: SendForSignatureResult = NOT_FOUND;
            return result;
          }
          const locked = await lockOperations(tx, door, memberId).lock(nodeId);
          if (locked.status !== "ok") {
            const result: SendForSignatureResult = NOT_FOUND;
            return result;
          }
          const { node } = locked;
          if (node.mimeType !== STORAGE_PDF_MIME) {
            throw new Refusal({ status: "not_a_pdf" });
          }
          if (node.contentVersion !== input.contentVersion) {
            throw new Refusal({ status: "version_conflict" });
          }
          const [open] = await tx
            .select({ id: storageSignatureRequests.id })
            .from(storageSignatureRequests)
            .where(
              and(
                eq(storageSignatureRequests.nodeId, nodeId),
                eq(storageSignatureRequests.status, "sent"),
              ),
            )
            .for("update");
          if (open) throw new Refusal({ status: "signature_open" });
          const [row] = await tx
            .insert(storageSignatureRequests)
            .values({
              orgId,
              nodeId,
              contentVersion: node.contentVersion,
              documentSha256: input.sha256,
              createdByMemberId: memberId,
            })
            .returning(requestColumns);
          if (!row) throw new Error("storage: the signature request was not written");
          const request = row;
          await tx.insert(storageSigners).values(
            input.signers.map((signer) => ({
              orgId,
              requestId: request.id,
              email: signer.email.toLowerCase(),
              name: signer.name,
            })),
          );
          await appendSigningEvent(tx, request, "sent", input.origin);
          const full = await written(tx, request);
          const [org] = await tx
            .select({ name: organizations.name })
            .from(organizations)
            .where(eq(organizations.id, orgId));
          const result: SendForSignatureResult = {
            status: "ok",
            request: full,
            node,
            workspaceName: org?.name ?? "",
          };
          return result;
        })
        .catch(refused<SendForSignatureResult>) satisfies Promise<SendForSignatureResult>;
    },

    async signatureRequests(nodeId: string) {
      const found = await reachFile(db, nodeId);
      if (!found) return NOT_FOUND;
      const rows = await db
        .select(requestColumns)
        .from(storageSignatureRequests)
        .where(eq(storageSignatureRequests.nodeId, nodeId))
        .orderBy(desc(storageSignatureRequests.createdAt), desc(storageSignatureRequests.id));
      return { status: "ok" as const, requests: await withSigners(db, rows) };
    },

    voidSignature(requestId: string, origin: StorageSigningOrigin) {
      return db.transaction<SignatureRequestResult>(async (tx) => {
        const request = await loadRequest(tx, requestId, true);
        if (!request || !(await reachFile(tx, request.nodeId)))
          return NOT_FOUND satisfies SignatureRequestResult;
        if (request.status !== "sent")
          return { status: "signature_closed" } satisfies SignatureRequestResult;
        const [row] = await tx
          .update(storageSignatureRequests)
          .set({ status: "voided", voidedAt: new Date() })
          .where(eq(storageSignatureRequests.id, requestId))
          .returning(requestColumns);
        if (!row) throw new Error("storage: the voided request is gone");
        await appendSigningEvent(tx, row, "voided", origin);
        return { status: "ok", request: await written(tx, row) } satisfies SignatureRequestResult;
      });
    },
  };
}

class Refusal<T> extends Error {
  readonly result: T;
  constructor(result: T) {
    super("refused");
    this.result = result;
  }
}

function refused<T>(error: unknown) {
  if (error instanceof Refusal) return error.result as T;
  throw error;
}
