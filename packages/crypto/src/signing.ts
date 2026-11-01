// HMAC-SHA256 request signing for Worker <-> mail service calls. This is the one verifier;
// never hand-roll a second one (AGENTS.md).
//
// Canonical string, one field per line:
//
//   omni-v1
//   <METHOD uppercased>
//   <path including the query string, exactly as sent>
//   <timestamp, unix seconds>
//   <nonce, or empty>
//   <hex sha256 of the raw body bytes>
//
// The signature covers every field, so changing any of them (or the body) fails verification.
// Timestamps outside `maxAgeSeconds` in either direction are rejected, which bounds replay to
// that window. For full replay protection, send a unique `nonce` and have the receiver remember
// nonces it accepted for `maxAgeSeconds`; this package signs the nonce but keeps no state.

import { toHex, fromHex, utf8 } from "./encoding.ts";

export const SIGNATURE_HEADER = "x-omni-signature";
export const TIMESTAMP_HEADER = "x-omni-timestamp";
export const NONCE_HEADER = "x-omni-nonce";

export const DEFAULT_MAX_AGE_SECONDS = 60;

const VERSION = "omni-v1";
const SIGNATURE_PREFIX = "v1=";
const MIN_SECRET_BYTES = 32;

export type RequestBody = string | Uint8Array<ArrayBuffer> | null | undefined;

export interface SignRequestInput {
  secret: string;
  method: string;
  path: string;
  body?: RequestBody;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
  nonce?: string;
}

export interface VerifyRequestInput {
  secret: string;
  method: string;
  path: string;
  body?: RequestBody;
  headers: { get(name: string): string | null };
  maxAgeSeconds?: number;
  /** Unix seconds. Defaults to now; injectable for tests. */
  now?: number;
}

export type VerifyResult =
  | { ok: true; timestamp: number; nonce: string | null }
  | { ok: false; reason: "missing_headers" | "malformed" | "expired" | "bad_signature" };

/** Returns the headers to attach to the request. */
export async function signRequest(input: SignRequestInput): Promise<Record<string, string>> {
  const timestamp = input.timestamp ?? nowSeconds();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("timestamp must be a non-negative integer of unix seconds");
  }
  const nonce = input.nonce ?? null;
  if (nonce !== null) assertNonce(nonce);

  const key = await importHmacKey(input.secret, ["sign"]);
  const canonical = await canonicalString(input.method, input.path, timestamp, nonce, input.body);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(canonical)));

  const headers: Record<string, string> = {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: SIGNATURE_PREFIX + toHex(mac),
  };
  if (nonce !== null) headers[NONCE_HEADER] = nonce;
  return headers;
}

export async function verifyRequest(input: VerifyRequestInput): Promise<VerifyResult> {
  const signatureHeader = input.headers.get(SIGNATURE_HEADER);
  const timestampHeader = input.headers.get(TIMESTAMP_HEADER);
  if (signatureHeader === null || timestampHeader === null) {
    return { ok: false, reason: "missing_headers" };
  }

  if (!/^\d{1,15}$/.test(timestampHeader) || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: "malformed" };
  }
  const mac = fromHex(signatureHeader.slice(SIGNATURE_PREFIX.length));
  if (mac === null || mac.length !== 32) return { ok: false, reason: "malformed" };

  const nonce = input.headers.get(NONCE_HEADER);
  if (nonce !== null && !isValidNonce(nonce)) return { ok: false, reason: "malformed" };

  const timestamp = Number(timestampHeader);
  const maxAge = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (Math.abs((input.now ?? nowSeconds()) - timestamp) > maxAge) {
    return { ok: false, reason: "expired" };
  }

  const key = await importHmacKey(input.secret, ["verify"]);
  const canonical = await canonicalString(input.method, input.path, timestamp, nonce, input.body);
  // subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", key, mac, utf8(canonical));
  return valid ? { ok: true, timestamp, nonce } : { ok: false, reason: "bad_signature" };
}

async function canonicalString(
  method: string,
  path: string,
  timestamp: number,
  nonce: string | null,
  body: RequestBody,
): Promise<string> {
  if (/[\r\n]/.test(method) || /[\r\n]/.test(path)) {
    throw new TypeError("method and path must not contain line breaks");
  }
  const bytes = typeof body === "string" ? utf8(body) : (body ?? new Uint8Array());
  const bodyHash = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  return [VERSION, method.toUpperCase(), path, String(timestamp), nonce ?? "", bodyHash].join("\n");
}

async function importHmacKey(secret: string, usages: ["sign"] | ["verify"]) {
  const raw = utf8(secret);
  if (raw.length < MIN_SECRET_BYTES) {
    throw new TypeError(`HMAC secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function isValidNonce(nonce: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(nonce);
}

function assertNonce(nonce: string): void {
  if (!isValidNonce(nonce)) {
    throw new TypeError("nonce must be 16-128 characters of [A-Za-z0-9_-]");
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
