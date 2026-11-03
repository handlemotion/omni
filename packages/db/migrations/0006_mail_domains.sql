CREATE TABLE "mail_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"provider" "mail_provider" NOT NULL,
	"dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"added_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_domains_org_id_idx" ON "mail_domains" USING btree ("org_id");