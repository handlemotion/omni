CREATE TABLE "message_locations" (
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"folder_id" text NOT NULL,
	"imap_uid" bigint NOT NULL,
	"message_id" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"modseq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_locations_folder_id_imap_uid_pk" PRIMARY KEY("folder_id","imap_uid")
);
--> statement-breakpoint
ALTER TABLE "mail_actions" ADD COLUMN "smtp_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "html_r2_key" text;--> statement-breakpoint
ALTER TABLE "message_locations" ADD CONSTRAINT "message_locations_folder_id_mailbox_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mailbox_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_locations" ADD CONSTRAINT "message_locations_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_locations" ADD CONSTRAINT "message_locations_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_locations_message_id_idx" ON "message_locations" USING btree ("message_id");