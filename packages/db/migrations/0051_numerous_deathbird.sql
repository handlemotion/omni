CREATE TABLE "storage_upload_parts" (
	"upload_id" text NOT NULL,
	"org_id" text NOT NULL,
	"part_number" integer NOT NULL,
	"etag" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_upload_parts_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number")
);
--> statement-breakpoint
ALTER TABLE "storage_uploads" ADD COLUMN "sha256_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storage_upload_parts" ADD CONSTRAINT "storage_upload_parts_upload_id_storage_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."storage_uploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_parts" ADD CONSTRAINT "storage_upload_parts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;