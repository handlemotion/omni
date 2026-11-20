CREATE TYPE "public"."storage_share_event_kind" AS ENUM('link_changed', 'grant_added', 'grant_changed', 'grant_removed', 'viewed', 'downloaded');--> statement-breakpoint
ALTER TYPE "public"."storage_link_access" ADD VALUE 'workspace';--> statement-breakpoint
CREATE TABLE "storage_policies" (
	"org_id" text PRIMARY KEY NOT NULL,
	"public_links" boolean DEFAULT true NOT NULL,
	"outside_sharing" boolean DEFAULT true NOT NULL,
	"updated_by_member_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_share_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"kind" "storage_share_event_kind" NOT NULL,
	"via" text NOT NULL,
	"actor_member_id" text,
	"actor_user_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "link_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "link_password_hash" text;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "link_downloads" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_policies" ADD CONSTRAINT "storage_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_policies" ADD CONSTRAINT "storage_policies_updated_by_member_id_members_id_fk" FOREIGN KEY ("updated_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_share_events" ADD CONSTRAINT "storage_share_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_share_events" ADD CONSTRAINT "storage_share_events_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_share_events_node_idx" ON "storage_share_events" USING btree ("org_id","node_id","created_at");