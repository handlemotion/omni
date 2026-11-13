// A person's extra sign-in addresses (ADR 0014). The primary stays `users.email`, which Better
// Auth owns; each row here is another address the person proved they read, by a link sent to it.
// Per person, not per org, like `users`, `accounts` and `passkeys`: no `org_id`.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { organizations, sessions, users } from "./auth.ts";

export const userEmails = pgTable(
  "user_emails",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Lowercase. Only verified addresses are stored; a pending one lives in `verifications`. */
    email: text("email").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One person per address: a second claim fails here even if two verifications race.
    uniqueIndex("user_emails_email_key").on(sql`lower(${table.email})`),
    index("user_emails_user_id_idx").on(table.userId),
  ],
);

/**
 * Which organization is a person's Personal space (ADR 0024): one per person, holding the mail
 * accounts they connect themselves. Kept here, not as a column on Better Auth's `organizations`,
 * so the auth schema is unchanged. An organization with no row is a company.
 */
export const personalSpaces = pgTable("personal_spaces", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A session opened with a company's address (ADR 0024 decision 3): it reaches only that company.
 * A session with no row is unscoped (a passkey, or an address no company has claimed). Kept here,
 * not as a column on Better Auth's `sessions`, so the auth schema is unchanged.
 */
export const sessionScopes = pgTable("session_scopes", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
