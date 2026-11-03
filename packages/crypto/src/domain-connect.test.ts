import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signDomainConnectQuery } from "./index.ts";

describe("signDomainConnectQuery", () => {
  // DNS hosts verify with their own RSA code against the key we publish. A wrong algorithm,
  // encoding or signed text makes every "Set up automatically" fail at the host.
  it("produces an RSA-SHA256 signature that an independent verifier accepts", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const query = "domain=acme.com&challenge=omni-challenge%3Dabc&redirect_uri=https%3A%2F%2Fx";
    const sig = await signDomainConnectQuery(query, pem);
    const verify = (text: string) =>
      createVerify("RSA-SHA256").update(text).verify(publicKey, sig, "base64");
    expect(verify(query)).toBe(true);
    // Signed over the exact query: a host that sees one byte changed must refuse it.
    expect(verify(query.replace("acme", "acne"))).toBe(false);
  });

  it("refuses a key that is not PKCS#8 PEM instead of signing with garbage", async () => {
    await expect(signDomainConnectQuery("domain=a.com", "not a key!")).rejects.toThrow(/PKCS#8/);
  });
});
