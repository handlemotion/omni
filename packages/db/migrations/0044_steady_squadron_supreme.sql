CREATE TYPE "public"."storage_signature_event_kind" AS ENUM('sent', 'viewed', 'code_sent', 'code_verified', 'signed', 'completed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."storage_signature_status" AS ENUM('sent', 'completed', 'voided');--> statement-breakpoint
ALTER TYPE "public"."storage_grant_role" ADD VALUE 'commenter' BEFORE 'editor';--> statement-breakpoint
CREATE TABLE "storage_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"parent_id" text,
	"content_version" integer NOT NULL,
	"anchor" jsonb,
	"body" text NOT NULL,
	"author_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_member_id" text,
	CONSTRAINT "storage_comments_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "storage_signature_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"request_id" text NOT NULL,
	"kind" "storage_signature_event_kind" NOT NULL,
	"email" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_signature_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"content_version" integer NOT NULL,
	"document_sha256" text NOT NULL,
	"status" "storage_signature_status" DEFAULT 'sent' NOT NULL,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"sealed_node_id" text,
	"sealed_sha256" text,
	"conservation" jsonb,
	CONSTRAINT "storage_signature_requests_id_org_id_unique" UNIQUE("id","org_id"),
	CONSTRAINT "storage_signature_requests_status_time" CHECK (("storage_signature_requests"."status" = 'completed') = ("storage_signature_requests"."completed_at" is not null) and ("storage_signature_requests"."status" = 'voided') = ("storage_signature_requests"."voided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "storage_signers" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"request_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"signed_at" timestamp with time zone,
	"typed_name" text,
	"consent_version" text,
	"document_sha256" text,
	"ip" text,
	"user_agent" text,
	"user_id" text,
	CONSTRAINT "storage_signers_request_id_email_unique" UNIQUE("request_id","email"),
	CONSTRAINT "storage_signers_signed" CHECK (("storage_signers"."signed_at" is null) = ("storage_signers"."typed_name" is null) and ("storage_signers"."signed_at" is null) = ("storage_signers"."consent_version" is null) and ("storage_signers"."signed_at" is null) = ("storage_signers"."document_sha256" is null))
);
--> statement-breakpoint
ALTER TABLE "storage_versions" ADD COLUMN "content_version" integer;--> statement-breakpoint
ALTER TABLE "storage_comments" ADD CONSTRAINT "storage_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_comments" ADD CONSTRAINT "storage_comments_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_comments" ADD CONSTRAINT "storage_comments_resolved_by_member_id_members_id_fk" FOREIGN KEY ("resolved_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_comments" ADD CONSTRAINT "storage_comments_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_comments" ADD CONSTRAINT "storage_comments_parent_org_fk" FOREIGN KEY ("parent_id","org_id") REFERENCES "public"."storage_comments"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signature_events" ADD CONSTRAINT "storage_signature_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signature_events" ADD CONSTRAINT "storage_signature_events_request_org_fk" FOREIGN KEY ("request_id","org_id") REFERENCES "public"."storage_signature_requests"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signature_requests" ADD CONSTRAINT "storage_signature_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signature_requests" ADD CONSTRAINT "storage_signature_requests_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signature_requests" ADD CONSTRAINT "storage_signature_requests_sealed_node_id_storage_nodes_id_fk" FOREIGN KEY ("sealed_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signature_requests" ADD CONSTRAINT "storage_signature_requests_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signers" ADD CONSTRAINT "storage_signers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signers" ADD CONSTRAINT "storage_signers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_signers" ADD CONSTRAINT "storage_signers_request_org_fk" FOREIGN KEY ("request_id","org_id") REFERENCES "public"."storage_signature_requests"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_comments_node_id_idx" ON "storage_comments" USING btree ("node_id","created_at","id");--> statement-breakpoint
CREATE INDEX "storage_comments_parent_id_idx" ON "storage_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "storage_comments_author_member_id_idx" ON "storage_comments" USING btree ("author_member_id");--> statement-breakpoint
CREATE INDEX "storage_comments_resolved_by_member_id_idx" ON "storage_comments" USING btree ("resolved_by_member_id");--> statement-breakpoint
CREATE INDEX "storage_signature_events_request_id_idx" ON "storage_signature_events" USING btree ("request_id","created_at","id");--> statement-breakpoint
CREATE INDEX "storage_signature_requests_node_id_idx" ON "storage_signature_requests" USING btree ("node_id","created_at");--> statement-breakpoint
CREATE INDEX "storage_signature_requests_sealed_node_id_idx" ON "storage_signature_requests" USING btree ("sealed_node_id");--> statement-breakpoint
CREATE INDEX "storage_signature_requests_created_by_member_id_idx" ON "storage_signature_requests" USING btree ("created_by_member_id");--> statement-breakpoint
CREATE INDEX "storage_signers_email_idx" ON "storage_signers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "storage_signers_user_id_idx" ON "storage_signers" USING btree ("user_id");