CREATE TABLE "talk_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"author_member_id" text NOT NULL,
	"body" text,
	"file_node_id" text,
	"file_name" text,
	"file_size" bigint,
	"file_mime" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talk_messages_has_content" CHECK ("talk_messages"."body" is not null or "talk_messages"."file_name" is not null)
);
--> statement-breakpoint
CREATE TABLE "talk_reactions" (
	"org_id" text NOT NULL,
	"message_id" text NOT NULL,
	"member_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "talk_reactions_message_id_member_id_emoji_pk" PRIMARY KEY("message_id","member_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "talk_reads" (
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"member_id" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "talk_reads_thread_id_member_id_pk" PRIMARY KEY("thread_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "talk_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"member_a_id" text NOT NULL,
	"member_b_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	CONSTRAINT "talk_threads_id_org_id_unique" UNIQUE("id","org_id"),
	CONSTRAINT "talk_threads_pair_unique" UNIQUE("org_id","member_a_id","member_b_id"),
	CONSTRAINT "talk_threads_pair_sorted" CHECK ("talk_threads"."member_a_id" < "talk_threads"."member_b_id")
);
--> statement-breakpoint
ALTER TABLE "talk_messages" ADD CONSTRAINT "talk_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_messages" ADD CONSTRAINT "talk_messages_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_messages" ADD CONSTRAINT "talk_messages_file_node_id_storage_nodes_id_fk" FOREIGN KEY ("file_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_messages" ADD CONSTRAINT "talk_messages_thread_org_fk" FOREIGN KEY ("thread_id","org_id") REFERENCES "public"."talk_threads"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_reactions" ADD CONSTRAINT "talk_reactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_reactions" ADD CONSTRAINT "talk_reactions_message_id_talk_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."talk_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_reactions" ADD CONSTRAINT "talk_reactions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_reads" ADD CONSTRAINT "talk_reads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_reads" ADD CONSTRAINT "talk_reads_thread_id_talk_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."talk_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_reads" ADD CONSTRAINT "talk_reads_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_threads" ADD CONSTRAINT "talk_threads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_threads" ADD CONSTRAINT "talk_threads_member_a_id_members_id_fk" FOREIGN KEY ("member_a_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "talk_threads" ADD CONSTRAINT "talk_threads_member_b_id_members_id_fk" FOREIGN KEY ("member_b_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "talk_messages_thread_idx" ON "talk_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "talk_messages_file_node_idx" ON "talk_messages" USING btree ("file_node_id");--> statement-breakpoint
CREATE INDEX "talk_reactions_member_idx" ON "talk_reactions" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "talk_reads_member_idx" ON "talk_reads" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "talk_threads_member_b_idx" ON "talk_threads" USING btree ("member_b_id");