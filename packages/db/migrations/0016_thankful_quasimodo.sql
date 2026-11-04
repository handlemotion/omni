CREATE TABLE "trial_claims" (
	"org_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_claims_user_id_unique" UNIQUE("user_id")
);
