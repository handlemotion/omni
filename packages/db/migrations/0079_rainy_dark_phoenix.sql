CREATE TYPE "public"."usage_meter" AS ENUM('triage', 'assist', 'meeting_minutes');--> statement-breakpoint
CREATE TABLE "usage_claims" (
	"org_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"meter" "usage_meter" NOT NULL,
	"key" text NOT NULL,
	"amount" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_claims_org_id_period_start_meter_key_pk" PRIMARY KEY("org_id","period_start","meter","key")
);
--> statement-breakpoint
ALTER TABLE "usage_claims" ADD CONSTRAINT "usage_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;