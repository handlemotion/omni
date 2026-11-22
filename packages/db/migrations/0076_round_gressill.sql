CREATE TYPE "public"."meetings_access" AS ENUM('restricted', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."meetings_action_kind" AS ENUM('task', 'email');--> statement-breakpoint
CREATE TYPE "public"."meetings_action_state" AS ENUM('open', 'done', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."meetings_link_access" AS ENUM('off', 'signed_in', 'anyone');--> statement-breakpoint
CREATE TYPE "public"."meetings_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."meetings_speaker_source" AS ENUM('mic', 'engine', 'ai', 'person');--> statement-breakpoint
CREATE TYPE "public"."meetings_status" AS ENUM('recording', 'uploaded', 'transcribing', 'naming', 'writing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "meetings_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"meeting_id" text NOT NULL,
	"org_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" "meetings_action_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"state" "meetings_action_state" DEFAULT 'open' NOT NULL,
	"task_id" text,
	"decided_by_member_id" text,
	"decided_at" timestamp with time zone,
	CONSTRAINT "meetings_actions_meeting_seq_unique" UNIQUE("meeting_id","seq")
);
--> statement-breakpoint
CREATE TABLE "meetings_attendees" (
	"meeting_id" text NOT NULL,
	"org_id" text NOT NULL,
	"address" text NOT NULL,
	"name" text,
	CONSTRAINT "meetings_attendees_meeting_id_address_pk" PRIMARY KEY("meeting_id","address")
);
--> statement-breakpoint
CREATE TABLE "meetings_grants" (
	"meeting_id" text NOT NULL,
	"org_id" text NOT NULL,
	"address" text NOT NULL,
	"role" "meetings_role" NOT NULL,
	"granted_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_grants_meeting_id_address_pk" PRIMARY KEY("meeting_id","address")
);
--> statement-breakpoint
CREATE TABLE "meetings_groups" (
	"org_id" text NOT NULL,
	"group_key" text NOT NULL,
	"meetings_hash" text NOT NULL,
	"summary" text NOT NULL,
	"summarized_through" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_groups_org_id_group_key_meetings_hash_pk" PRIMARY KEY("org_id","group_key","meetings_hash")
);
--> statement-breakpoint
CREATE TABLE "meetings_jobs" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" text,
	"provider_job_id" text,
	"mic_spans" jsonb,
	"cuts" jsonb,
	"upload_id" text,
	"submitted_at" timestamp with time zone,
	"polls" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings_meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"event_uid" text,
	"event_recurrence_id" text DEFAULT '' NOT NULL,
	"part" integer DEFAULT 1 NOT NULL,
	"group_key" text NOT NULL,
	"record_kind" text,
	"record_id" text,
	"access" "meetings_access" DEFAULT 'restricted' NOT NULL,
	"link_access" "meetings_link_access" DEFAULT 'off' NOT NULL,
	"link_token" text,
	"recorded_by_member_id" text,
	"consent_at" timestamp with time zone NOT NULL,
	"status" "meetings_status" DEFAULT 'recording' NOT NULL,
	"language" text,
	"audio_node_id" text,
	"raw_node_id" text,
	"notes_node_id" text,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_meetings_id_org_id_unique" UNIQUE("id","org_id"),
	CONSTRAINT "meetings_meetings_part_positive" CHECK ("meetings_meetings"."part" >= 1),
	CONSTRAINT "meetings_meetings_record_pair" CHECK (("meetings_meetings"."record_kind" is null) = ("meetings_meetings"."record_id" is null))
);
--> statement-breakpoint
CREATE TABLE "meetings_notes" (
	"meeting_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"summary" text NOT NULL,
	"highlights" jsonb NOT NULL,
	"topics" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"written_to_doc_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings_segments" (
	"meeting_id" text NOT NULL,
	"seq" integer NOT NULL,
	"org_id" text NOT NULL,
	"speaker_label" text,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
	CONSTRAINT "meetings_segments_meeting_id_seq_pk" PRIMARY KEY("meeting_id","seq")
);
--> statement-breakpoint
CREATE TABLE "meetings_speakers" (
	"meeting_id" text NOT NULL,
	"label" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text,
	"address" text,
	"source" "meetings_speaker_source",
	"confidence" real DEFAULT 0 NOT NULL,
	CONSTRAINT "meetings_speakers_meeting_id_label_pk" PRIMARY KEY("meeting_id","label")
);
--> statement-breakpoint
ALTER TABLE "meetings_actions" ADD CONSTRAINT "meetings_actions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_actions" ADD CONSTRAINT "meetings_actions_decided_by_member_id_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_actions" ADD CONSTRAINT "meetings_actions_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_attendees" ADD CONSTRAINT "meetings_attendees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_attendees" ADD CONSTRAINT "meetings_attendees_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_grants" ADD CONSTRAINT "meetings_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_grants" ADD CONSTRAINT "meetings_grants_granted_by_member_id_members_id_fk" FOREIGN KEY ("granted_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_grants" ADD CONSTRAINT "meetings_grants_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_groups" ADD CONSTRAINT "meetings_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_jobs" ADD CONSTRAINT "meetings_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_jobs" ADD CONSTRAINT "meetings_jobs_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_meetings" ADD CONSTRAINT "meetings_meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_meetings" ADD CONSTRAINT "meetings_meetings_recorded_by_member_id_members_id_fk" FOREIGN KEY ("recorded_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_meetings" ADD CONSTRAINT "meetings_meetings_audio_node_id_storage_nodes_id_fk" FOREIGN KEY ("audio_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_meetings" ADD CONSTRAINT "meetings_meetings_raw_node_id_storage_nodes_id_fk" FOREIGN KEY ("raw_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_meetings" ADD CONSTRAINT "meetings_meetings_notes_node_id_storage_nodes_id_fk" FOREIGN KEY ("notes_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_notes" ADD CONSTRAINT "meetings_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_notes" ADD CONSTRAINT "meetings_notes_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_segments" ADD CONSTRAINT "meetings_segments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_segments" ADD CONSTRAINT "meetings_segments_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_speakers" ADD CONSTRAINT "meetings_speakers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings_speakers" ADD CONSTRAINT "meetings_speakers_meeting_org_fk" FOREIGN KEY ("meeting_id","org_id") REFERENCES "public"."meetings_meetings"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_grants_address_idx" ON "meetings_grants" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_meetings_event_part_unique" ON "meetings_meetings" USING btree ("org_id","event_uid","event_recurrence_id","part") WHERE "meetings_meetings"."event_uid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_meetings_link_token_unique" ON "meetings_meetings" USING btree ("link_token");--> statement-breakpoint
CREATE INDEX "meetings_meetings_group_idx" ON "meetings_meetings" USING btree ("org_id","group_key","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meetings_meetings_record_idx" ON "meetings_meetings" USING btree ("org_id","record_kind","record_id");--> statement-breakpoint
CREATE INDEX "meetings_meetings_started_idx" ON "meetings_meetings" USING btree ("org_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "meetings_segments_search_idx" ON "meetings_segments" USING gin ("search");