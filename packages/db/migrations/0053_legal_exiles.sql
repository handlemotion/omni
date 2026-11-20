ALTER TABLE "crm_companies" ADD COLUMN "owner_member_id" text;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD COLUMN "expected_close_on" date;--> statement-breakpoint
ALTER TABLE "crm_people" ADD COLUMN "owner_member_id" text;--> statement-breakpoint
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_people" ADD CONSTRAINT "crm_people_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_companies_updated_at_idx" ON "crm_companies" USING btree ("org_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "crm_companies_owner_member_id_idx" ON "crm_companies" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "crm_deals_updated_at_idx" ON "crm_deals" USING btree ("org_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "crm_deals_value_idx" ON "crm_deals" USING btree ("org_id","value_minor","id");--> statement-breakpoint
CREATE INDEX "crm_deals_expected_close_on_idx" ON "crm_deals" USING btree ("org_id","expected_close_on","id");--> statement-breakpoint
CREATE INDEX "crm_people_updated_at_idx" ON "crm_people" USING btree ("org_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "crm_people_owner_member_id_idx" ON "crm_people" USING btree ("owner_member_id");