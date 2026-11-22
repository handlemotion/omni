CREATE TABLE "meetings_chunks" (
	"meeting_id" text NOT NULL,
	"seq" integer NOT NULL,
	"org_id" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"end_ms" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_chunks_meeting_id_seq_pk" PRIMARY KEY("meeting_id","seq"),
	CONSTRAINT "meetings_chunks_seq_nonnegative" CHECK ("meetings_chunks"."seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "meetings_jobs" ADD COLUMN "chunk_count" integer;--> statement-breakpoint
ALTER TABLE "meetings_chunks" ADD CONSTRAINT "meetings_chunks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_chunks" ADD CONSTRAINT "meetings_chunks_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;