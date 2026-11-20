CREATE TYPE "public"."storage_text_status" AS ENUM('ok', 'empty', 'unsupported', 'too_large', 'failed');--> statement-breakpoint
CREATE TABLE "storage_texts" (
	"node_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"content_version" integer NOT NULL,
	"status" "storage_text_status" NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', left(text, 150000))) STORED NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_texts" ADD CONSTRAINT "storage_texts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_texts" ADD CONSTRAINT "storage_texts_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_texts_org_id_idx" ON "storage_texts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "storage_texts_search_vector_idx" ON "storage_texts" USING gin ("search_vector");