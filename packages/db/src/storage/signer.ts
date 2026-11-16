// Signing, the signer's side (ADR 0043 decision 6, ADR 0037 decision 4 steps 2 and 3). A signer is
// an address: the person reaches a request when it names one they verified, under their session's
// scope (`grantAddresses`), and needs no grant on the file. They read the document, ask for a
// one-time code mailed to that address, and sign with it, a typed name and the consent version.
// The sender's side is `signing.ts`.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, organizations, users, verifications } from "../schema/auth.ts";
import { storageNodes, storageSignatureRequests, storageSigners } from "../schema/storage.ts";
import { grantAddresses } from "./access.ts";
import { chainOf, inTrash, toNode } from "./core.ts";
import {
  appendSigningEvent,
  loadRequest,
  type StorageSignatureStatus,
  type StorageSigningOrigin,
} from "./signing.ts";
import type { FileResult } from "./tree.ts";

/** A code works for ten minutes, for five tries. */
export const STORAGE_SIGNING_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_TRIES = 5;
const CODE_PREFIX = "storage-signing:";
const LIST_LIMIT = 100;

/** A request as the person asked to sign it sees it: names of the others, never their addresses. */
export interface StorageSigningItem {
  id: string;
  status: StorageSignatureStatus;
  fileName: string;
  size: number;
  workspaceName: string;
  /** The sender's address; null once that member is gone. */
  sentBy: string | null;
  createdAt: Date;
  documentSha256: string;
  signers: { name: string; signed: boolean }[];
  /** The person's own place in it. */
  me: { email: string; name: string; signedAt: Date | null };
}

export type SigningCodeResult =
  | {
      status: "ok";
      code: string;
      email: string;
      fileName: string;
      workspaceName: string;
      expiresAt: Date;
    }
  | { status: "not_found" }
  | { status: "signature_closed" }
  | { status: "already_signed" };

export type SignResult =
  | { status: "ok"; item: StorageSigningItem; completed: boolean }
  | { status: "not_found" }
  | { status: "signature_closed" }
  | { status: "already_signed" }
  /** Wrong, used or expired: ask for a new code. */
  | { status: "invalid_code" }
  /** The file was unlocked and changed after it was sent: it can no longer be signed. */
  | { status: "version_conflict" };

const NOT_FOUND = { status: "not_found" } as const;

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Six digits, uniform: values past the last whole million are drawn again. */
function randomCode() {
  const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? limit;
    if (value < limit) return String(value % 1_000_000).padStart(6, "0");
  }
}

const itemColumns = {
  id: storageSignatureRequests.id,
  orgId: storageSignatureRequests.orgId,
  nodeId: storageSignatureRequests.nodeId,
  status: storageSignatureRequests.status,
  contentVersion: storageSignatureRequests.contentVersion,
  createdAt: storageSignatureRequests.createdAt,
  documentSha256: storageSignatureRequests.documentSha256,
  fileName: storageNodes.name,
  size: storageNodes.size,
  workspaceName: organizations.name,
  sentBy: users.email,
};

/** The requests by id with their file, workspace and sender, newest first. */
function selectItems(ex: Db) {
  return ex
    .select(itemColumns)
    .from(storageSignatureRequests)
    .innerJoin(storageNodes, eq(storageNodes.id, storageSignatureRequests.nodeId))
    .innerJoin(organizations, eq(organizations.id, storageSignatureRequests.orgId))
    .leftJoin(members, eq(members.id, storageSignatureRequests.createdByMemberId))
    .leftJoin(users, eq(users.id, members.userId))
    .$dynamic();
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof selectItems>["execute"]>>[number];

/** Requests naming one of the person's addresses, with every signer of each. */
async function items(ex: Db, rows: ItemRow[], addresses: string[]) {
  if (rows.length === 0) return [];
  const signers = await ex
    .select()
    .from(storageSigners)
    .where(
      inArray(
        storageSigners.requestId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(storageSigners.id);
  return rows.flatMap((row): StorageSigningItem[] => {
    const all = signers.filter((signer) => signer.requestId === row.id);
    const mine = all.filter((signer) => addresses.includes(signer.email));
    // Someone holding two of the addresses signs once for each; the one still to sign first.
    const me = mine.find((signer) => !signer.signedAt) ?? mine[0];
    if (!me) return [];
    return [
      {
        id: row.id,
        status: row.status,
        fileName: row.fileName,
        size: row.size,
        workspaceName: row.workspaceName,
        sentBy: row.sentBy,
        createdAt: row.createdAt,
        documentSha256: row.documentSha256,
        signers: all.map((signer) => ({ name: signer.name, signed: signer.signedAt !== null })),
        me: { email: me.email, name: me.name, signedAt: me.signedAt },
      },
    ];
  });
}

/** The file as it was sent: live, and still the content the request names. */
async function sentContent(ex: Db, request: { nodeId: string; contentVersion: number }) {
  const chain = await chainOf(ex, request.nodeId);
  const node = chain?.[0];
  if (!chain || !node || inTrash(chain) || !node.r2Key) return null;
  return node.contentVersion === request.contentVersion ? { node, r2Key: node.r2Key } : null;
}

async function itemOf(ex: Db, requestId: string, addresses: string[]) {
  const rows = await selectItems(ex).where(eq(storageSignatureRequests.id, requestId));
  return (await items(ex, rows, addresses))[0] ?? null;
}

export function signerOperations(db: Db, userId: string, scopeOrgId?: string | null) {
  /** The request and the person's signer row on it (the one still to sign first), or null. */
  async function mySigner(ex: Db, requestId: string, forUpdate = false) {
    const addresses = await grantAddresses(ex, userId, scopeOrgId);
    if (addresses.length === 0) return null;
    const request = await loadRequest(ex, requestId, forUpdate);
    if (!request) return null;
    const [signer] = await ex
      .select()
      .from(storageSigners)
      .where(and(eq(storageSigners.requestId, requestId), inArray(storageSigners.email, addresses)))
      .orderBy(sql`${storageSigners.signedAt} is not null`, storageSigners.id)
      .limit(1);
    return signer ? { request, signer, addresses } : null;
  }

  return {
    /** Every request naming one of the person's addresses, newest first; voided ones too. */
    async toSign(): Promise<StorageSigningItem[]> {
      const addresses = await grantAddresses(db, userId, scopeOrgId);
      if (addresses.length === 0) return [];
      const named = db
        .select({ id: storageSigners.requestId })
        .from(storageSigners)
        .where(inArray(storageSigners.email, addresses));
      const rows = await selectItems(db)
        .where(inArray(storageSignatureRequests.id, named))
        .orderBy(desc(storageSignatureRequests.createdAt), desc(storageSignatureRequests.id))
        .limit(LIST_LIMIT);
      return items(db, rows, addresses);
    },

    async signingRequest(requestId: string): Promise<StorageSigningItem | null> {
      const found = await mySigner(db, requestId);
      return found ? itemOf(db, requestId, found.addresses) : null;
    },

    /**
     * The document's bytes as sent, and a `viewed` step in the audit trail. Nothing once the
     * request is voided, or when the file no longer holds the content that was sent.
     */
    async signingFile(requestId: string, origin: StorageSigningOrigin): Promise<FileResult> {
      const found = await mySigner(db, requestId);
      if (!found || found.request.status === "voided") return NOT_FOUND;
      const sent = await sentContent(db, found.request);
      if (!sent) return NOT_FOUND;
      await appendSigningEvent(db, found.request, "viewed", {
        ...origin,
        email: found.signer.email,
      });
      return { status: "ok", file: toNode(sent.node), r2Key: sent.r2Key };
    },

    /**
     * A new one-time code for the person's signer row, replacing any earlier one, for the caller
     * to mail to that address. Stored hashed (in Better Auth's `verifications`, as sign-in
     * emails are), with the tries left.
     */
    startSigningCode(requestId: string, origin: StorageSigningOrigin): Promise<SigningCodeResult> {
      return db.transaction(async (tx): Promise<SigningCodeResult> => {
        const found = await mySigner(tx, requestId, true);
        if (!found) return NOT_FOUND;
        const { request, signer } = found;
        if (request.status !== "sent") return { status: "signature_closed" };
        if (signer.signedAt) return { status: "already_signed" };
        const item = await itemOf(tx, requestId, found.addresses);
        if (!item) return NOT_FOUND;
        const code = randomCode();
        const identifier = CODE_PREFIX + signer.id;
        const expiresAt = new Date(Date.now() + STORAGE_SIGNING_CODE_TTL_MS);
        await tx.delete(verifications).where(eq(verifications.identifier, identifier));
        await tx.insert(verifications).values({
          id: crypto.randomUUID(),
          identifier,
          value: JSON.stringify({ hash: await sha256Hex(`${signer.id}:${code}`), tries: 0 }),
          expiresAt,
        });
        await appendSigningEvent(tx, request, "code_sent", { ...origin, email: signer.email });
        return {
          status: "ok",
          code,
          email: signer.email,
          fileName: item.fileName,
          workspaceName: item.workspaceName,
          expiresAt,
        };
      });
    },

    /**
     * Signs as the person's signer row: the code mailed to its address, the name they typed and
     * the consent version they accepted. The row records the hash of the bytes sent, which the
     * lock kept. The last signature completes the request.
     */
    sign(
      requestId: string,
      input: {
        code: string;
        typedName: string;
        consentVersion: string;
        origin: StorageSigningOrigin;
      },
    ): Promise<SignResult> {
      return db.transaction(async (tx): Promise<SignResult> => {
        const found = await mySigner(tx, requestId, true);
        if (!found) return NOT_FOUND;
        const { request, signer } = found;
        if (request.status !== "sent") return { status: "signature_closed" };
        if (signer.signedAt) return { status: "already_signed" };
        if (!(await sentContent(tx, request))) return { status: "version_conflict" };
        if (!(await useCode(tx, signer.id, input.code))) return { status: "invalid_code" };

        const origin = { ...input.origin, email: signer.email };
        await appendSigningEvent(tx, request, "code_verified", origin);
        await tx
          .update(storageSigners)
          .set({
            signedAt: new Date(),
            typedName: input.typedName,
            consentVersion: input.consentVersion,
            documentSha256: request.documentSha256,
            ip: origin.ip,
            userAgent: origin.userAgent,
            userId,
          })
          .where(and(eq(storageSigners.id, signer.id), isNull(storageSigners.signedAt)));
        await appendSigningEvent(tx, request, "signed", origin);

        const [waiting] = await tx
          .select({ id: storageSigners.id })
          .from(storageSigners)
          .where(and(eq(storageSigners.requestId, requestId), isNull(storageSigners.signedAt)))
          .limit(1);
        const completed = !waiting;
        if (completed) {
          await tx
            .update(storageSignatureRequests)
            .set({ status: "completed", completedAt: new Date() })
            .where(eq(storageSignatureRequests.id, requestId));
          await appendSigningEvent(tx, request, "completed", origin);
        }
        const item = await itemOf(tx, requestId, found.addresses);
        if (!item) throw new Error("storage: a request just signed is gone");
        return { status: "ok", item, completed };
      });
    },
  };
}

/**
 * Whether `code` is the live code for the signer, using it up if so. A wrong one spends a try,
 * and the last try spends the code.
 */
async function useCode(tx: Db, signerId: string, code: string) {
  const identifier = CODE_PREFIX + signerId;
  const [pending] = await tx
    .select({ id: verifications.id, value: verifications.value })
    .from(verifications)
    .where(and(eq(verifications.identifier, identifier), sql`${verifications.expiresAt} > now()`))
    .for("update");
  if (!pending) return false;
  const stored = JSON.parse(pending.value) as { hash: string; tries: number };
  if (stored.hash === (await sha256Hex(`${signerId}:${code}`))) {
    await tx.delete(verifications).where(eq(verifications.identifier, identifier));
    return true;
  }
  const tries = stored.tries + 1;
  if (tries >= CODE_TRIES) {
    await tx.delete(verifications).where(eq(verifications.id, pending.id));
  } else {
    await tx
      .update(verifications)
      .set({ value: JSON.stringify({ ...stored, tries }) })
      .where(eq(verifications.id, pending.id));
  }
  return false;
}
