import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { createdAt, id, orgId, timestamptz, updatedAt } from "../columns.ts";
import { crmDeals } from "../crm.ts";
import { storageNodes } from "../storage.ts";

const memberRef = (name: string) =>
  text(name).references(() => members.id, { onDelete: "set null" });

/**
 * How far someone outside the team reaches into one project (`docs/spec/crm.md`, "Project
 * access"): a `freelancer` works on it in the app, a `client` sees it on the portal.
 */
export const crmProjectScope = pgEnum("crm_project_scope", ["freelancer", "client"]);

/**
 * Someone added to one project (a deal) by address, so they can be added before they have an
 * account. Teammates are never rows here: they see every project.
 */
export const crmProjectMembers = pgTable(
  "crm_project_members",
  {
    id: id(),
    orgId: orgId(),
    dealId: text("deal_id").notNull(),
    /** Lowercase. */
    email: text("email").notNull(),
    scope: crmProjectScope("scope").notNull(),
    addedByMemberId: memberRef("added_by_member_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "crm_project_members_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    unique("crm_project_members_deal_email_unique").on(t.dealId, t.email),
    index("crm_project_members_email_idx").on(t.email),
    index("crm_project_members_added_by_member_id_idx").on(t.addedByMemberId),
  ],
);

export const crmMilestoneStatus = pgEnum("crm_milestone_status", [
  "planned",
  "in_progress",
  "done",
]);

/** A checkpoint on a project, in the order the team set, with a target day. */
export const crmMilestones = pgTable(
  "crm_milestones",
  {
    id: id(),
    orgId: orgId(),
    dealId: text("deal_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** A day, not a moment: the same on every client. */
    targetOn: date("target_on", { mode: "string" }),
    status: crmMilestoneStatus("status").notNull().default("planned"),
    position: integer("position").notNull().default(0),
    completedAt: timestamptz("completed_at"),
    createdByMemberId: memberRef("created_by_member_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "crm_milestones_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    index("crm_milestones_deal_position_idx").on(t.dealId, t.position, t.id),
    index("crm_milestones_created_by_member_id_idx").on(t.createdByMemberId),
  ],
);

export const crmDeliverableStatus = pgEnum("crm_deliverable_status", [
  "draft",
  "in_review",
  "approved",
  "changes_requested",
]);

/**
 * Something the project hands over, maybe under a milestone and maybe a Drive file. The client
 * sees it on the portal once `client_visible`, and approves it or asks for changes while it is
 * `in_review`.
 */
export const crmDeliverables = pgTable(
  "crm_deliverables",
  {
    id: id(),
    orgId: orgId(),
    dealId: text("deal_id").notNull(),
    /** A milestone on the same deal: the Worker checks it, since a composite key can't null one column. */
    milestoneId: text("milestone_id").references(() => crmMilestones.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    nodeId: text("node_id").references(() => storageNodes.id, { onDelete: "set null" }),
    dueOn: date("due_on", { mode: "string" }),
    status: crmDeliverableStatus("status").notNull().default("draft"),
    clientVisible: boolean("client_visible").notNull().default(false),
    /** The client's words with their last answer: why changes are needed, or a thank-you. */
    reviewNote: text("review_note"),
    reviewedAt: timestamptz("reviewed_at"),
    /** The address that approved or asked for changes. */
    reviewedByEmail: text("reviewed_by_email"),
    createdByMemberId: memberRef("created_by_member_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "crm_deliverables_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    index("crm_deliverables_deal_idx").on(t.dealId, t.createdAt, t.id),
    index("crm_deliverables_milestone_id_idx")
      .on(t.milestoneId)
      .where(sql`${t.milestoneId} is not null`),
    index("crm_deliverables_node_id_idx")
      .on(t.nodeId)
      .where(sql`${t.nodeId} is not null`),
    index("crm_deliverables_created_by_member_id_idx").on(t.createdByMemberId),
  ],
);

/**
 * A project's client portal: the folder in the project's Drive folder that its clients read
 * (`Client`), made when the first client is added.
 */
export const crmPortals = pgTable(
  "crm_portals",
  {
    dealId: text("deal_id").primaryKey(),
    orgId: orgId(),
    folderNodeId: text("folder_node_id").references(() => storageNodes.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "crm_portals_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    index("crm_portals_folder_node_id_idx").on(t.folderNodeId),
  ],
);
