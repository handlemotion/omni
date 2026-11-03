CREATE TABLE "dead_letters" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"queue" text NOT NULL,
	"job_id" text NOT NULL,
	"job" jsonb NOT NULL,
	"error" text,
	"attempts" integer NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dead_letters_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "mail_actions" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dead_letters_created_idx" ON "dead_letters" USING btree ("created_at");