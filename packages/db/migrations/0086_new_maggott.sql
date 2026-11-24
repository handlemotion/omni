CREATE TYPE "public"."calendar_task_activity_kind" AS ENUM('status', 'priority', 'assignee', 'due', 'record', 'comment');--> statement-breakpoint
CREATE TYPE "public"."calendar_task_priority" AS ENUM('urgent', 'high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."calendar_task_status" AS ENUM('backlog', 'todo', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "calendar_task_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"task_id" text NOT NULL,
	"actor_member_id" text,
	"kind" "calendar_task_activity_kind" NOT NULL,
	"change" jsonb,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD COLUMN "status" "calendar_task_status";--> statement-breakpoint
ALTER TABLE "calendar_tasks" ADD COLUMN "priority" "calendar_task_priority";--> statement-breakpoint
ALTER TABLE "calendar_task_activity" ADD CONSTRAINT "calendar_task_activity_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_task_activity" ADD CONSTRAINT "calendar_task_activity_task_id_calendar_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."calendar_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_task_activity" ADD CONSTRAINT "calendar_task_activity_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_task_activity_task_idx" ON "calendar_task_activity" USING btree ("task_id","created_at","id");--> statement-breakpoint
CREATE INDEX "calendar_task_activity_actor_member_id_idx" ON "calendar_task_activity" USING btree ("actor_member_id");--> statement-breakpoint
CREATE INDEX "calendar_task_activity_org_id_idx" ON "calendar_task_activity" USING btree ("org_id");