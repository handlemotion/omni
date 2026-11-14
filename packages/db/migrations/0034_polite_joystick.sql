CREATE TYPE "public"."forward_scope" AS ENUM('sent', 'conversations', 'all');--> statement-breakpoint
ALTER TYPE "public"."mail_action_kind" ADD VALUE 'forward_copy' BEFORE 'archive';--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "forward_address" text;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "forward_scope" "forward_scope" DEFAULT 'conversations' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "forward_since" timestamp with time zone;