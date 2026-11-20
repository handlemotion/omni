import { foreignKey, index, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { createdAt, id, orgId, timestamptz } from "../columns.ts";
import { storageNodes } from "../storage.ts";

/**
 * Where a comment points. Coordinates on a PDF page or an image are fractions of it (0 to 1), so they
 * hold at any zoom. Lines and cells count from 1. Text is a doc's passage, by its words and the
 * characters just before and after them. The contract's zod schema is the truth; this
 * type only shapes the column.
 */
export type StorageCommentAnchor =
  | { kind: "file" }
  | { kind: "pdf"; page: number; x: number; y: number; width: number; height: number }
  | { kind: "image"; x: number; y: number; width: number; height: number }
  | { kind: "lines"; start: number; end: number }
  | { kind: "text"; quote: string; prefix: string; suffix: string }
  | { kind: "cell"; sheet?: string; row: number; column: number };

/**
 * A comment, or a reply to one. A thread is a root (`parent_id` null) and its replies; the root
 * carries the anchor and the resolved state, and a reply carries neither.
 */
export const storageComments = pgTable(
  "storage_comments",
  {
    id: id(),
    orgId: orgId(),
    nodeId: text("node_id").notNull(),
    /** The thread's root; null on the root itself. */
    parentId: text("parent_id"),
    /** The file's `content_version` when the comment was made: the content its anchor is on. */
    contentVersion: integer("content_version").notNull(),
    anchor: jsonb("anchor").$type<StorageCommentAnchor>(),
    body: text("body").notNull(),
    /**
     * The author. May be a member of another workspace, as a person with a grant is. Null once
     * that member is gone; the comment stays.
     */
    authorMemberId: text("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    /** Set when the author last changed the body; null if never. */
    editedAt: timestamptz("edited_at"),
    /** A root only: when the thread was resolved, and by whom. Null while it is open. */
    resolvedAt: timestamptz("resolved_at"),
    resolvedByMemberId: text("resolved_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    unique("storage_comments_id_org_id_unique").on(t.id, t.orgId),
    foreignKey({
      name: "storage_comments_node_org_fk",
      columns: [t.nodeId, t.orgId],
      foreignColumns: [storageNodes.id, storageNodes.orgId],
    }).onDelete("cascade"),
    foreignKey({
      name: "storage_comments_parent_org_fk",
      columns: [t.parentId, t.orgId],
      foreignColumns: [t.id, t.orgId],
    }).onDelete("cascade"),
    index("storage_comments_node_id_idx").on(t.nodeId, t.createdAt, t.id),
    index("storage_comments_parent_id_idx").on(t.parentId),
    index("storage_comments_author_member_id_idx").on(t.authorMemberId),
    index("storage_comments_resolved_by_member_id_idx").on(t.resolvedByMemberId),
  ],
);
