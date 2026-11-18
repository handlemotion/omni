CREATE TYPE "public"."unsubscribe_kind" AS ENUM('post', 'mail');--> statement-breakpoint
CREATE TABLE "list_unsubscribes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"sender" text NOT NULL,
	"kind" "unsubscribe_kind" NOT NULL,
	"member_id" text,
	"unsubscribed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "list_unsubscribes" ADD CONSTRAINT "list_unsubscribes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_unsubscribes" ADD CONSTRAINT "list_unsubscribes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "list_unsubscribes" ADD CONSTRAINT "list_unsubscribes_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "list_unsubscribes_mailbox_sender_idx" ON "list_unsubscribes" USING btree ("mailbox_id","sender");