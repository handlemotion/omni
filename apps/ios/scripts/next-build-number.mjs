import { api } from "./asc.mjs";
const BUNDLE = process.env.OMNI_IOS_BUNDLE_ID;
const app = (await api(`/v1/apps?filter[bundleId]=${BUNDLE}&limit=1`)).data[0];
if (!app) throw new Error(`no App Store Connect app for ${BUNDLE}`);
const builds = (
  await api(`/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=50&fields[builds]=version`)
).data;
const highest = Math.max(0, ...builds.map((b) => Number.parseInt(b.attributes.version, 10) || 0));
process.stdout.write(`${highest + 1}\n`);
