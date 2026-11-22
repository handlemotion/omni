CREATE TABLE "storage_doc_baselines" (
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"seq" integer NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_doc_baselines_node_id_epoch_seq_pk" PRIMARY KEY("node_id","epoch","seq")
);
--> statement-breakpoint
CREATE TABLE "storage_doc_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"first_seq" integer NOT NULL,
	"last_seq" integer NOT NULL,
	"by" text NOT NULL,
	"author_name" text,
	"agent" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"update" text NOT NULL,
	"content_version" integer NOT NULL,
	CONSTRAINT "storage_doc_changes_run_key" UNIQUE("node_id","epoch","first_seq")
);
--> statement-breakpoint
CREATE TABLE "storage_doc_journals" (
	"node_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"last_seq" integer NOT NULL,
	"content_version" integer NOT NULL,
	"since_baseline" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_doc_baselines" ADD CONSTRAINT "storage_doc_baselines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_doc_baselines" ADD CONSTRAINT "storage_doc_baselines_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_doc_changes" ADD CONSTRAINT "storage_doc_changes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_doc_changes" ADD CONSTRAINT "storage_doc_changes_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_doc_journals" ADD CONSTRAINT "storage_doc_journals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_doc_journals" ADD CONSTRAINT "storage_doc_journals_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_doc_baselines_org_id_idx" ON "storage_doc_baselines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "storage_doc_changes_node_started_idx" ON "storage_doc_changes" USING btree ("node_id","started_at");--> statement-breakpoint
CREATE INDEX "storage_doc_changes_ended_at_idx" ON "storage_doc_changes" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "storage_doc_changes_org_id_idx" ON "storage_doc_changes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "storage_doc_journals_org_id_idx" ON "storage_doc_journals" USING btree ("org_id");