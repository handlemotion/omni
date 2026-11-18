import { createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const { ASC_KEY_PATH: KEY_PATH, ASC_KEY_ID: KEY_ID, ASC_ISSUER_ID: ISSUER } = process.env;
const { OMNI_IOS_BUNDLE_ID: BUNDLE, CERT_SERIAL: SERIAL, PROFILES_DIR: OUT_DIR } = process.env;
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
const api = async (path, init = {}) => {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  const j = await r.json();
  if (!r.ok)
    throw new Error(
      `${r.status} ${path}: ${JSON.stringify(j.errors?.map((e) => e.detail ?? e.title))}`,
    );
  return j;
};
const bundle = (await api(`/v1/bundleIds?filter[identifier]=${BUNDLE}`)).data.find(
  (b) => b.attributes.identifier === BUNDLE,
);
if (!bundle) throw new Error("bundle id not registered");
const certs = (
  await api(`/v1/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=50`)
).data;
const cert = certs.find((c) => c.attributes.serialNumber.toUpperCase() === SERIAL.toUpperCase());
if (!cert) throw new Error(`certificate ${SERIAL} not found among ${certs.length}`);
const existing = (await api(`/v1/bundleIds/${bundle.id}/profiles?limit=50`)).data.find(
  (p) => p.attributes.profileType === "IOS_APP_STORE" && p.attributes.profileState === "ACTIVE",
);
const profile =
  existing ??
  (
    await api("/v1/profiles", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "profiles",
          attributes: { name: "Omni App Store", profileType: "IOS_APP_STORE" },
          relationships: {
            bundleId: { data: { type: "bundleIds", id: bundle.id } },
            certificates: { data: [{ type: "certificates", id: cert.id }] },
          },
        },
      }),
    })
  ).data;
writeFileSync(
  `${OUT_DIR}/${profile.attributes.uuid}.mobileprovision`,
  Buffer.from(profile.attributes.profileContent, "base64"),
);
console.error(`${existing ? "reused" : "created"} profile "${profile.attributes.name}"`);
process.stdout.write(`${profile.attributes.uuid}\n`);
