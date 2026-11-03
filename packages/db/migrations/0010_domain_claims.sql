CREATE TYPE "public"."domain_claim_status" AS ENUM('pending', 'verified', 'released');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_member_id" text,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"domain" text NOT NULL,
	"status" "domain_claim_status" DEFAULT 'pending' NOT NULL,
	"challenge_hash" text NOT NULL,
	"provider" "mail_provider" NOT NULL,
	"dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_member_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_claims_org_domain_unique" UNIQUE("org_id","domain")
);
--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "dns_lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_member_id_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_claims" ADD CONSTRAINT "domain_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_claims" ADD CONSTRAINT "domain_claims_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_org_subject_idx" ON "audit_events" USING btree ("org_id","subject","created_at");--> statement-breakpoint
CREATE INDEX "domain_claims_domain_idx" ON "domain_claims" USING btree ("domain");