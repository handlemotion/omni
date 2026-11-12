ALTER TABLE "messages" ADD COLUMN "automated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "workflow_applied_at" timestamp with time zone;