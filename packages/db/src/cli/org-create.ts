// Creates the first organization and its owner: `pnpm --filter @omni/db org:create -- ...`.
// Self-serve sign-up is off (members join by invitation), so this is how an install starts.
// Idempotent: the organization is keyed by slug, the user by email, and a second run with the
// same arguments prints the same ids and changes nothing.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createDb } from "../client.ts";
import { readDatabaseUrl } from "../env.ts";
import { createOrgWithOwner, slugify } from "../orgs.ts";

const USAGE = `Usage: org:create --name <organization name> --owner <email> [options]

  --slug <slug>         default derived from --name
  --owner-name <name>   display name for a new owner user; default the email's local part
Prints {"orgId", "name", "slug", "userId", "memberId"} as JSON.`;

function fail(message: string): never {
  console.error(`org:create: ${message}`);
  process.exit(1);
}

// `pnpm org:create -- --name ...` forwards the `--` itself; drop it.
const argv = process.argv.slice(2);
const { values } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    name: { type: "string" },
    owner: { type: "string" },
    slug: { type: "string" },
    "owner-name": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const name = values.name?.trim();
if (!name || !values.owner) fail(`missing arguments\n\n${USAGE}`);
if (!z.email().safeParse(values.owner).success) fail(`--owner is not an email: ${values.owner}`);
const slug = values.slug ?? slugify(name);
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) fail(`bad slug "${slug}": use a-z, 0-9 and dashes`);

const databaseUrl = (() => {
  try {
    return readDatabaseUrl(join(import.meta.dirname, "../.."));
  } catch (error) {
    return fail((error as Error).message);
  }
})();

const { db, close } = createDb(databaseUrl, { onnotice: () => {} });
try {
  const result = await createOrgWithOwner(db, {
    name,
    slug,
    ownerEmail: values.owner,
    ownerName: values["owner-name"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await close();
}
