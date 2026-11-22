ALTER TYPE "public"."storage_share_event_kind" ADD VALUE 'edited';--> statement-breakpoint
ALTER TABLE "storage_contents" ADD COLUMN "written_by_guest" jsonb;--> statement-breakpoint
ALTER TABLE "storage_contents" ADD COLUMN "coauthors" jsonb;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "link_role" "storage_grant_role" DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_policies" ADD COLUMN "link_editing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_upload_links" ADD COLUMN "link_role" "storage_grant_role" DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_versions" ADD COLUMN "written_by_guest" jsonb;--> statement-breakpoint
ALTER TABLE "storage_versions" ADD COLUMN "coauthors" jsonb;--> statement-breakpoint
ALTER TABLE "storage_comments" ADD COLUMN "author_guest" jsonb;