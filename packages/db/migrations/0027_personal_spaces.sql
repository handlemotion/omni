CREATE TABLE "personal_spaces" (
	"org_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_spaces_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "personal_spaces" ADD CONSTRAINT "personal_spaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_spaces" ADD CONSTRAINT "personal_spaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;