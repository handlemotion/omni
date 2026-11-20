import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { createdAt, id, orgId } from "../columns.ts";
import { crmCompanies, crmDeals } from "../crm.ts";
import { storageNodes } from "../storage.ts";

/**
 * A Drive file or folder linked to a company or a deal, where it already lives (`docs/spec/crm.md`, "Keep the files"): a
 * reference, like a symlink, not a copy and not a move. Each member sees the links whose node
 * they can open in Drive. Deleting the node for good, or the record, takes the link with it.
 */
export const crmFileLinks = pgTable(
  "crm_file_links",
  {
    id: id(),
    orgId: orgId(),
    companyId: text("company_id"),
    dealId: text("deal_id"),
    nodeId: text("node_id")
      .notNull()
      .references(() => storageNodes.id, { onDelete: "cascade" }),
    addedByMemberId: text("added_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "crm_file_links_company_org_fk",
      columns: [t.companyId, t.orgId],
      foreignColumns: [crmCompanies.id, crmCompanies.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "crm_file_links_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    check("crm_file_links_one_record", sql`num_nonnulls(${t.companyId}, ${t.dealId}) = 1`),
    uniqueIndex("crm_file_links_company_node_idx")
      .on(t.companyId, t.nodeId)
      .where(sql`${t.companyId} is not null`),
    uniqueIndex("crm_file_links_deal_node_idx")
      .on(t.dealId, t.nodeId)
      .where(sql`${t.dealId} is not null`),
    index("crm_file_links_node_id_idx").on(t.nodeId),
    index("crm_file_links_added_by_member_id_idx").on(t.addedByMemberId),
  ],
);
