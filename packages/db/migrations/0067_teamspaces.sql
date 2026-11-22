CREATE TYPE "public"."storage_teamspace_role" AS ENUM('member', 'owner');--> statement-breakpoint
ALTER TYPE "public"."storage_space" ADD VALUE 'teamspace';--> statement-breakpoint
CREATE TABLE "storage_teamspace_members" (
	"teamspace_id" text NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"role" "storage_teamspace_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_teamspace_members_teamspace_id_member_id_pk" PRIMARY KEY("teamspace_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "storage_teamspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_teamspaces_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
DROP INDEX "storage_nodes_sibling_name_key";--> statement-breakpoint
DROP INDEX "storage_nodes_list_idx";--> statement-breakpoint
DROP INDEX "storage_nodes_sync_idx";--> statement-breakpoint
DROP INDEX "storage_tombstones_sync_idx";--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "teamspace_id" text;--> statement-breakpoint
ALTER TABLE "storage_tombstones" ADD COLUMN "teamspace_id" text;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "teamspace_id" text;--> statement-breakpoint
ALTER TABLE "storage_teamspace_members" ADD CONSTRAINT "storage_teamspace_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_teamspace_members" ADD CONSTRAINT "storage_teamspace_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_teamspace_members" ADD CONSTRAINT "storage_teamspace_members_teamspace_org_fk" FOREIGN KEY ("teamspace_id","org_id") REFERENCES "public"."storage_teamspaces"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_teamspaces" ADD CONSTRAINT "storage_teamspaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_teamspaces" ADD CONSTRAINT "storage_teamspaces_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_teamspace_members_member_id_idx" ON "storage_teamspace_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "storage_teamspaces_org_id_idx" ON "storage_teamspaces" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_teamspace_org_fk" FOREIGN KEY ("teamspace_id","org_id") REFERENCES "public"."storage_teamspaces"("id","org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_teamspace_org_fk" FOREIGN KEY ("teamspace_id","org_id") REFERENCES "public"."storage_teamspaces"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_nodes_teamspace_id_idx" ON "storage_nodes" USING btree ("teamspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_nodes_sibling_name_key" ON "storage_nodes" USING btree ("org_id","space",coalesce("owner_member_id", ''),coalesce("teamspace_id", ''),coalesce("parent_id", ''),lower("name")) WHERE "storage_nodes"."trashed_at" is null;--> statement-breakpoint
CREATE INDEX "storage_nodes_list_idx" ON "storage_nodes" USING btree ("org_id","space",coalesce("owner_member_id", ''),coalesce("teamspace_id", ''),coalesce("parent_id", ''),"kind",lower("name"),"id");--> statement-breakpoint
CREATE INDEX "storage_nodes_sync_idx" ON "storage_nodes" USING btree ("org_id","space",coalesce("owner_member_id", ''),coalesce("teamspace_id", ''),"revision","id");--> statement-breakpoint
CREATE INDEX "storage_tombstones_sync_idx" ON "storage_tombstones" USING btree ("org_id","space",coalesce("owner_member_id", ''),coalesce("teamspace_id", ''),"revision","node_id");--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_space_teamspace" CHECK (("storage_nodes"."space"::text = 'teamspace') = ("storage_nodes"."teamspace_id" is not null));