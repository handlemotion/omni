CREATE TABLE "storage_overage" (
	"org_id" text PRIMARY KEY NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_overage" ADD CONSTRAINT "storage_overage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;