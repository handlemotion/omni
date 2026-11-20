CREATE TYPE "public"."crm_deliverable_status" AS ENUM('draft', 'in_review', 'approved', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."crm_milestone_status" AS ENUM('planned', 'in_progress', 'done');--> statement-breakpoint
CREATE TYPE "public"."crm_project_scope" AS ENUM('freelancer', 'client');--> statement-breakpoint
CREATE TABLE "crm_deliverables" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"milestone_id" text,
	"title" text NOT NULL,
	"description" text,
	"node_id" text,
	"due_on" date,
	"status" "crm_deliverable_status" DEFAULT 'draft' NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_email" text,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"target_on" date,
	"status" "crm_milestone_status" DEFAULT 'planned' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_portals" (
	"deal_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"folder_node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"deal_id" text NOT NULL,
	"email" text NOT NULL,
	"scope" "crm_project_scope" NOT NULL,
	"added_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_project_members_deal_email_unique" UNIQUE("deal_id","email")
);
--> statement-breakpoint
ALTER TABLE "crm_deliverables" ADD CONSTRAINT "crm_deliverables_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deliverables" ADD CONSTRAINT "crm_deliverables_milestone_id_crm_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."crm_milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deliverables" ADD CONSTRAINT "crm_deliverables_node_id_storage_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deliverables" ADD CONSTRAINT "crm_deliverables_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deliverables" ADD CONSTRAINT "crm_deliverables_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_milestones" ADD CONSTRAINT "crm_milestones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_milestones" ADD CONSTRAINT "crm_milestones_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_milestones" ADD CONSTRAINT "crm_milestones_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_portals" ADD CONSTRAINT "crm_portals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_portals" ADD CONSTRAINT "crm_portals_folder_node_id_storage_nodes_id_fk" FOREIGN KEY ("folder_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_portals" ADD CONSTRAINT "crm_portals_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_project_members" ADD CONSTRAINT "crm_project_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_project_members" ADD CONSTRAINT "crm_project_members_added_by_member_id_members_id_fk" FOREIGN KEY ("added_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_project_members" ADD CONSTRAINT "crm_project_members_deal_org_fk" FOREIGN KEY ("deal_id","org_id") REFERENCES "public"."crm_deals"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_deliverables_deal_idx" ON "crm_deliverables" USING btree ("deal_id","created_at","id");--> statement-breakpoint
CREATE INDEX "crm_deliverables_milestone_id_idx" ON "crm_deliverables" USING btree ("milestone_id") WHERE "crm_deliverables"."milestone_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_deliverables_node_id_idx" ON "crm_deliverables" USING btree ("node_id") WHERE "crm_deliverables"."node_id" is not null;--> statement-breakpoint
CREATE INDEX "crm_deliverables_created_by_member_id_idx" ON "crm_deliverables" USING btree ("created_by_member_id");--> statement-breakpoint
CREATE INDEX "crm_milestones_deal_position_idx" ON "crm_milestones" USING btree ("deal_id","position","id");--> statement-breakpoint
CREATE INDEX "crm_milestones_created_by_member_id_idx" ON "crm_milestones" USING btree ("created_by_member_id");--> statement-breakpoint
CREATE INDEX "crm_portals_folder_node_id_idx" ON "crm_portals" USING btree ("folder_node_id");--> statement-breakpoint
CREATE INDEX "crm_project_members_email_idx" ON "crm_project_members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "crm_project_members_added_by_member_id_idx" ON "crm_project_members" USING btree ("added_by_member_id");