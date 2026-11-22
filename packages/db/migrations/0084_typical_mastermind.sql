ALTER TABLE "calendar_calendars" ADD COLUMN "google_id" text;--> statement-breakpoint
ALTER TABLE "calendar_calendars" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "calendar_calendars" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "calendar_calendars" ADD CONSTRAINT "calendar_calendars_mailbox_google_unique" UNIQUE NULLS NOT DISTINCT("mailbox_id","google_id");