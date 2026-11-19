import { writeFileSync } from "node:fs";
import { api } from "./asc.mjs";
const { OMNI_IOS_BUNDLE_ID: BUNDLE, CERT_SERIAL: SERIAL, PROFILES_DIR: OUT_DIR } = process.env;
const bundle = (await api(`/v1/bundleIds?filter[identifier]=${BUNDLE}`)).data.find(
  (b) => b.attributes.identifier === BUNDLE,
);
if (!bundle) throw new Error("bundle id not registered");
const certs = (
  await api(`/v1/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=50`)
).data;
const cert = certs.find((c) => c.attributes.serialNumber.toUpperCase() === SERIAL.toUpperCase());
if (!cert) throw new Error(`certificate ${SERIAL} not found among ${certs.length}`);
const active = (await api(`/v1/bundleIds/${bundle.id}/profiles?limit=50`)).data.filter(
  (p) => p.attributes.profileType === "IOS_APP_STORE" && p.attributes.profileState === "ACTIVE",
);
let existing;
for (const p of active) {
  const holds = (await api(`/v1/profiles/${p.id}/relationships/certificates?limit=50`)).data;
  if (holds.some((c) => c.id === cert.id)) {
    existing = p;
    break;
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
