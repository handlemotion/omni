CREATE TABLE "storage_folder_icons" (
	"node_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"icon" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_folder_icons" ADD CONSTRAINT "storage_folder_icons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_folder_icons" ADD CONSTRAINT "storage_folder_icons_node_org_fk" FOREIGN KEY ("node_id","org_id") REFERENCES "public"."storage_nodes"("id","org_id") ON DELETE cascade ON UPDATE no action;