ALTER TABLE "mailboxes" ADD COLUMN "auto_assign" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "auto_assign_last_member_id" text;