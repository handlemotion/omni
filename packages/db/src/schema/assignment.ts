import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { members, organizations } from "./auth.ts";

export const memberRoleDescriptions = pgTable(
  "member_role_descriptions",
  {
    memberId: text("member_id")
      .primaryKey()
      .references(() => members.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("member_role_descriptions_org_idx").on(t.orgId)],
);
