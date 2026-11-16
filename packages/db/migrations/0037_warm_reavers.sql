CREATE TYPE "public"."storage_grant_role" AS ENUM('viewer', 'editor');--> statement-breakpoint
CREATE TYPE "public"."storage_link_access" AS ENUM('restricted', 'anyone');--> statement-breakpoint
CREATE TYPE "public"."storage_node_kind" AS ENUM('folder', 'file');--> statement-breakpoint
CREATE TYPE "public"."storage_space" AS ENUM('personal', 'shared');--> statement-breakpoint
CREATE TABLE "storage_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "storage_grant_role" NOT NULL,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_grants_node_id_email_unique" UNIQUE("node_id","email")
);
--> statement-breakpoint
CREATE TABLE "storage_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"space" "storage_space" NOT NULL,
	"owner_member_id" text,
	"parent_id" text,
	"kind" "storage_node_kind" NOT NULL,
	"name" text NOT NULL,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime_type" text,
	"r2_key" text,
	"share_id" text,
	"link_access" "storage_link_access" DEFAULT 'restricted' NOT NULL,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"trashed_at" timestamp with time zone,
	CONSTRAINT "storage_nodes_id_org_id_unique" UNIQUE("id","org_id"),
	CONSTRAINT "storage_nodes_share_id_unique" UNIQUE("share_id"),
	CONSTRAINT "storage_nodes_space_owner" CHECK (("storage_nodes"."space" = 'personal') = ("storage_nodes"."owner_member_id" is not null)),
	CONSTRAINT "storage_nodes_file_key" CHECK (("storage_nodes"."kind" = 'file') = ("storage_nodes"."r2_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "storage_peaks" (
	"org_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"peak_bytes" bigint NOT NULL,
	CONSTRAINT "storage_peaks_org_id_period_start_pk" PRIMARY KEY("org_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "storage_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"space" "storage_space" NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"mime_type" text,
	"r2_key" text NOT NULL,
	"r2_upload_id" text,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"node_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_usage" (
	"org_id" text PRIMARY KEY NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_grants" ADD CONSTRAINT "storage_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_grants" ADD CONSTRAINT "storage_grants_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_grants" ADD CONSTRAINT "storage_grants_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_parent_org_fk" FOREIGN KEY ("parent_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_peaks" ADD CONSTRAINT "storage_peaks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_parent_org_fk" FOREIGN KEY ("parent_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD CONSTRAINT "storage_uploads_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_grants_email_idx" ON "storage_grants" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_nodes_sibling_name_key" ON "storage_nodes" USING btree ("org_id","space",coalesce("owner_member_id", ''),coalesce("parent_id", ''),lower("name")) WHERE "storage_nodes"."trashed_at" is null;--> statement-breakpoint
CREATE INDEX "storage_nodes_list_idx" ON "storage_nodes" USING btree ("org_id","space",coalesce("owner_member_id", ''),coalesce("parent_id", ''),"kind",lower("name"),"id");--> statement-breakpoint
CREATE INDEX "storage_nodes_parent_id_idx" ON "storage_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "storage_nodes_owner_member_id_idx" ON "storage_nodes" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "storage_nodes_trash_idx" ON "storage_nodes" USING btree ("org_id","trashed_at") WHERE "storage_nodes"."trashed_at" is not null;--> statement-breakpoint
CREATE INDEX "storage_uploads_org_id_idx" ON "storage_uploads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "storage_uploads_expires_at_idx" ON "storage_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "storage_uploads_member_id_idx" ON "storage_uploads" USING btree ("member_id");