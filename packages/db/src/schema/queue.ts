import { index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { id, orgId, createdAt } from "./columns.ts";

/**
 * Background jobs that will not run again: Cloudflare Queue messages that reached the dead-letter
 * queue. Failed outbox actions stay in `mail_actions` (status `failed`); the dead-letter listing
 * reads both. Keyed by `job_id`, so recording one twice (the consumer's last attempt and the DLQ
 * consumer) keeps the first row, which has the error.
 */
export const deadLetters = pgTable(
  "dead_letters",
  {
    id: id(),
    orgId: orgId(),
    /** The queue the job came from, e.g. `omni-ai`. */
    queue: text("queue").notNull(),
    jobId: text("job_id").notNull().unique(),
    /** The job body: ids only, never mail content. */
    job: jsonb("job").$type<Record<string, unknown>>().notNull(),
    /** Null when the consumer died without reporting one; the logs have the job id. */
    error: text("error"),
    attempts: integer("attempts").notNull(),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [index("dead_letters_created_idx").on(t.createdAt)],
);
