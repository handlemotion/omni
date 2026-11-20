import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { createdAt, id, orgId, timestamptz, updatedAt } from "../columns.ts";
import { crmCompanies, crmDeals, crmPeople } from "../crm.ts";

const memberRef = (name: string) =>
  text(name).references(() => members.id, { onDelete: "set null" });

/**
 * A to-do for the workspace, on at most one company, person or deal. Open while
 * `completed_at` is null. `due_at` is a moment: a client sends the end of the day it picked.
 */
export const crmTasks = pgTable(
  "crm_tasks",
  {
    id: id(),
    orgId: orgId(),
    title: text("title").notNull(),
    body: text("body"),
    /** Its checklist, in order: each step's own id, its text, and whether it is done. */
    subtasks: jsonb("subtasks")
      .$type<{ id: string; title: string; done: boolean }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    companyId: text("company_id"),
    personId: text("person_id"),
    dealId: text("deal_id"),
    assigneeMemberId: memberRef("assignee_member_id"),
    dueAt: timestamptz("due_at"),
    completedAt: timestamptz("completed_at"),
    completedByMemberId: memberRef("completed_by_member_id"),
    createdByMemberId: memberRef("created_by_member_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "crm_tasks_company_org_fk",
      columns: [t.companyId, t.orgId],
      foreignColumns: [crmCompanies.id, crmCompanies.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "crm_tasks_person_org_fk",
      columns: [t.personId, t.orgId],
      foreignColumns: [crmPeople.id, crmPeople.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "crm_tasks_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    check(
      "crm_tasks_at_most_one_record",
      sql`num_nonnulls(${t.companyId}, ${t.personId}, ${t.dealId}) <= 1`,
    ),
    index("crm_tasks_open_due_idx")
      .on(t.orgId, t.dueAt.asc().nullsLast(), t.id)
      .where(sql`${t.completedAt} is null`),
    index("crm_tasks_assignee_open_due_idx")
      .on(t.assigneeMemberId, t.dueAt.asc().nullsLast(), t.id)
      .where(sql`${t.completedAt} is null`),
    index("crm_tasks_done_idx")
      .on(t.orgId, t.completedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.completedAt} is not null`),
    index("crm_tasks_company_id_idx")
      .on(t.companyId)
      .where(sql`${t.companyId} is not null`),
    index("crm_tasks_person_id_idx")
      .on(t.personId)
      .where(sql`${t.personId} is not null`),
    index("crm_tasks_deal_id_idx")
      .on(t.dealId)
      .where(sql`${t.dealId} is not null`),
    index("crm_tasks_completed_by_member_id_idx").on(t.completedByMemberId),
    index("crm_tasks_created_by_member_id_idx").on(t.createdByMemberId),
  ],
);
