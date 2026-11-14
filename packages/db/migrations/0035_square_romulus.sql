CREATE TABLE "member_role_descriptions" (
	"member_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "member_role_descriptions" ADD CONSTRAINT "member_role_descriptions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role_descriptions" ADD CONSTRAINT "member_role_descriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_role_descriptions_org_idx" ON "member_role_descriptions" USING btree ("org_id");