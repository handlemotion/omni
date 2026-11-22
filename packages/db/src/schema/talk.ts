import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { members } from "./auth.ts";
import { createdAt, id, orgId, timestamptz } from "./columns.ts";
import { storageNodes } from "./storage.ts";

const member = (name: string) =>
  text(name)
    .notNull()
    .references(() => members.id, { onDelete: "cascade" });

/**
 * The one direct thread between two teammates of a workspace (`docs/spec/talk.md`). The pair is
 * kept in sorted order, so it has exactly one row.
 */
export const talkThreads = pgTable(
  "talk_threads",
  {
    id: id(),
    orgId: orgId(),
    memberAId: member("member_a_id"),
    memberBId: member("member_b_id"),
    createdAt: createdAt(),
    lastMessageAt: timestamptz("last_message_at"),
  },
  (t) => [
    unique("talk_threads_id_org_id_unique").on(t.id, t.orgId),
    unique("talk_threads_pair_unique").on(t.orgId, t.memberAId, t.memberBId),
    check("talk_threads_pair_sorted", sql`${t.memberAId} < ${t.memberBId}`),
    index("talk_threads_member_b_idx").on(t.memberBId),
  ],
);

/**
 * A note in a thread: text, a file, or both. A file is a Storage node in the sender's My files,
 * granted to the other person; its name, size and type are what was sent.
 */
export const talkMessages = pgTable(
  "talk_messages",
  {
    id: id(),
    orgId: orgId(),
    threadId: text("thread_id").notNull(),
    authorMemberId: member("author_member_id"),
    body: text("body"),
    fileNodeId: text("file_node_id").references(() => storageNodes.id, { onDelete: "set null" }),
    fileName: text("file_name"),
    fileSize: bigint("file_size", { mode: "number" }),
    fileMime: text("file_mime"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "talk_messages_thread_org_fk",
      columns: [t.threadId, t.orgId],
      foreignColumns: [talkThreads.id, talkThreads.orgId],
    }).onDelete("cascade"),
    check("talk_messages_has_content", sql`${t.body} is not null or ${t.fileName} is not null`),
    index("talk_messages_thread_idx").on(t.threadId, t.id),
    index("talk_messages_file_node_idx").on(t.fileNodeId),
  ],
);

/** One person's emoji on a note. */
export const talkReactions = pgTable(
  "talk_reactions",
  {
    orgId: orgId(),
    messageId: text("message_id")
      .notNull()
      .references(() => talkMessages.id, { onDelete: "cascade" }),
    memberId: member("member_id"),
    emoji: text("emoji").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.memberId, t.emoji] }),
    index("talk_reactions_member_idx").on(t.memberId),
  ],
);

/** How far one of the two has read a thread: the other's notes after `read_at` are unread. */
export const talkReads = pgTable(
  "talk_reads",
  {
    orgId: orgId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => talkThreads.id, { onDelete: "cascade" }),
    memberId: member("member_id"),
    readAt: timestamptz("read_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.memberId] }),
    index("talk_reads_member_idx").on(t.memberId),
  ],
);
