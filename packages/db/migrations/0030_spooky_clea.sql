CREATE TABLE "invitation_inboxes" (
	"org_id" text NOT NULL,
	"invitation_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_inboxes_invitation_id_mailbox_id_pk" PRIMARY KEY("invitation_id","mailbox_id")
);
--> statement-breakpoint
ALTER TABLE "invitation_inboxes" ADD CONSTRAINT "invitation_inboxes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_inboxes" ADD CONSTRAINT "invitation_inboxes_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_inboxes" ADD CONSTRAINT "invitation_inboxes_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;