// AES-256-GCM encryption for mailbox app passwords (`mailboxes.credentials_enc`).
//
// Envelope: `v1.<keyId>.<iv>.<ciphertext>`, each binary part base64url without padding. The IV
// is 96 random bits per encryption. The ciphertext includes GCM's 128-bit tag.
//
// Associated data is `v1.<keyId>.<aad>`, where callers pass the mailbox id as `aad`. A ciphertext
// copied to another mailbox row, or relabelled with another key id, fails to decrypt.
//
// Rotation: add a new key to the keyring and make it current. New writes use it; old envelopes
// still decrypt by their key id. `needsReencryption` finds rows to rewrite before the old key
// is removed.

import { fromBase64, fromUtf8, toBase64Url, utf8 } from "./encoding.ts";

export interface Keyring {
  /** Key id used for new encryptions. */
  currentKeyId: string;
  /** Key id -> base64 of 32 random bytes. */
  keys: Readonly<Record<string, string>>;
}

/** Thrown for any decrypt failure. Deliberately says nothing about which check failed. */
export class CredentialError extends Error {
  override name = "CredentialError";
}

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export async function encryptCredential(
  keyring: Keyring,
  plaintext: string,
  aad: string,
): Promise<string> {
  assertAad(aad);
  const keyId = keyring.currentKeyId;
  const key = await importKey(keyring, keyId, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(keyId, aad) },
    key,
    utf8(plaintext),
  );
  return [VERSION, keyId, toBase64Url(iv), toBase64Url(new Uint8Array(ciphertext))].join(".");
}

export async function decryptCredential(
  keyring: Keyring,
  envelope: string,
  aad: string,
): Promise<string> {
  assertAad(aad);
  const { keyId, iv, ciphertext } = parseEnvelope(envelope);
  if (!(keyId in keyring.keys)) throw new CredentialError("unknown credential key id");
  const key = await importKey(keyring, keyId, "decrypt");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(keyId, aad) },
      key,
      ciphertext,
    );
    return fromUtf8(new Uint8Array(plaintext));
  } catch {
    throw new CredentialError("credential failed to decrypt");
  }
}

/** True when the envelope was written with a key other than the current one. */
export function needsReencryption(keyring: Keyring, envelope: string): boolean {
  return parseEnvelope(envelope).keyId !== keyring.currentKeyId;
}

/**
 * Parses a keyring from a secret such as `k2:<base64>,k1:<base64>`. The first entry is current.
 * Throws on malformed ids, duplicate ids, or keys that are not exactly 32 bytes.
 */
export function parseKeyring(value: string): Keyring {
  const keys: Record<string, string> = {};
  let currentKeyId: string | undefined;
  for (const entry of value.split(",")) {
    const [id, key, ...rest] = entry.trim().split(":");
    if (id === undefined || key === undefined || rest.length > 0 || !KEY_ID.test(id)) {
      throw new TypeError("keyring entries must look like <keyId>:<base64 key>");
    }
    if (id in keys) throw new TypeError(`duplicate key id ${id}`);
    if (fromBase64(key)?.length !== KEY_BYTES) {
      throw new TypeError(`key ${id} must be ${KEY_BYTES} bytes of base64`);
    }
    keys[id] = key;
    currentKeyId ??= id;
  }
  if (currentKeyId === undefined) throw new TypeError("keyring is empty");
  return { currentKeyId, keys };
}

function parseEnvelope(envelope: string) {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION || !KEY_ID.test(parts[1] ?? "")) {
    throw new CredentialError("malformed credential envelope");
  }
  const iv = fromBase64(parts[2] ?? "");
  const ciphertext = fromBase64(parts[3] ?? "");
  if (iv?.length !== IV_BYTES || ciphertext === null || ciphertext.length < 16) {
    throw new CredentialError("malformed credential envelope");
  }
  return { keyId: parts[1] as string, iv, ciphertext };
}

async function importKey(keyring: Keyring, keyId: string, usage: "encrypt" | "decrypt") {
  const encoded = keyring.keys[keyId];
  if (encoded === undefined) throw new TypeError(`keyring has no key ${keyId}`);
  const raw = fromBase64(encoded);
  if (raw?.length !== KEY_BYTES) throw new TypeError(`key ${keyId} must be ${KEY_BYTES} bytes`);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

function associatedData(keyId: string, aad: string) {
  return utf8(`${VERSION}.${keyId}.${aad}`);
}

function assertAad(aad: string): void {
  if (aad.length === 0) throw new TypeError("aad (the mailbox id) is required");
}
