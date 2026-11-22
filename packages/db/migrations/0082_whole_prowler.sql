CREATE TABLE "calendar_booking_links" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"time_zone" text NOT NULL,
	"weekdays" integer[] DEFAULT '{1,2,3,4,5}'::integer[] NOT NULL,
	"start_minute" integer DEFAULT 540 NOT NULL,
	"end_minute" integer DEFAULT 1020 NOT NULL,
	"notice_minutes" integer DEFAULT 240 NOT NULL,
	"horizon_days" integer DEFAULT 14 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_booking_links_slug_unique" UNIQUE("slug"),
	CONSTRAINT "calendar_booking_links_hours" CHECK ("calendar_booking_links"."start_minute" >= 0 and "calendar_booking_links"."end_minute" <= 1440 and "calendar_booking_links"."start_minute" < "calendar_booking_links"."end_minute"),
	CONSTRAINT "calendar_booking_links_duration" CHECK ("calendar_booking_links"."duration_minutes" between 5 and 480 and "calendar_booking_links"."horizon_days" between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "calendar_booking_links" ADD CONSTRAINT "calendar_booking_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_booking_links" ADD CONSTRAINT "calendar_booking_links_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_booking_links" ADD CONSTRAINT "calendar_booking_links_calendar_org_fk" FOREIGN KEY ("calendar_id","org_id") REFERENCES "public"."calendar_calendars"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_booking_links_member_idx" ON "calendar_booking_links" USING btree ("member_id");