CREATE TYPE "public"."calendar_attendee_role" AS ENUM('chair', 'required', 'optional', 'none');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_source" AS ENUM('invite', 'omni');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_status" AS ENUM('confirmed', 'tentative', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."calendar_part_outcome" AS ENUM('applied', 'stale', 'ignored', 'invalid');--> statement-breakpoint
CREATE TYPE "public"."calendar_response" AS ENUM('needs_action', 'accepted', 'declined', 'tentative', 'delegated');--> statement-breakpoint
CREATE TABLE "calendar_answers" (
	"org_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"uid" text NOT NULL,
	"recurrence_id" timestamp with time zone,
	"address" text NOT NULL,
	"response" "calendar_response" NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "calendar_answers_identity_unique" UNIQUE NULLS NOT DISTINCT("calendar_id","uid","recurrence_id","address")
);
--> statement-breakpoint
CREATE TABLE "calendar_attendees" (
	"event_id" text NOT NULL,
	"org_id" text NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"role" "calendar_attendee_role" DEFAULT 'required' NOT NULL,
	"response" "calendar_response" DEFAULT 'needs_action' NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "calendar_attendees_event_id_address_pk" PRIMARY KEY("event_id","address")
);
--> statement-breakpoint
CREATE TABLE "calendar_calendars" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_calendars_mailbox_id_unique" UNIQUE("mailbox_id"),
	CONSTRAINT "calendar_calendars_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"uid" text NOT NULL,
	"recurrence_id" timestamp with time zone,
	"sequence" integer DEFAULT 0 NOT NULL,
	"dtstamp" timestamp with time zone,
	"source" "calendar_event_source" NOT NULL,
	"status" "calendar_event_status" DEFAULT 'confirmed' NOT NULL,
	"busy" boolean DEFAULT true NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"conference_url" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"start_day" text,
	"end_day" text,
	"time_zone" text,
	"rrule" text,
	"exdates" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"rdates" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"recurs_until" timestamp with time zone,
	"organizer_address" text,
	"organizer_name" text,
	"message_id" text,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_identity_unique" UNIQUE NULLS NOT DISTINCT("calendar_id","uid","recurrence_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_parts" (
	"attachment_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"calendar_id" text,
	"method" text,
	"uid" text,
	"outcome" "calendar_part_outcome" NOT NULL,
	"reason" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sweep" (
	"name" text PRIMARY KEY NOT NULL,
	"cursor_at" timestamp with time zone NOT NULL,
	"cursor_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_answers" ADD CONSTRAINT "calendar_answers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_answers" ADD CONSTRAINT "calendar_answers_calendar_id_calendar_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendar_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_attendees" ADD CONSTRAINT "calendar_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_attendees" ADD CONSTRAINT "calendar_attendees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_calendars" ADD CONSTRAINT "calendar_calendars_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_calendars" ADD CONSTRAINT "calendar_calendars_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_calendar_org_fk" FOREIGN KEY ("calendar_id","org_id") REFERENCES "public"."calendar_calendars"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_parts" ADD CONSTRAINT "calendar_parts_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_parts" ADD CONSTRAINT "calendar_parts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_parts" ADD CONSTRAINT "calendar_parts_calendar_id_calendar_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendar_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_attendees_address_idx" ON "calendar_attendees" USING btree ("org_id","address");--> statement-breakpoint
CREATE INDEX "calendar_events_window_idx" ON "calendar_events" USING btree ("calendar_id","starts_at") WHERE "calendar_events"."rrule" is null;--> statement-breakpoint
CREATE INDEX "calendar_events_series_idx" ON "calendar_events" USING btree ("calendar_id","recurs_until") WHERE "calendar_events"."rrule" is not null;--> statement-breakpoint
CREATE INDEX "calendar_events_message_id_idx" ON "calendar_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "calendar_parts_calendar_uid_idx" ON "calendar_parts" USING btree ("calendar_id","uid");--> statement-breakpoint
CREATE INDEX "attachments_calendar_idx" ON "attachments" USING btree ("created_at","id") WHERE (lower(mime_type) in ('text/calendar', 'application/ics') or lower(filename) like '%.ics');