CREATE INDEX "attachments_content_hash_idx" ON "attachments" USING btree (split_part("r2_key", '/att/', 2));--> statement-breakpoint
CREATE INDEX "messages_mailbox_id_sent_at_idx" ON "messages" USING btree ("mailbox_id","sent_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "threads_mailbox_page_idx" ON "threads" USING btree ("mailbox_id","archived","last_message_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "threads_mailbox_lane_page_idx" ON "threads" USING btree ("mailbox_id","archived","triage","last_message_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "threads_mailbox_subject_key_idx" ON "threads" USING btree ("mailbox_id","subject_key","last_message_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "threads_summary_message_id_idx" ON "threads" USING btree ("summary_message_id") WHERE "threads"."summary_message_id" is not null;