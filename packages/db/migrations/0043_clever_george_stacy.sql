CREATE TABLE "storage_sync_state" (
	"org_id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"cursor_floor" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_tombstones" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"space" "storage_space" NOT NULL,
	"owner_member_id" text,
	"revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "content_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "content_sha256" text;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "storage_sync_state" ADD CONSTRAINT "storage_sync_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_tombstones" ADD CONSTRAINT "storage_tombstones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_tombstones" ADD CONSTRAINT "storage_tombstones_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_tombstones_sync_idx" ON "storage_tombstones" USING btree ("org_id","space",coalesce("owner_member_id", ''),"revision","node_id");--> statement-breakpoint
CREATE INDEX "storage_tombstones_created_at_idx" ON "storage_tombstones" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "storage_tombstones_owner_member_id_idx" ON "storage_tombstones" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "storage_nodes_sync_idx" ON "storage_nodes" USING btree ("org_id","space",coalesce("owner_member_id", ''),"revision","id");