import { foreignKey, index, integer, pgTable, primaryKey, text, unique } from "drizzle-orm/pg-core";
import { id, orgId, timestamptz } from "../columns.ts";
import { storageNodes } from "../storage.ts";

/**
 * How far a live document's change log has been copied into `storage_doc_changes`: the epoch and
 * the last record journaled, and the file's `content_version` when it was. A doc saved since
 * (`storage_nodes.content_version` above it) is owed a journal run.
 */
export const storageDocJournals = pgTable(
  "storage_doc_journals",
  {
    nodeId: text("node_id").primaryKey(),
    orgId: orgId(),
    epoch: integer("epoch").notNull(),
    lastSeq: integer("last_seq").notNull(),
    contentVersion: integer("content_version").notNull(),
    /** Rows written since the epoch's latest baseline: at 500 the next run writes another. */
    sinceBaseline: integer("since_baseline").notNull().default(0),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "storage_doc_journals_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    index("storage_doc_journals_org_id_idx").on(t.orgId),
  ],
);

/**
 * A live document's change log, kept: one row per run of consecutive records by one author (cut
 * at a minute, or at anyone else's record), as one merged Yjs update in base64. Rows keep the
 * stream's order (`first_seq`), and a replay applies them in it over a baseline of the same epoch.
 */
export const storageDocChanges = pgTable(
  "storage_doc_changes",
  {
    id: id(),
    orgId: orgId(),
    nodeId: text("node_id").notNull(),
    epoch: integer("epoch").notNull(),
    firstSeq: integer("first_seq").notNull(),
    lastSeq: integer("last_seq").notNull(),
    /** The records' `by`: `m:<memberId>`, `a:<memberId>:<agent>`, or `unknown` before stamping. */
    by: text("by").notNull(),
    /** The author's name when it was journaled, so a member who left is still named. */
    authorName: text("author_name"),
    agent: text("agent"),
    startedAt: timestamptz("started_at").notNull(),
    endedAt: timestamptz("ended_at").notNull(),
    update: text("update").notNull(),
    /** The file's `content_version` when the run was journaled. */
    contentVersion: integer("content_version").notNull(),
  },
  (t) => [
    foreignKey({
      name: "storage_doc_changes_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    unique("storage_doc_changes_run_key").on(t.nodeId, t.epoch, t.firstSeq),
    index("storage_doc_changes_node_started_idx").on(t.nodeId, t.startedAt),
    index("storage_doc_changes_ended_at_idx").on(t.endedAt),
    index("storage_doc_changes_org_id_idx").on(t.orgId),
  ],
);

/**
 * Yjs state a replay starts from: an epoch's seed (or the snap the journal began at), and a
 * checkpoint every 500 runs after it, through record `seq`.
 */
export const storageDocBaselines = pgTable(
  "storage_doc_baselines",
  {
    orgId: orgId(),
    nodeId: text("node_id").notNull(),
    epoch: integer("epoch").notNull(),
    seq: integer("seq").notNull(),
    state: text("state").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.epoch, t.seq] }),
    foreignKey({
      name: "storage_doc_baselines_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    index("storage_doc_baselines_org_id_idx").on(t.orgId),
  ],
);
