ALTER TABLE "crm_deals" ADD COLUMN "teamspace_id" text;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_teamspace_id_storage_teamspaces_id_fk" FOREIGN KEY ("teamspace_id") REFERENCES "public"."storage_teamspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_deals_teamspace_id_idx" ON "crm_deals" USING btree ("teamspace_id");