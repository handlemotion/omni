import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, expect, test } from "vitest";
import { createDb } from "../src/client.ts";
import { createEmptyDatabase, migrationsFolder } from "./support.ts";

const empty = await createEmptyDatabase();
const { db, close } = createDb(empty.url, { onnotice: () => {} });
afterAll(async () => {
  await close();
  await empty.drop();
});

test("migrations apply to an empty database and a second run is a no-op", async () => {
  await migrate(db, { migrationsFolder });
  await migrate(db, { migrationsFolder });

  const tables = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  );
  expect(tables.map((t) => t.table_name).toSorted()).toEqual(
    [
      "accounts",
      "ai_usage",
      "assignments",
      "attachments",
      "dead_letters",
      "invitations",
      "mail_actions",
      "mail_domains",
      "mailbox_access",
      "mailbox_folders",
      "mailboxes",
      "members",
      "message_locations",
      "messages",
      "organizations",
      "passkeys",
      "push_tokens",
      "sessions",
      "team_members",
      "teams",
      "thread_state",
      "threads",
      "triage_feedback",
      "users",
      "verifications",
    ].toSorted(),
  );
});
