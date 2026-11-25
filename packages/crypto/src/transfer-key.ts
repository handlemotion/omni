import { fromBase64, fromUtf8, toBase64Url, utf8 } from "./encoding.ts";

const DOMAIN = "omni-transfer-key";

/**
 * What a transfer key lets its holder do, once, without signing in: `get` a file's bytes, or
 * `put` the bytes of an upload an agent opened. It acts as the person who asked (`userId`, in
 * `scope`, and as `memberId` when the file is in their workspace), checked again when used.
 */
export interface TransferGrant {
  kind: "get" | "put";
  /** The file's id for `get`, the upload's id for `put`. */
  subject: string;
  userId: string;
  /** The workspace the person's agent was limited to, or null for all of theirs. */
  scope: string | null;
  /** The workspace whose member door it acts through; null for what was shared with the person. */
  orgId: string | null;
  /** `put` of a new version: the file's version it replaces, refused once the file moved on. */
  ifContentVersion: number | null;
  expiresAt: Date;
}

const grantShape = (value: unknown) => {
  if (typeof value !== "object" || value === null) return null;
  const { k, s, u, w, o, v, e } = value as Record<string, unknown>;
  const text = (x: unknown) => typeof x === "string" && x.length > 0;
  if ((k !== "get" && k !== "put") || !text(s) || !text(u) || typeof e !== "number") return null;
  if (!(w === null || text(w)) || !(o === null || text(o))) return null;
  if (!(v === null || (typeof v === "number" && Number.isInteger(v)))) return null;
  const grant: TransferGrant = {
    kind: k,
    subject: s as string,
    userId: u as string,
    scope: w as string | null,
    orgId: o as string | null,
    ifContentVersion: v as number | null,
    expiresAt: new Date(e),
  };
  return grant;
};

async function mac(secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return key;
}

/** A key for `grant`: `<payload>.<mac>`, both base64url, safe in a URL path. */
export async function signTransferKey(secret: string, grant: TransferGrant) {
  const payload = toBase64Url(
    utf8(
      JSON.stringify({
        k: grant.kind,
        s: grant.subject,
        u: grant.userId,
        w: grant.scope,
        o: grant.orgId,
        v: grant.ifContentVersion,
        e: grant.expiresAt.getTime(),
      }),
    ),
  );
  const key = await mac(secret);
  const signature = await crypto.subtle.sign("HMAC", key, utf8(`${DOMAIN}:${payload}`));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The grant `key` carries when `signTransferKey` made it under `secret` and it has not expired. */
export async function transferOfKey(secret: string, key: string, now = new Date()) {
  const [payload, signatureText, extra] = key.split(".");
  if (extra !== undefined || !payload || !signatureText) return null;
  const signature = fromBase64(signatureText);
  const body = fromBase64(payload);
  if (!signature || !body) return null;
  const verified = await crypto.subtle.verify(
    "HMAC",
    await mac(secret),
    signature,
    utf8(`${DOMAIN}:${payload}`),
  );
  if (!verified) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(body));
  } catch {
    return null;
  }
  const grant = grantShape(parsed);
  return grant && grant.expiresAt > now ? grant : null;
}
