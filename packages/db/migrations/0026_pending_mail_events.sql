CREATE TABLE "pending_mail_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_mail_events" ADD CONSTRAINT "pending_mail_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_mail_events" ADD CONSTRAINT "pending_mail_events_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;