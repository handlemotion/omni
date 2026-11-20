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
    uniqueIndex("user_emails_email_key").on(sql`lower(${table.email})`),
    index("user_emails_user_id_idx").on(table.userId),
  ],
);

/**
 * Which organization is a person's Personal space: one per person, holding the mail
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
 * A session opened with a company's address: it reaches only that company.
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

/**
 * Someone who signed in with an address on a company's claimed domain but is not its member
 * asked to join it. Owners and admins accept, which adds them as a member,
 * or decline; either way the row goes. One request per person per company.
 */
export const joinRequests = pgTable(
  "join_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("join_requests_org_user_key").on(table.orgId, table.userId)],
);

/**
 * The workspace a person picked on the MCP consent screen, for this session's next
 * OAuth grant: `org_id` null means every workspace. Read when the grant is made, then kept only
 * until the session goes. Kept here, not on Better Auth's `sessions`, so its schema is unchanged.
 */
export const oauthWorkspaceChoices = pgTable("oauth_workspace_choices", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  orgId: text("org_id").references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
