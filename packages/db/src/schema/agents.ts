import { index, pgTable, text } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id } from "./columns.ts";

/**
 * What an agent reported about Wok's MCP tools through `report_feedback`: a tool that failed,
 * answered wrongly, confused it, was slow, or could not do what its person asked. User-level (no
 * `org_id`): it is about Wok, not a workspace's data. Read by the people who build Wok.
 */
export const agentFeedback = pgTable(
  "agent_feedback",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The OAuth client the agent connected as. */
    clientId: text("client_id").notNull(),
    /** `bug`, `wrong_result`, `confusing`, `missing`, `slow` or `other`. */
    kind: text("kind").notNull(),
    /** The tool it is about, when it is about one. */
    tool: text("tool"),
    summary: text("summary").notNull(),
    details: text("details").notNull(),
    proposedFix: text("proposed_fix"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_feedback_created_at_idx").on(t.createdAt)],
);
