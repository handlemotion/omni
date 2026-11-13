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
      "audit_events",
      "domain_claims",
      "dead_letters",
      "invitations",
      "join_requests",
      "mail_actions",
      "mail_domains",
      "mailbox_access",
      "mailbox_folders",
      "mailboxes",
      "members",
      "message_locations",
      "messages",
      "org_setup",
      "organizations",
      "passkeys",
      "pending_mail_events",
      "personal_spaces",
      "push_tokens",
      "session_scopes",
      "sessions",
      "stripe_events",
      "subscriptions",
      "team_members",
      "teams",
      "thread_state",
      "threads",
      "triage_feedback",
      "triage_usage",
      "trial_claims",
      "user_emails",
      "users",
      "verifications",
      // Helpdesk (ADR 0021).
      "business_hours",
      "canned_replies",
      "conversation_events",
      "customers",
      "drafts",
      "member_preferences",
      "notes",
      "notifications",
      "signatures",
      "sla_policies",
      "tags",
      "thread_tags",
      "uploads",
    ].toSorted(),
  );
});
