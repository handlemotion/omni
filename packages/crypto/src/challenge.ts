// Domain ownership challenges (ADR 0010). A claim gets a random token that only the domain's DNS
// can publish, as the TXT value `omni-challenge=<token>`. Only the token's SHA-256 is stored, so a
// database read alone cannot produce a passing record; checks compare digests in constant time.
import { toBase64Url, toHex, utf8 } from "./encoding.ts";

const PREFIX = "omni-challenge=";
const TOKEN_BYTES = 32;

/** A fresh challenge: the TXT value to show once, and the hash to store. */
export async function newChallenge(): Promise<{ value: string; hash: string }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  const value = `${PREFIX}${token}`;
  return { value, hash: await hashChallenge(value) };
}

/** The stored form of a challenge value: SHA-256, hex. */
export async function hashChallenge(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value.trim()))));
}

/**
 * Whether any TXT value found in DNS is the challenge whose hash is `hash`. Every value is hashed
 * and compared, so the time taken says nothing about how close a guess came.
 */
export async function challengeMatches(found: readonly string[], hash: string): Promise<boolean> {
  let match = false;
  for (const value of found) {
    if (!value.trim().startsWith(PREFIX)) continue;
    if (constantTimeEqual(await hashChallenge(value), hash)) match = true;
  }
  return match;
}

/** Equal strings, compared without an early exit. Lengths are not secret (both are hex digests). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
