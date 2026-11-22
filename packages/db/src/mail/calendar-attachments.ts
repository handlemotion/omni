import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  attachments,
  CALENDAR_ATTACHMENT,
  mailboxes,
  mailboxFolders,
  messageLocations,
  messages,
} from "../schema/index.ts";

/** The most calendar attachments one read returns. */
export const CALENDAR_ATTACHMENTS_MAX = 500;

/**
 * An iCalendar attachment, with what the calendar needs to judge it: whose inbox it reached, who
 * sent it, and which folders hold it. Read by the calendar's sweep, never by a person.
 */
export interface CalendarAttachment {
  id: string;
  orgId: string;
  mailboxId: string;
  /** The inbox's own address: "me" among an event's attendees. */
  mailboxAddress: string;
  messageId: string;
  threadId: string;
  r2Key: string;
  size: number;
  createdAt: Date;
  /** The message's From, as stored (lowercase). */
  fromAddress: string;
  /** The roles of the folders the message is in (`inbox`, `sent`, `junk`, …). */
  folderRoles: string[];
}

function select(db: Db, where: SQL | undefined, limit: number) {
  return db
    .select({
      id: attachments.id,
      orgId: attachments.orgId,
      mailboxId: messages.mailboxId,
      mailboxAddress: mailboxes.address,
      messageId: messages.id,
      threadId: messages.threadId,
      r2Key: attachments.r2Key,
      size: attachments.size,
      createdAt: attachments.createdAt,
      fromAddress: messages.fromAddress,
      folderRoles: sql<
        string[]
      >`coalesce((select array_agg(distinct ${mailboxFolders.role}::text) from ${messageLocations} join ${mailboxFolders} on ${mailboxFolders.id} = ${messageLocations.folderId} where ${messageLocations.messageId} = ${messages.id}), '{}')`,
    })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .innerJoin(
      mailboxes,
      and(eq(mailboxes.id, messages.mailboxId), eq(mailboxes.orgId, messages.orgId)),
    )
    .where(and(CALENDAR_ATTACHMENT, where))
    .orderBy(asc(attachments.createdAt), asc(attachments.id))
    .limit(Math.min(Math.max(limit, 1), CALENDAR_ATTACHMENTS_MAX));
}

/**
 * Calendar attachments stored after `after` (by `created_at`, then `id`) and before `before`,
 * oldest first: the sweep's next page. Served by `attachments_calendar_idx`.
 */
export async function calendarAttachments(
  db: Db,
  options: { after: { at: Date; id: string } | null; before: Date; limit: number },
) {
  const after = options.after
    ? sql`(${attachments.createdAt}, ${attachments.id}) > (${options.after.at.toISOString()}::timestamptz, ${options.after.id})`
    : undefined;
  const before = sql`${attachments.createdAt} < ${options.before.toISOString()}::timestamptz`;
  const rows = await select(db, and(after, before), options.limit);
  return rows satisfies CalendarAttachment[];
}

/** The calendar attachments of these messages: what a fresh arrival brought. */
export async function calendarAttachmentsOf(db: Db, messageIds: readonly string[]) {
  if (messageIds.length === 0) return [] satisfies CalendarAttachment[];
  const ids = [...new Set(messageIds)];
  const rows = await select(db, inArray(attachments.messageId, ids), CALENDAR_ATTACHMENTS_MAX);
  return rows satisfies CalendarAttachment[];
}
