CREATE TABLE "calendar_member_prefs" (
	"member_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"org_id" text NOT NULL,
	"color" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_member_prefs_member_id_calendar_id_pk" PRIMARY KEY("member_id","calendar_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_member_prefs" ADD CONSTRAINT "calendar_member_prefs_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_member_prefs" ADD CONSTRAINT "calendar_member_prefs_calendar_id_calendar_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendar_calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_member_prefs" ADD CONSTRAINT "calendar_member_prefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;