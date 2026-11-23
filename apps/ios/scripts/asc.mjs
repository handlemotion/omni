import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
const { ASC_KEY_PATH: KEY_PATH, ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER } = process.env;
const b64 = (b) => Buffer.from(b).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" }));
const body = b64(
  JSON.stringify({ iss: ISSUER, iat: now, exp: now + 900, aud: "appstoreconnect-v1" }),
);
const sig = sign("sha256", Buffer.from(`${head}.${body}`), {
  key: createPrivateKey(readFileSync(KEY_PATH)),
  dsaEncoding: "ieee-p1363",
});
const token = `${head}.${body}.${b64(sig)}`;
const NO_CONTENT = 204;
export const api = async (path, init = {}) => {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const j = r.status === NO_CONTENT ? {} : await r.json();
  if (!r.ok)
    throw new Error(
      `${r.status} ${path}: ${JSON.stringify(j.errors?.map((e) => e.detail ?? e.title))}`,
    );
  return j;
};
