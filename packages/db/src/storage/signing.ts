// Signing, the sender's side (ADR 0043 decision 6, the flow of ADR 0037 decision 4): a member
// sends one locked PDF to signers by address, sees where it stands, and voids it. The signer's
// side is `signer.ts`. A request names the content it was sent on (`content_version`) and the hash
// the Worker computed streaming those bytes; the file is locked in the same transaction, so the
// content a signer is shown is the content that was hashed.
import { and, asc, desc, eq, inArray } from "drizzle-orm";
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
  /** Only a PDF is sent for signature. */
  | { status: "not_a_pdf" }
  /** The file changed after its bytes were hashed: hash it again. */
  | { status: "version_conflict" }
  /** The file is already out for signature: void that request first. */
  | { status: "signature_open" };

export type SignatureRequestResult =
  | { status: "ok"; request: StorageSignatureRequest }
  | { status: "not_found" }
  /** Completed or voided already. */
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
};

type RequestRow = Omit<StorageSignatureRequest, "signers" | "events">;

/** The requests with their signers (in the order they were named) and audit trail, oldest first. */
export async function withSigners(ex: Db, rows: RequestRow[]): Promise<StorageSignatureRequest[]> {
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
}

/** One request just written, with its signers and trail. */
async function written(ex: Db, row: RequestRow | undefined): Promise<StorageSignatureRequest> {
  const [full] = row ? await withSigners(ex, [row]) : [];
  if (!full) throw new Error("storage: a signature request just written is gone");
  return full;
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

export function signingOperations(db: Db, door: Door, memberId: string) {
  /** A live file the member reaches, or null. */
  async function reachFile(ex: Db, nodeId: string) {
    const found = await reach(ex, door, nodeId);
    if (!found || inTrash(found.chain) || found.node.kind !== "file") return null;
    return found;
  }

  return {
    /**
     * Sends a PDF for signature: locks it (ADR 0036 decision 6), and records the request, its
     * signers and the `sent` step, all or nothing. `contentVersion` and `sha256` are what the
     * caller read and hashed; a file that moved on since is refused, never sent on bytes nobody
     * hashed. A file is out for signature once at a time.
     */
    sendForSignature(
      nodeId: string,
      input: {
        contentVersion: number;
        sha256: string;
        signers: { email: string; name: string }[];
        origin: StorageSigningOrigin;
      },
    ): Promise<SendForSignatureResult> {
      return db
        .transaction(async (tx): Promise<SendForSignatureResult> => {
          const orgId = await orgOfNode(tx, nodeId);
          if (!orgId) return NOT_FOUND;
          // Taking the lock first takes the tree lock too, so nothing replaces the content between
          // this check and the request row.
          const locked = await lockOperations(tx, door, memberId).lock(nodeId);
          if (locked.status !== "ok") return NOT_FOUND;
          const { node } = locked;
          if (node.mimeType !== STORAGE_PDF_MIME) {
            // The lock rolls back with the transaction.
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
            // UUIDv7 ids are made in order, so listing by id keeps the order the sender named.
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
          return { status: "ok", request: full, node, workspaceName: org?.name ?? "" };
        })
        .catch(refused<SendForSignatureResult>);
    },

    /** Every request made on a file the member reaches, newest first. */
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

    /**
     * Voids a request still out for signature. The file stays locked: it was the file sent, and
     * only an owner or admin makes it an ordinary file again (`unlock`).
     */
    voidSignature(
      requestId: string,
      origin: StorageSigningOrigin,
    ): Promise<SignatureRequestResult> {
      return db.transaction(async (tx): Promise<SignatureRequestResult> => {
        const request = await loadRequest(tx, requestId, true);
        if (!request || !(await reachFile(tx, request.nodeId))) return NOT_FOUND;
        if (request.status !== "sent") return { status: "signature_closed" };
        const [row] = await tx
          .update(storageSignatureRequests)
          .set({ status: "voided", voidedAt: new Date() })
          .where(eq(storageSignatureRequests.id, requestId))
          .returning(requestColumns);
        if (!row) throw new Error("storage: the voided request is gone");
        await appendSigningEvent(tx, row, "voided", origin);
        return { status: "ok", request: await written(tx, row) };
      });
    },
  };
}

/** A refusal thrown out of a transaction so everything it wrote, the lock included, rolls back. */
class Refusal<T> extends Error {
  readonly result: T;
  constructor(result: T) {
    super("refused");
    this.result = result;
  }
}

function refused<T>(error: unknown): T {
  if (error instanceof Refusal) return error.result as T;
  throw error;
}
