import { describe, expect, it } from "vitest";
import {
  CredentialError,
  decryptCredential,
  encryptCredential,
  needsReencryption,
  parseKeyring,
  type Keyring,
} from "./index.ts";

const keyA = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const keyB = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const ring: Keyring = { currentKeyId: "k1", keys: { k1: keyA } };
const password = "app-pässwörd-🔑-0123";

describe("credential encryption", () => {
  it("round-trips and never reuses an IV", async () => {
    const first = await encryptCredential(ring, password, "mbx_1");
    const second = await encryptCredential(ring, password, "mbx_1");
    expect(first).not.toBe(second);
    expect(first).not.toContain(password);
    expect(await decryptCredential(ring, first, "mbx_1")).toBe(password);
  });

  it("refuses a ciphertext moved to another mailbox row", async () => {
    const envelope = await encryptCredential(ring, password, "mbx_1");
    await expect(decryptCredential(ring, envelope, "mbx_2")).rejects.toThrow(CredentialError);
  });

  it("refuses the wrong key under the same key id", async () => {
    const envelope = await encryptCredential(ring, password, "mbx_1");
    const wrong: Keyring = { currentKeyId: "k1", keys: { k1: keyB } };
    await expect(decryptCredential(wrong, envelope, "mbx_1")).rejects.toThrow(CredentialError);
  });

  it("refuses a tampered ciphertext", async () => {
    const envelope = await encryptCredential(ring, password, "mbx_1");
    const parts = envelope.split(".");
    const last = parts[3] ?? "";
    parts[3] = (last[0] === "A" ? "B" : "A") + last.slice(1);
    await expect(decryptCredential(ring, parts.join("."), "mbx_1")).rejects.toThrow(
      CredentialError,
    );
  });

  it("refuses an envelope relabelled with another key id", async () => {
    // Both ids hold the same bytes, so only the key id bound into the AAD can catch this.
    const twins: Keyring = { currentKeyId: "k1", keys: { k1: keyA, k2: keyA } };
    const envelope = await encryptCredential(twins, password, "mbx_1");
    const relabelled = envelope.replace(/^v1\.k1\./, "v1.k2.");
    await expect(decryptCredential(twins, relabelled, "mbx_1")).rejects.toThrow(CredentialError);
  });

  it("decrypts old envelopes by key id after rotation and flags them for rewrite", async () => {
    const old = await encryptCredential(ring, password, "mbx_1");
    const rotated = parseKeyring(`k2:${keyB},k1:${keyA}`);

    expect(await decryptCredential(rotated, old, "mbx_1")).toBe(password);
    expect(needsReencryption(rotated, old)).toBe(true);

    const fresh = await encryptCredential(rotated, password, "mbx_1");
    expect(needsReencryption(rotated, fresh)).toBe(false);
    await expect(decryptCredential(ring, fresh, "mbx_1")).rejects.toThrow(CredentialError);
  });

  it("rejects keyrings with keys that are not 256-bit", () => {
    expect(() => parseKeyring(`k1:${btoa("too short")}`)).toThrow(TypeError);
    expect(() => parseKeyring(`k1:${keyA},k1:${keyB}`)).toThrow(TypeError);
  });
});
