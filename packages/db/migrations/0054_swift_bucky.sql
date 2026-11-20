CREATE TABLE "storage_upload_links" (
	"upload_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"share_id" text NOT NULL,
	"link_access" "storage_link_access" DEFAULT 'restricted' NOT NULL,
	"link_expires_at" timestamp with time zone,
	"link_password_hash" text,
	"link_downloads" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_upload_links_share_id_unique" UNIQUE("share_id")
);
--> statement-breakpoint
ALTER TABLE "storage_upload_links" ADD CONSTRAINT "storage_upload_links_upload_id_storage_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."storage_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_links" ADD CONSTRAINT "storage_upload_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;