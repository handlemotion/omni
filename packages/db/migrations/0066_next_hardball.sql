ALTER TABLE "storage_contents" ADD COLUMN "written_by_agent" text;--> statement-breakpoint
ALTER TABLE "storage_contents" ADD COLUMN "session_ended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "storage_versions" ADD COLUMN "written_by_agent" text;--> statement-breakpoint
ALTER TABLE "storage_versions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "storage_versions_superseded_at_idx" ON "storage_versions" USING btree ("superseded_at") WHERE "storage_versions"."superseded_at" is not null;