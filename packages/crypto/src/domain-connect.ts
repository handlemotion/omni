// Domain Connect request signing (https://github.com/Domain-Connect/spec, "Security
// Considerations"). A template with `syncPubKeyDomain` makes the DNS host verify the apply URL's
// query string against a public key published in our DNS: RSA PKCS#1 v1.5 with SHA-256, base64.
import { fromBase64 } from "./encoding.ts";

/** Signs the exact query string (everything after `?`, before `&sig=`). Key: PKCS#8 PEM. */
export async function signDomainConnectQuery(
  query: string,
  privateKeyPem: string,
): Promise<string> {
  const body = privateKeyPem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const der = fromBase64(body);
  if (!der) throw new Error("DOMAIN_CONNECT_PRIVATE_KEY is not a PKCS#8 PEM key");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(query),
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
