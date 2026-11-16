CREATE TABLE "storage_contents" (
	"node_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"written_by_member_id" text,
	"written_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_upload_targets" (
	"upload_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text
);
--> statement-breakpoint
CREATE TABLE "storage_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"size" bigint NOT NULL,
	"mime_type" text,
	"r2_key" text NOT NULL,
	"written_by_member_id" text,
	"written_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_contents" ADD CONSTRAINT "storage_contents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_contents" ADD CONSTRAINT "storage_contents_written_by_member_id_members_id_fk" FOREIGN KEY ("written_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_contents" ADD CONSTRAINT "storage_contents_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_targets" ADD CONSTRAINT "storage_upload_targets_upload_id_storage_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."storage_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_targets" ADD CONSTRAINT "storage_upload_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_targets" ADD CONSTRAINT "storage_upload_targets_node_id_storage_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_versions" ADD CONSTRAINT "storage_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_versions" ADD CONSTRAINT "storage_versions_written_by_member_id_members_id_fk" FOREIGN KEY ("written_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_versions" ADD CONSTRAINT "storage_versions_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_contents_written_by_member_id_idx" ON "storage_contents" USING btree ("written_by_member_id");--> statement-breakpoint
CREATE INDEX "storage_upload_targets_node_id_idx" ON "storage_upload_targets" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "storage_versions_node_id_idx" ON "storage_versions" USING btree ("node_id","replaced_at" DESC NULLS FIRST,"id");--> statement-breakpoint
CREATE INDEX "storage_versions_replaced_at_idx" ON "storage_versions" USING btree ("replaced_at");--> statement-breakpoint
CREATE INDEX "storage_versions_org_id_idx" ON "storage_versions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "storage_versions_written_by_member_id_idx" ON "storage_versions" USING btree ("written_by_member_id");