CREATE TYPE "public"."setup_step" AS ENUM('created', 'domain_added', 'dns_verified', 'mailboxes_created', 'invites_sent', 'complete');--> statement-breakpoint
CREATE TABLE "org_setup" (
	"org_id" text PRIMARY KEY NOT NULL,
	"step" "setup_step" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_setup" ADD CONSTRAINT "org_setup_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;