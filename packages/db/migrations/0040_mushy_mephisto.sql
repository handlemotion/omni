CREATE TYPE "public"."mailbox_crm_sharing_level" AS ENUM('off', 'activity', 'subjects');--> statement-breakpoint
CREATE TABLE "mailbox_crm_sharing" (
	"mailbox_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"level" "mailbox_crm_sharing_level" NOT NULL,
	"updated_by_member_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mailbox_crm_sharing" ADD CONSTRAINT "mailbox_crm_sharing_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_crm_sharing" ADD CONSTRAINT "mailbox_crm_sharing_updated_by_member_id_members_id_fk" FOREIGN KEY ("updated_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_crm_sharing" ADD CONSTRAINT "mailbox_crm_sharing_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;