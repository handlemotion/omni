ALTER TYPE "public"."calendar_event_source" ADD VALUE 'google';--> statement-breakpoint
CREATE TABLE "calendar_google_sync" (
	"calendar_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"sync_token" text,
	"page_token" text,
	"full_sync_started_at" timestamp with time zone,
	"waiting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "google_id" text;--> statement-breakpoint
ALTER TABLE "calendar_google_sync" ADD CONSTRAINT "calendar_google_sync_calendar_id_calendar_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendar_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_google_sync" ADD CONSTRAINT "calendar_google_sync_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_events_google_id_idx" ON "calendar_events" USING btree ("calendar_id","google_id") WHERE "calendar_events"."google_id" is not null;