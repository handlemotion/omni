// What each member handles, in the workspace's own words (ADR 0033). Triage reads it to hand a
// customer's message to the teammate whose role covers it. One per member; a member with none is
// never assigned by AI.
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
  // Writes check the member belongs to `org_id` (`setMemberRoleDescription`).
  (t) => [index("member_role_descriptions_org_idx").on(t.orgId)],
);
