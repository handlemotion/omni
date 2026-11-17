import { join } from "node:path";
import { createDb } from "../client.ts";
import { readDatabaseUrl } from "../env.ts";
import { backfillMailboxTeams } from "../mail.ts";

const { db, close } = createDb(readDatabaseUrl(join(import.meta.dirname, "../..")), {
  onnotice: () => {},
});
try {
  process.stdout.write(`${JSON.stringify(await backfillMailboxTeams(db))}\n`);
} finally {
  await close();
}
