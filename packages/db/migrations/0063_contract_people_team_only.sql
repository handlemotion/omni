CREATE TABLE "crm_contract_people" (
	"contract_id" text NOT NULL,
	"member_id" text NOT NULL,
	"org_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contract_people_contract_id_member_id_pk" PRIMARY KEY("contract_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "storage_nodes" ADD COLUMN "team_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_contract_people" ADD CONSTRAINT "crm_contract_people_contract_id_crm_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."crm_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contract_people" ADD CONSTRAINT "crm_contract_people_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contract_people" ADD CONSTRAINT "crm_contract_people_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_contract_people_member_id_idx" ON "crm_contract_people" USING btree ("member_id");