import { and, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { verifications } from "../schema/auth.ts";
import { storageSigners } from "../schema/storage.ts";
import { sha256Hex, signerActions, type FindSigner } from "./signer.ts";
import { loadRequest } from "./signing.ts";

/** A signing link opens its request for thirty days. */
export const STORAGE_SIGNING_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LINK_PREFIX = "storage-signing-link:";

const identifierOf = async (token: string) => LINK_PREFIX + (await sha256Hex(token));

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * One link per signer of a request, for the mail that asks them to sign. Only the token's hash is
 * kept; the token opens that one request as that one signer, without an account.
 */
export async function issueSigningLinks(db: Db, requestId: string) {
  const signers = await db
    .select({ id: storageSigners.id, email: storageSigners.email })
    .from(storageSigners)
    .where(eq(storageSigners.requestId, requestId));
  const expiresAt = new Date(Date.now() + STORAGE_SIGNING_LINK_TTL_MS);
  const links = await Promise.all(
    signers.map(async (signer) => ({ ...signer, token: randomToken() })),
  );
  if (links.length === 0) return links;
  await db.insert(verifications).values(
    await Promise.all(
      links.map(async (link) => ({
        id: crypto.randomUUID(),
        identifier: await identifierOf(link.token),
        value: JSON.stringify({ requestId, signerId: link.id }),
        expiresAt,
      })),
    ),
  );
  return links;
}

async function linkedSignerId(db: Db, requestId: string, token: string) {
  const [found] = await db
    .select({ value: verifications.value })
    .from(verifications)
    .where(
      and(
        eq(verifications.identifier, await identifierOf(token)),
        gt(verifications.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (!found) return null;
  const value = JSON.parse(found.value) as { requestId: string; signerId: string };
  return value.requestId === requestId ? value.signerId : null;
}

/**
 * The link door: what the holder of a signing link may do on that one request, as the signer it
 * names. Null when the token is wrong, expired or for another request.
 */
export async function linkSigner(db: Db, requestId: string, token: string) {
  const signerId = await linkedSignerId(db, requestId, token);
  if (!signerId) return null;
  const mySigner: FindSigner = async (ex, id, forUpdate = false) => {
    if (id !== requestId) return null;
    const request = await loadRequest(ex, id, forUpdate);
    if (!request) return null;
    const [signer] = await ex
      .select()
      .from(storageSigners)
      .where(and(eq(storageSigners.requestId, id), eq(storageSigners.id, signerId)))
      .limit(1);
    return signer ? { request, signer, addresses: [signer.email] } : null;
  };
  return signerActions(db, mySigner, null);
}
