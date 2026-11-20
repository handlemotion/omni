CREATE TABLE "crm_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"company_id" text,
	"person_id" text,
	"deal_id" text,
	"assignee_member_id" text,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by_member_id" text,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_tasks_at_most_one_record" CHECK (num_nonnulls("crm_tasks"."company_id", "crm_tasks"."person_id", "crm_tasks"."deal_id") <= 1)
);
--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_assignee_member_id_members_id_fk" FOREIGN KEY ("assignee_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_completed_by_member_id_members_id_fk" FOREIGN KEY ("completed_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_company_org_fk" FOREIGN KEY ("company_id","org_id") REFERENCES "public"."crm_companies"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_person_org_fk" FOREIGN KEY ("person_id","org_id") REFERENCES "public"."crm_people"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_tasks" ADD CONSTRAINT "crm_tasks_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_tasks_open_due_idx" ON "crm_tasks" USING btree ("org_id","due_at","id") WHERE "crm_tasks"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "crm_tasks_assignee_open_due_idx" ON "crm_tasks" USING btree ("assignee_member_id","due_at","id") WHERE "crm_tasks"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "crm_tasks_done_idx" ON "crm_tasks" USING btree ("org_id","completed_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "crm_tasks"."completed_at" is not null;--> statement-breakpoint
CREATE INDEX "crm_tasks_company_id_idx" ON "crm_tasks" USING btree ("company_id") WHERE "crm_tasks"."company_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_tasks_person_id_idx" ON "crm_tasks" USING btree ("person_id") WHERE "crm_tasks"."person_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_tasks_deal_id_idx" ON "crm_tasks" USING btree ("deal_id") WHERE "crm_tasks"."deal_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_tasks_completed_by_member_id_idx" ON "crm_tasks" USING btree ("completed_by_member_id");--> statement-breakpoint
CREATE INDEX "crm_tasks_created_by_member_id_idx" ON "crm_tasks" USING btree ("created_by_member_id");