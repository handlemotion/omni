import { describe, expect, it } from "vitest";
import { decodeBase64, randomToken, sha256Hex, toBase64, toBase64Url } from "./index.ts";

describe("encoders", () => {
  it("hashes text and its bytes to the same SHA-256 hex", async () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("abc")).toBe(abc);
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(abc);
  });

  it("writes base64url without padding or URL-unsafe characters", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x01]);
    expect(toBase64(bytes)).toBe("+/+/AQ==");
    expect(toBase64Url(bytes)).toBe("-_-_AQ");
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("encodes inputs larger than one chunk like Node does", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("decodes what toBase64 wrote, byte for byte", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(decodeBase64(toBase64(bytes))).toEqual(bytes);
    expect(decodeBase64("")).toEqual(new Uint8Array());
  });

  it("throws atob's error on text that is not standard base64", () => {
    for (const bad of ["-_-_AQ", "AQ=A", "A", "@@@@"]) {
      expect(() => decodeBase64(bad)).toThrow(
        expect.objectContaining({ name: "InvalidCharacterError" }),
      );
    }
  });
});
