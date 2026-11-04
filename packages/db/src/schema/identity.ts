// A person's extra sign-in addresses (ADR 0014). The primary stays `users.email`, which Better
// Auth owns; each row here is another address the person proved they read, by a link sent to it.
// Per person, not per org, like `users`, `accounts` and `passkeys`: no `org_id`.
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { users } from "./auth.ts";

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
