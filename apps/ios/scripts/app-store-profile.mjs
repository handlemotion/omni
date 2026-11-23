import { writeFileSync } from "node:fs";
import { api } from "./asc.mjs";
const { OMNI_IOS_BUNDLE_ID: BUNDLE, CERT_SERIAL: SERIAL, PROFILES_DIR: OUT_DIR } = process.env;
const NAME = "Omni App Store";
const bundle = (await api(`/v1/bundleIds?filter[identifier]=${BUNDLE}`)).data.find(
  (b) => b.attributes.identifier === BUNDLE,
);
if (!bundle) throw new Error("bundle id not registered");
const certs = (
  await api(`/v1/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=50`)
).data;
const cert = certs.find((c) => c.attributes.serialNumber.toUpperCase() === SERIAL.toUpperCase());
if (!cert) throw new Error(`certificate ${SERIAL} not found among ${certs.length}`);

const BUILD_MARGIN_MS = 3600_000;
const usable = (p) =>
  p.attributes.profileState === "ACTIVE" &&
  Date.parse(p.attributes.expirationDate) > Date.now() + BUILD_MARGIN_MS;
const holdsCert = async (p) =>
  (await api(`/v1/profiles/${p.id}/relationships/certificates?limit=50`)).data.some(
    (c) => c.id === cert.id,
  );

let existing;
for (const p of (await api(`/v1/bundleIds/${bundle.id}/profiles?limit=200`)).data) {
  if (p.attributes.profileType === "IOS_APP_STORE" && usable(p) && (await holdsCert(p))) {
    existing = p;
    break;
  }
}

if (!existing) {
  const named = (await api(`/v1/profiles?filter[name]=${encodeURIComponent(NAME)}&limit=200`)).data;
  for (const stale of named.filter((p) => p.attributes.name === NAME)) {
    await api(`/v1/profiles/${stale.id}`, { method: "DELETE" });
    console.error(`deleted ${stale.attributes.profileState} profile "${NAME}" (${stale.id})`);
  }
}

const profile =
  existing ??
  (
    await api("/v1/profiles", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "profiles",
          attributes: { name: NAME, profileType: "IOS_APP_STORE" },
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
