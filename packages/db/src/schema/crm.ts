import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { members, organizations } from "./auth.ts";
import { storageNodes } from "./storage.ts";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

const createdAt = () =>
  timestamptz("created_at")
    .notNull()
    .defaultNow()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

const memberRef = (name: string) =>
  text(name).references(() => members.id, { onDelete: "set null" });

const folderRef = (name: string) =>
  text(name).references(() => storageNodes.id, { onDelete: "set null" });

/** What a stage means; its name is the workspace's. Code reads the kind, never the name. */
export const crmStageKind = pgEnum("crm_stage_kind", ["open", "won", "done", "lost"]);
export const crmContractStatus = pgEnum("crm_contract_status", [
  "draft",
  "sent",
  "signed",
  "ended",
]);

export const crmCompanies = pgTable(
  "crm_companies",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    /** Who on the team looks after it. */
    ownerMemberId: memberRef("owner_member_id"),
    folderNodeId: folderRef("folder_node_id"),
    createdByMemberId: memberRef("created_by_member_id"),
    archivedAt: timestamptz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("crm_companies_id_org_id_unique").on(t.id, t.orgId),
    index("crm_companies_name_idx").on(t.orgId, sql`lower(${t.name})`, t.id),
    index("crm_companies_updated_at_idx").on(t.orgId, t.updatedAt, t.id),
    index("crm_companies_owner_member_id_idx").on(t.ownerMemberId),
  ],
);

/** A domain is one company's in a workspace. Webmail domains are refused by the door. */
export const crmCompanyDomains = pgTable(
  "crm_company_domains",
  {
    orgId: orgId(),
    companyId: text("company_id").notNull(),
    /** Lowercase, no trailing dot. */
    domain: text("domain").notNull(),
  },
  (t) => [
    primaryKey({ name: "crm_company_domains_org_id_domain_pk", columns: [t.orgId, t.domain] }),
    foreignKey({
      name: "crm_company_domains_company_org_fk",
      columns: [t.companyId, t.orgId],
      foreignColumns: [crmCompanies.id, crmCompanies.orgId],
    }).onDelete("cascade"),
    index("crm_company_domains_company_id_idx").on(t.companyId),
  ],
);

export const crmPeople = pgTable(
  "crm_people",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    /** One company per person. Deleting the company leaves the person without one. */
    companyId: text("company_id").references(() => crmCompanies.id, { onDelete: "set null" }),
    jobTitle: text("job_title"),
    phone: text("phone"),
    /** Who on the team looks after them. */
    ownerMemberId: memberRef("owner_member_id"),
    createdByMemberId: memberRef("created_by_member_id"),
    archivedAt: timestamptz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("crm_people_id_org_id_unique").on(t.id, t.orgId),
    index("crm_people_name_idx").on(t.orgId, sql`lower(${t.name})`, t.id),
    index("crm_people_company_id_idx").on(t.companyId),
    index("crm_people_updated_at_idx").on(t.orgId, t.updatedAt, t.id),
    index("crm_people_owner_member_id_idx").on(t.ownerMemberId),
  ],
);

/** An address is one person in a workspace: the key mail joins on. */
export const crmPersonEmails = pgTable(
  "crm_person_emails",
  {
    orgId: orgId(),
    personId: text("person_id").notNull(),
    /** Lowercase, as `normalizeAddress` gives it. */
    address: text("address").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [
    primaryKey({ name: "crm_person_emails_org_id_address_pk", columns: [t.orgId, t.address] }),
    foreignKey({
      name: "crm_person_emails_person_org_fk",
      columns: [t.personId, t.orgId],
      foreignColumns: [crmPeople.id, crmPeople.orgId],
    }).onDelete("cascade"),
    index("crm_person_emails_person_id_idx").on(t.personId),
    uniqueIndex("crm_person_emails_primary_key")
      .on(t.personId)
      .where(sql`${t.isPrimary}`),
  ],
);

/** The workspace's one pipeline, in `position` order. Seeded on first use. */
export const crmStages = pgTable(
  "crm_stages",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    kind: crmStageKind("kind").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    unique("crm_stages_id_org_id_unique").on(t.id, t.orgId),
    index("crm_stages_org_id_position_idx").on(t.orgId, t.position),
  ],
);

export const crmDeals = pgTable(
  "crm_deals",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    companyId: text("company_id").references(() => crmCompanies.id, { onDelete: "set null" }),
    stageId: text("stage_id").notNull(),
    stageEnteredAt: timestamptz("stage_entered_at").notNull(),
    ownerMemberId: memberRef("owner_member_id"),
    /** In the currency's minor unit (cents for USD). */
    valueMinor: bigint("value_minor", { mode: "number" }),
    /** ISO 4217, uppercase. */
    valueCurrency: text("value_currency"),
    /** First entry into a `won` stage; never reset. */
    wonAt: timestamptz("won_at"),
    /** Set while the deal sits in a `done` or `lost` stage. */
    closedAt: timestamptz("closed_at"),
    /** When the team expects it to close. */
    expectedCloseOn: date("expected_close_on", { mode: "string" }),
    folderNodeId: folderRef("folder_node_id"),
    createdByMemberId: memberRef("created_by_member_id"),
    archivedAt: timestamptz("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("crm_deals_id_org_id_unique").on(t.id, t.orgId),
    foreignKey({
      name: "crm_deals_stage_org_fk",
      columns: [t.stageId, t.orgId],
      foreignColumns: [crmStages.id, crmStages.orgId],
    }),
    check(
      "crm_deals_value_currency",
      sql`${t.valueMinor} is null or ${t.valueCurrency} is not null`,
    ),
    check("crm_deals_currency_format", sql`${t.valueCurrency} ~ '^[A-Z]{3}$'`),
    index("crm_deals_name_idx").on(t.orgId, sql`lower(${t.name})`, t.id),
    index("crm_deals_stage_id_idx").on(t.stageId),
    index("crm_deals_company_id_idx").on(t.companyId),
    index("crm_deals_owner_member_id_idx").on(t.ownerMemberId),
    index("crm_deals_updated_at_idx").on(t.orgId, t.updatedAt, t.id),
    index("crm_deals_value_idx").on(t.orgId, t.valueMinor, t.id),
    index("crm_deals_expected_close_on_idx").on(t.orgId, t.expectedCloseOn, t.id),
  ],
);

/** Who on the client's side is part of a deal. */
export const crmDealPeople = pgTable(
  "crm_deal_people",
  {
    orgId: orgId(),
    dealId: text("deal_id").notNull(),
    personId: text("person_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "crm_deal_people_deal_id_person_id_pk", columns: [t.dealId, t.personId] }),
    foreignKey({
      name: "crm_deal_people_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "crm_deal_people_person_org_fk",
      columns: [t.personId, t.orgId],
      foreignColumns: [crmPeople.id, crmPeople.orgId],
    }).onDelete("cascade"),
    index("crm_deal_people_person_id_idx").on(t.personId),
  ],
);

interface RecordLinkColumns {
  orgId: AnyPgColumn;
  companyId: AnyPgColumn;
  personId: AnyPgColumn;
  dealId: AnyPgColumn;
}

const recordLinks = (table: string, t: RecordLinkColumns) => [
  foreignKey({
    name: `${table}_company_org_fk`,
    columns: [t.companyId, t.orgId],
    foreignColumns: [crmCompanies.id, crmCompanies.orgId],
  }).onDelete("cascade"),
  foreignKey({
    name: `${table}_person_org_fk`,
    columns: [t.personId, t.orgId],
    foreignColumns: [crmPeople.id, crmPeople.orgId],
  }).onDelete("cascade"),
  foreignKey({
    name: `${table}_deal_org_fk`,
    columns: [t.dealId, t.orgId],
    foreignColumns: [crmDeals.id, crmDeals.orgId],
  }).onDelete("cascade"),
  check(`${table}_one_record`, sql`num_nonnulls(${t.companyId}, ${t.personId}, ${t.dealId}) = 1`),
];

/** Text on exactly one company, person or deal. */
export const crmNotes = pgTable(
  "crm_notes",
  {
    id: id(),
    orgId: orgId(),
    companyId: text("company_id"),
    personId: text("person_id"),
    dealId: text("deal_id"),
    body: text("body").notNull(),
    authorMemberId: memberRef("author_member_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...recordLinks("crm_notes", t),
    index("crm_notes_company_timeline_idx")
      .on(t.companyId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.companyId} is not null`),
    index("crm_notes_person_timeline_idx")
      .on(t.personId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.personId} is not null`),
    index("crm_notes_deal_timeline_idx")
      .on(t.dealId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.dealId} is not null`),
    index("crm_notes_author_member_id_idx").on(t.authorMemberId),
  ],
);

/** A contract on a deal or a company, with one file in that record's folder. */
export const crmContracts = pgTable(
  "crm_contracts",
  {
    id: id(),
    orgId: orgId(),
    companyId: text("company_id"),
    dealId: text("deal_id"),
    title: text("title").notNull(),
    status: crmContractStatus("status").notNull().default("draft"),
    /** Purging a draft's trashed file leaves the contract without one, never fails the purge. */
    documentNodeId: text("document_node_id").references(() => storageNodes.id, {
      onDelete: "set null",
    }),
    signedAt: timestamptz("signed_at"),
    effectiveOn: date("effective_on", { mode: "string" }),
    expiresOn: date("expires_on", { mode: "string" }),
    createdByMemberId: memberRef("created_by_member_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "crm_contracts_company_org_fk",
      columns: [t.companyId, t.orgId],
      foreignColumns: [crmCompanies.id, crmCompanies.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "crm_contracts_deal_org_fk",
      columns: [t.dealId, t.orgId],
      foreignColumns: [crmDeals.id, crmDeals.orgId],
    }).onDelete("cascade"),
    check("crm_contracts_record", sql`num_nonnulls(${t.companyId}, ${t.dealId}) >= 1`),
    index("crm_contracts_company_id_idx").on(t.companyId),
    index("crm_contracts_deal_id_idx").on(t.dealId),
  ],
);

/**
 * What happened to one record, appended in the transaction of the change it records (as
 * `conversation_events`). `data` stays small: ids, field names, from and to.
 */
export const crmEvents = pgTable(
  "crm_events",
  {
    id: id(),
    orgId: orgId(),
    companyId: text("company_id"),
    personId: text("person_id"),
    dealId: text("deal_id"),
    kind: text("kind").notNull(),
    actorMemberId: memberRef("actor_member_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /** Set by a caller that may run twice (a job, a retried move): the second write is refused. */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
  },
  (t) => [
    ...recordLinks("crm_events", t),
    unique("crm_events_org_id_dedupe_key_unique").on(t.orgId, t.dedupeKey),
    index("crm_events_company_timeline_idx")
      .on(t.companyId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.companyId} is not null`),
    index("crm_events_person_timeline_idx")
      .on(t.personId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.personId} is not null`),
    index("crm_events_deal_timeline_idx")
      .on(t.dealId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(sql`${t.dealId} is not null`),
    index("crm_events_actor_member_id_idx").on(t.actorMemberId),
  ],
);

/** One row per workspace, made on first use together with the starting stages. */
export const crmSettings = pgTable("crm_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** ISO 4217; the last currency the workspace used. */
  defaultCurrency: text("default_currency"),
  rootFolderNodeId: folderRef("root_folder_node_id"),
});
