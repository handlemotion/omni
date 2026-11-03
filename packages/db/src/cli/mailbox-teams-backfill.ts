// Gives every shared mailbox without a Better Auth team its team, seeded from its current
// `mailbox_access` grants (ADR 0008): `pnpm --filter @omni/db mailbox-teams:backfill`.
// Idempotent: a mailbox that has a team is skipped, so a second run links nothing.
import { join } from "node:path";
import { createDb } from "../client.ts";
import { readDatabaseUrl } from "../env.ts";
import { backfillMailboxTeams } from "../mailbox-teams.ts";

const { db, close } = createDb(readDatabaseUrl(join(import.meta.dirname, "../..")), {
  onnotice: () => {},
});
try {
  process.stdout.write(`${JSON.stringify(await backfillMailboxTeams(db))}\n`);
} finally {
  await close();
}
