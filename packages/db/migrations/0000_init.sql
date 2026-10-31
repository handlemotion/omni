CREATE TYPE "public"."folder_role" AS ENUM('inbox', 'sent', 'archive', 'trash', 'other');--> statement-breakpoint
CREATE TYPE "public"."mail_action_kind" AS ENUM('send', 'archive', 'move', 'mark_read', 'mark_unread');--> statement-breakpoint
CREATE TYPE "public"."mail_action_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mail_provider" AS ENUM('purelymail', 'gmail', 'microsoft');--> statement-breakpoint
CREATE TYPE "public"."mailbox_access_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."mailbox_kind" AS ENUM('personal', 'shared');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('pending', 'active', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."triage_bucket" AS ENUM('needs_reply', 'waiting_on_them', 'fyi', 'noise');--> statement-breakpoint
CREATE TYPE "public"."triage_source" AS ENUM('ai', 'person');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"org_id" text NOT NULL,
	"day" date NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_org_id_day_pk" PRIMARY KEY("org_id","day")
);
--> statement-breakpoint
CREATE TABLE "assignments" (
	"org_id" text NOT NULL,
	"thread_id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"message_id" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"r2_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"member_id" text,
	"kind" "mail_action_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "mail_action_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "mailbox_access" (
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"member_id" text NOT NULL,
	"role" "mailbox_access_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_access_mailbox_id_member_id_pk" PRIMARY KEY("mailbox_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "mailbox_folders" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"path" text NOT NULL,
	"role" "folder_role" DEFAULT 'other' NOT NULL,
	"uidvalidity" bigint,
	"uidnext" bigint,
	"highest_modseq" bigint,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_folders_mailbox_id_path_unique" UNIQUE("mailbox_id","path")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"address" text NOT NULL,
	"kind" "mailbox_kind" NOT NULL,
	"provider" "mail_provider" DEFAULT 'purelymail' NOT NULL,
	"credentials_enc" text NOT NULL,
	"status" "mailbox_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_org_id_address_unique" UNIQUE("org_id","address"),
	CONSTRAINT "mailboxes_id_org_id_unique" UNIQUE("id","org_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"folder_id" text,
	"imap_uid" bigint,
	"message_id_header" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_name" text,
	"from_address" text NOT NULL,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"r2_key" text,
	"clean_text" text DEFAULT '' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(subject, '')), 'A')
          || setweight(to_tsvector('english', coalesce(from_name, '') || ' ' || from_address), 'B')
          || setweight(to_tsvector('english', clean_text), 'C')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_folder_id_imap_uid_unique" UNIQUE("folder_id","imap_uid"),
	CONSTRAINT "messages_mailbox_id_message_id_header_unique" UNIQUE("mailbox_id","message_id_header")
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_id" text NOT NULL,
	"expo_token" text NOT NULL,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_state" (
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"member_id" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_state_thread_id_member_id_pk" PRIMARY KEY("thread_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mailbox_id" text NOT NULL,
	"subject_key" text NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"triage" "triage_bucket",
	"triage_confidence" real,
	"triage_source" "triage_source",
	"summary" text,
	"summary_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triage_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"member_id" text NOT NULL,
	"from_bucket" "triage_bucket",
	"to_bucket" "triage_bucket" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_actions" ADD CONSTRAINT "mail_actions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_actions" ADD CONSTRAINT "mail_actions_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_access" ADD CONSTRAINT "mailbox_access_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_access" ADD CONSTRAINT "mailbox_access_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD CONSTRAINT "mailbox_folders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_folders" ADD CONSTRAINT "mailbox_folders_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_folder_id_mailbox_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mailbox_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_state" ADD CONSTRAINT "thread_state_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_summary_message_id_messages_id_fk" FOREIGN KEY ("summary_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_mailbox_org_fk" FOREIGN KEY ("mailbox_id","org_id") REFERENCES "public"."mailboxes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_feedback" ADD CONSTRAINT "triage_feedback_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_feedback" ADD CONSTRAINT "triage_feedback_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_feedback" ADD CONSTRAINT "triage_feedback_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_userId_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitations_organizationId_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "members_organizationId_idx" ON "members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "members_userId_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkeys_userId_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkeys_credentialID_idx" ON "passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "sessions_userId_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "attachments_message_id_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mail_actions_claim_idx" ON "mail_actions" USING btree ("run_after") WHERE "mail_actions"."status" in ('pending', 'running');--> statement-breakpoint
CREATE INDEX "mailbox_access_member_id_idx" ON "mailbox_access" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "messages_thread_id_sent_at_idx" ON "messages" USING btree ("thread_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_search_vector_idx" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_expo_token_unique" ON "push_tokens" USING btree ("expo_token");--> statement-breakpoint
CREATE INDEX "push_tokens_member_id_idx" ON "push_tokens" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "threads_mailbox_list_idx" ON "threads" USING btree ("mailbox_id","archived","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "threads_mailbox_triage_idx" ON "threads" USING btree ("mailbox_id","triage","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "triage_feedback_org_id_created_at_idx" ON "triage_feedback" USING btree ("org_id","created_at");