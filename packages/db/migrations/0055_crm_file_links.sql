CREATE TABLE "crm_file_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"company_id" text,
	"deal_id" text,
	"node_id" text NOT NULL,
	"added_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_file_links_one_record" CHECK (num_nonnulls("crm_file_links"."company_id", "crm_file_links"."deal_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "crm_file_links" ADD CONSTRAINT "crm_file_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_file_links" ADD CONSTRAINT "crm_file_links_node_id_storage_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_file_links" ADD CONSTRAINT "crm_file_links_added_by_member_id_members_id_fk" FOREIGN KEY ("added_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_file_links" ADD CONSTRAINT "crm_file_links_company_org_fk" FOREIGN KEY ("company_id","org_id") REFERENCES "public"."crm_companies"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_file_links" ADD CONSTRAINT "crm_file_links_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_file_links_company_node_idx" ON "crm_file_links" USING btree ("company_id","node_id") WHERE "crm_file_links"."company_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_file_links_deal_node_idx" ON "crm_file_links" USING btree ("deal_id","node_id") WHERE "crm_file_links"."deal_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_file_links_node_id_idx" ON "crm_file_links" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "crm_file_links_added_by_member_id_idx" ON "crm_file_links" USING btree ("added_by_member_id");