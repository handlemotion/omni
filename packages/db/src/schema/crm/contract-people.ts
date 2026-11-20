import { index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { createdAt, orgId } from "../columns.ts";
import { crmContracts } from "../crm.ts";

/**
 * Who on the workspace a contract involves: teammates working it, or the freelancer it is with. A
 * freelancer sees only the contracts they are involved in (`docs/spec/crm.md`, "Project access").
 */
export const crmContractPeople = pgTable(
  "crm_contract_people",
  {
    contractId: text("contract_id")
      .notNull()
      .references(() => crmContracts.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    orgId: orgId(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.contractId, t.memberId] }),
    index("crm_contract_people_member_id_idx").on(t.memberId),
  ],
);
