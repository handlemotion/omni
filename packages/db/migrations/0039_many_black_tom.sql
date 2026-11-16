CREATE TYPE "public"."crm_contract_status" AS ENUM('draft', 'sent', 'signed', 'ended');--> statement-breakpoint
CREATE TYPE "public"."crm_stage_kind" AS ENUM('open', 'won', 'done', 'lost');--> statement-breakpoint
CREATE TABLE "thread_participants" (
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"address" text NOT NULL,
	"domain" text NOT NULL,
	CONSTRAINT "thread_participants_thread_id_address_pk" PRIMARY KEY("thread_id","address")
);
--> statement-breakpoint
CREATE TABLE "thread_participants_backfill" (
	"mailbox_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"last_message_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_locks" (
	"node_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by_member_id" text
);
--> statement-breakpoint
CREATE TABLE "crm_companies" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"folder_node_id" text,
	"created_by_member_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_companies_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "crm_company_domains" (
	"org_id" text NOT NULL,
	"company_id" text NOT NULL,
	"domain" text NOT NULL,
	CONSTRAINT "crm_company_domains_org_id_domain_pk" PRIMARY KEY("org_id","domain")
);
--> statement-breakpoint
CREATE TABLE "crm_contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"company_id" text,
	"deal_id" text,
	"title" text NOT NULL,
	"status" "crm_contract_status" DEFAULT 'draft' NOT NULL,
	"document_node_id" text,
	"signed_at" timestamp with time zone,
	"effective_on" date,
	"expires_on" date,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contracts_record" CHECK (num_nonnulls("crm_contracts"."company_id", "crm_contracts"."deal_id") >= 1)
);
--> statement-breakpoint
CREATE TABLE "crm_deal_people" (
	"org_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"person_id" text NOT NULL,
	CONSTRAINT "crm_deal_people_deal_id_person_id_pk" PRIMARY KEY("deal_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "crm_deals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"company_id" text,
	"stage_id" text NOT NULL,
	"stage_entered_at" timestamp with time zone NOT NULL,
	"owner_member_id" text,
	"value_minor" bigint,
	"value_currency" text,
	"won_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"folder_node_id" text,
	"created_by_member_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_deals_id_org_id_unique" UNIQUE("id","org_id"),
	CONSTRAINT "crm_deals_value_currency" CHECK ("crm_deals"."value_minor" is null or "crm_deals"."value_currency" is not null),
	CONSTRAINT "crm_deals_currency_format" CHECK ("crm_deals"."value_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "crm_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"company_id" text,
	"person_id" text,
	"deal_id" text,
	"kind" text NOT NULL,
	"actor_member_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_events_org_id_dedupe_key_unique" UNIQUE("org_id","dedupe_key"),
	CONSTRAINT "crm_events_one_record" CHECK (num_nonnulls("crm_events"."company_id", "crm_events"."person_id", "crm_events"."deal_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "crm_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"company_id" text,
	"person_id" text,
	"deal_id" text,
	"body" text NOT NULL,
	"author_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_notes_one_record" CHECK (num_nonnulls("crm_notes"."company_id", "crm_notes"."person_id", "crm_notes"."deal_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "crm_people" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"company_id" text,
	"job_title" text,
	"phone" text,
	"created_by_member_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_people_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "crm_person_emails" (
	"org_id" text NOT NULL,
	"person_id" text NOT NULL,
	"address" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	CONSTRAINT "crm_person_emails_org_id_address_pk" PRIMARY KEY("org_id","address")
);
--> statement-breakpoint
CREATE TABLE "crm_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"default_currency" text,
	"root_folder_node_id" text
);
--> statement-breakpoint
CREATE TABLE "crm_stages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "crm_stage_kind" NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "crm_stages_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants_backfill" ADD CONSTRAINT "thread_participants_backfill_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants_backfill" ADD CONSTRAINT "thread_participants_backfill_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_locks" ADD CONSTRAINT "storage_locks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_locks" ADD CONSTRAINT "storage_locks_locked_by_member_id_members_id_fk" FOREIGN KEY ("locked_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_locks" ADD CONSTRAINT "storage_locks_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_folder_node_id_storage_nodes_id_fk" FOREIGN KEY ("folder_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_company_domains" ADD CONSTRAINT "crm_company_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_company_domains" ADD CONSTRAINT "crm_company_domains_company_org_fk" FOREIGN KEY ("company_id","org_id") REFERENCES "public"."crm_companies"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_document_node_id_storage_nodes_id_fk" FOREIGN KEY ("document_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_company_org_fk" FOREIGN KEY ("company_id","org_id") REFERENCES "public"."crm_companies"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_people" ADD CONSTRAINT "crm_deal_people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_people" ADD CONSTRAINT "crm_deal_people_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_people" ADD CONSTRAINT "crm_deal_people_person_org_fk" FOREIGN KEY ("person_id","org_id") REFERENCES "public"."crm_people"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_company_id_crm_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."crm_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_folder_node_id_storage_nodes_id_fk" FOREIGN KEY ("folder_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_stage_org_fk" FOREIGN KEY ("stage_id","org_id") REFERENCES "public"."crm_stages"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_events" ADD CONSTRAINT "crm_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_events" ADD CONSTRAINT "crm_events_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_events" ADD CONSTRAINT "crm_events_company_org_fk" FOREIGN KEY ("company_id","org_id") REFERENCES "public"."crm_companies"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_events" ADD CONSTRAINT "crm_events_person_org_fk" FOREIGN KEY ("person_id","org_id") REFERENCES "public"."crm_people"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_events" ADD CONSTRAINT "crm_events_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_company_org_fk" FOREIGN KEY ("company_id","org_id") REFERENCES "public"."crm_companies"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_person_org_fk" FOREIGN KEY ("person_id","org_id") REFERENCES "public"."crm_people"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD CONSTRAINT "crm_notes_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_people" ADD CONSTRAINT "crm_people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_people" ADD CONSTRAINT "crm_people_company_id_crm_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."crm_companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_people" ADD CONSTRAINT "crm_people_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_person_emails" ADD CONSTRAINT "crm_person_emails_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_person_emails" ADD CONSTRAINT "crm_person_emails_person_org_fk" FOREIGN KEY ("person_id","org_id") REFERENCES "public"."crm_people"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD CONSTRAINT "crm_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD CONSTRAINT "crm_settings_root_folder_node_id_storage_nodes_id_fk" FOREIGN KEY ("root_folder_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_participants_mailbox_address_idx" ON "thread_participants" USING btree ("mailbox_id","address","thread_id");--> statement-breakpoint
CREATE INDEX "thread_participants_mailbox_domain_idx" ON "thread_participants" USING btree ("mailbox_id","domain","thread_id");--> statement-breakpoint
CREATE INDEX "crm_companies_name_idx" ON "crm_companies" USING btree ("org_id",lower("name"),"id");--> statement-breakpoint
CREATE INDEX "crm_company_domains_company_id_idx" ON "crm_company_domains" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_contracts_company_id_idx" ON "crm_contracts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_contracts_deal_id_idx" ON "crm_contracts" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "crm_deal_people_person_id_idx" ON "crm_deal_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "crm_deals_name_idx" ON "crm_deals" USING btree ("org_id",lower("name"),"id");--> statement-breakpoint
CREATE INDEX "crm_deals_stage_id_idx" ON "crm_deals" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "crm_deals_company_id_idx" ON "crm_deals" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_deals_owner_member_id_idx" ON "crm_deals" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "crm_events_company_timeline_idx" ON "crm_events" USING btree ("company_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "crm_events"."company_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_events_person_timeline_idx" ON "crm_events" USING btree ("person_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "crm_events"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_events_deal_timeline_idx" ON "crm_events" USING btree ("deal_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "crm_events"."deal_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_events_actor_member_id_idx" ON "crm_events" USING btree ("actor_member_id");--> statement-breakpoint
CREATE INDEX "crm_notes_company_timeline_idx" ON "crm_notes" USING btree ("company_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "crm_notes"."company_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_notes_person_timeline_idx" ON "crm_notes" USING btree ("person_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "crm_notes"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_notes_deal_timeline_idx" ON "crm_notes" USING btree ("deal_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "crm_notes"."deal_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_notes_author_member_id_idx" ON "crm_notes" USING btree ("author_member_id");--> statement-breakpoint
CREATE INDEX "crm_people_name_idx" ON "crm_people" USING btree ("org_id",lower("name"),"id");--> statement-breakpoint
CREATE INDEX "crm_people_company_id_idx" ON "crm_people" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "crm_person_emails_person_id_idx" ON "crm_person_emails" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_person_emails_primary_key" ON "crm_person_emails" USING btree ("person_id") WHERE "crm_person_emails"."is_primary";--> statement-breakpoint
CREATE INDEX "crm_stages_org_id_position_idx" ON "crm_stages" USING btree ("org_id","position");--> statement-breakpoint
CREATE INDEX "messages_mailbox_id_id_idx" ON "messages" USING btree ("mailbox_id","id");