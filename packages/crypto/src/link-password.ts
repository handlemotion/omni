import { fromBase64, toBase64Url, utf8 } from "./encoding.ts";

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const SCHEME = "pbkdf2-sha256";

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** The stored form of a share link's password: `pbkdf2-sha256$<iterations>$<salt>$<hash>`. */
export async function hashLinkPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return [SCHEME, ITERATIONS, toBase64Url(salt), toBase64Url(hash)].join("$");
}

/** Whether `password` is the one `stored` was made from. A malformed `stored` matches nothing. */
export async function linkPasswordMatches(password: string, stored: string) {
  const [scheme, rounds, saltText, hashText] = stored.split("$");
  const iterations = Number(rounds);
  const salt = saltText ? fromBase64(saltText) : null;
  const hash = hashText ? fromBase64(hashText) : null;
  if (scheme !== SCHEME || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) {
    return false;
  }
  return equalBytes(await derive(password, salt, iterations), hash);
}

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`omni-link-key:${message}`)));
}

/**
 * Proof that the visitor typed a link's password, good until `expiresAt`: `<ms>.<mac>`, bound to
 * the link and to the password hash, so a new password or a reset link ends it.
 */
export async function signLinkKey(
  secret: string,
  link: { shareId: string; passwordHash: string },
  expiresAt: Date,
) {
  const until = String(expiresAt.getTime());
  const mac = await hmac(secret, `${link.shareId}.${link.passwordHash}.${until}`);
  return `${until}.${toBase64Url(mac)}`;
}

/** Whether `key` came from `signLinkKey` for this link and password, and has not expired. */
export async function linkKeyMatches(
  secret: string,
  link: { shareId: string; passwordHash: string },
  key: string,
  now = new Date(),
) {
  const [until, macText] = key.split(".");
  const mac = macText ? fromBase64(macText) : null;
  if (!until || !/^\d+$/.test(until) || !mac || Number(until) <= now.getTime()) return false;
  return equalBytes(await hmac(secret, `${link.shareId}.${link.passwordHash}.${until}`), mac);
}
