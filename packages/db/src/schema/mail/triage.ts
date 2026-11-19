import { sql } from "drizzle-orm";
import { bigint, date, index, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { id, orgId, memberId, createdAt } from "../columns.ts";
import { triageBucket } from "./enums.ts";
import { threads } from "./messages.ts";

export const triageFeedback = pgTable(
  "triage_feedback",
  {
    id: id(),
    orgId: orgId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    memberId: memberId(),
    fromBucket: triageBucket("from_bucket"),
    toBucket: triageBucket("to_bucket").notNull(),
    /** The request's `Idempotency-Key`, so a retried re-sort cannot apply twice. */
    requestKey: text("request_key"),
    createdAt: createdAt(),
  },
  (t) => [
    index("triage_feedback_org_id_created_at_idx").on(t.orgId, t.createdAt),
    uniqueIndex("triage_feedback_request_key_unique")
      .on(t.memberId, t.threadId, t.requestKey)
      .where(sql`${t.requestKey} is not null`),
  ],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    orgId: orgId(),
    day: date("day", { mode: "string" }).notNull(),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] })],
);
