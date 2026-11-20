ALTER TABLE "crm_contracts" ADD COLUMN "signature_request_id" text;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD COLUMN "signed_node_id" text;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_signed_node_id_storage_nodes_id_fk" FOREIGN KEY ("signed_node_id") REFERENCES "public"."storage_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_signature_request_fk" FOREIGN KEY ("signature_request_id") REFERENCES "public"."storage_signature_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_contracts_signature_request_id_idx" ON "crm_contracts" USING btree ("signature_request_id");--> statement-breakpoint
CREATE INDEX "crm_contracts_signed_node_id_idx" ON "crm_contracts" USING btree ("signed_node_id");