CREATE TYPE "public"."calendar_task_record_kind" AS ENUM('company', 'person', 'deal');--> statement-breakpoint
CREATE TABLE "calendar_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_member_id" text,
	"title" text NOT NULL,
	"body" text,
	"subtasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by_member_id" text,
	"assignee_member_id" text,
	"record_kind" "calendar_task_record_kind",
	"record_id" text,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_tasks_record_whole" CHECK (("calendar_tasks"."record_kind" is null) = ("calendar_tasks"."record_id" is null)),
	CONSTRAINT "calendar_tasks_private_is_owned" CHECK ("calendar_tasks"."record_kind" is not null or ("calendar_tasks"."owner_member_id" is not null and ("calendar_tasks"."assignee_member_id" is null or "calendar_tasks"."assignee_member_id" = "calendar_tasks"."owner_member_id")))
);
--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD CONSTRAINT "calendar_tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD CONSTRAINT "calendar_tasks_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD CONSTRAINT "calendar_tasks_completed_by_member_id_members_id_fk" FOREIGN KEY ("completed_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD CONSTRAINT "calendar_tasks_assignee_member_id_members_id_fk" FOREIGN KEY ("assignee_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD CONSTRAINT "calendar_tasks_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_tasks_owner_open_due_idx" ON "calendar_tasks" USING btree ("owner_member_id","due_at","id") WHERE "calendar_tasks"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "calendar_tasks_assignee_open_due_idx" ON "calendar_tasks" USING btree ("assignee_member_id","due_at","id") WHERE "calendar_tasks"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "calendar_tasks_record_idx" ON "calendar_tasks" USING btree ("org_id","record_kind","record_id");--> statement-breakpoint
CREATE INDEX "calendar_tasks_org_open_due_idx" ON "calendar_tasks" USING btree ("org_id","due_at","id") WHERE "calendar_tasks"."completed_at" is null and "calendar_tasks"."record_kind" is not null;--> statement-breakpoint
CREATE INDEX "calendar_tasks_completed_by_member_id_idx" ON "calendar_tasks" USING btree ("completed_by_member_id");--> statement-breakpoint
CREATE INDEX "calendar_tasks_created_by_member_id_idx" ON "calendar_tasks" USING btree ("created_by_member_id");