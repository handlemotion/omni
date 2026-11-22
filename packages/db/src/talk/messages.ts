import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { talkMessages, talkReactions, talkThreads } from "../schema/talk.ts";
import { NOT_FOUND, threadOf, type Ex, type TalkMember } from "./core.ts";

export const TALK_BODY_MAX = 4_000;
export const TALK_PAGE_MAX = 100;
export const TALK_PREVIEW_MAX = 120;
/** How many different emoji one person may leave on one note. */
export const TALK_REACTIONS_PER_PERSON = 8;
const EMOJI_MAX_BYTES = 16;

export interface TalkFile {
  nodeId: string | null;
  name: string;
  size: number;
  mimeType: string | null;
}

export interface TalkReaction {
  emoji: string;
  memberIds: string[];
}

export interface TalkMessage {
  id: string;
  threadId: string;
  authorMemberId: string;
  body: string | null;
  file: TalkFile | null;
  reactions: TalkReaction[];
  /** Goes up with every change to the reactions; a client keeps the highest it has seen. */
  reactionsVersion: number;
  createdAt: Date;
}

type MessageRow = typeof talkMessages.$inferSelect;

const fileOf = (row: MessageRow) =>
  row.fileName === null
    ? null
    : ({
        nodeId: row.fileNodeId,
        name: row.fileName,
        size: row.fileSize ?? 0,
        mimeType: row.fileMime,
      } satisfies TalkFile);

const toMessage = (row: MessageRow, reactions: TalkReaction[] = []) =>
  ({
    id: row.id,
    threadId: row.threadId,
    authorMemberId: row.authorMemberId,
    body: row.body,
    file: fileOf(row),
    reactions,
    reactionsVersion: row.reactionsVersion,
    createdAt: row.createdAt,
  }) satisfies TalkMessage;

/** What a notification says about a note: its first words, or the file's name. */
export const previewOf = (message: Pick<TalkMessage, "body" | "file">) => {
  const text = (message.body ?? "").replace(/\s+/g, " ").trim();
  const preview = text || message.file?.name || "";
  return preview.length > TALK_PREVIEW_MAX ? `${preview.slice(0, TALK_PREVIEW_MAX - 1)}…` : preview;
};

/**
 * The thread's notes, newest first, `before` a message id when paging back. The thread check and
 * the page go out together (one round trip on a pipelining client), then the reactions of exactly
 * the notes shown; the page is dropped unread when `me` is not one of the two.
 */
export async function listMessages(
  ex: Ex,
  me: TalkMember,
  threadId: string,
  page: { before?: string | null; limit?: number } = {},
) {
  const limit = Math.min(Math.max(page.limit ?? 50, 1), TALK_PAGE_MAX);
  const inPage = and(
    eq(talkMessages.threadId, threadId),
    eq(talkMessages.orgId, me.orgId),
    page.before ? lt(talkMessages.id, page.before) : undefined,
  );
  const [thread, rows] = await Promise.all([
    threadOf(ex, me, threadId),
    ex
      .select()
      .from(talkMessages)
      .where(inPage)
      .orderBy(desc(talkMessages.id))
      .limit(limit + 1),
  ]);
  if (!thread) return NOT_FOUND;
  const shown = rows.slice(0, limit);
  const reactions = await reactionsOf(
    ex,
    shown.map((row) => row.id),
  );
  return {
    status: "ok",
    thread: { id: thread.id, otherMemberId: thread.otherMemberId },
    messages: shown.map((row) => ({
      ...toMessage(row, reactions.byMessage.get(row.id)),
      reactionsVersion: reactions.versions.get(row.id) ?? row.reactionsVersion,
    })),
    more: rows.length > limit,
  } as const;
}

async function reactionsOf(ex: Ex, messageIds: string[]) {
  const byMessage = new Map<string, TalkReaction[]>();
  const versions = new Map<string, number>();
  if (messageIds.length === 0) return { byMessage, versions };
  // WARNING: one statement, so each note's reactions and version come from the same snapshot.
  const rows = await ex
    .select({
      messageId: talkMessages.id,
      version: talkMessages.reactionsVersion,
      emoji: talkReactions.emoji,
      memberIds: sql<
        string[]
      >`array_agg(${talkReactions.memberId} order by ${talkReactions.createdAt})`,
    })
    .from(talkMessages)
    .leftJoin(talkReactions, eq(talkReactions.messageId, talkMessages.id))
    .where(inArray(talkMessages.id, messageIds))
    .groupBy(talkMessages.id, talkMessages.reactionsVersion, talkReactions.emoji)
    .orderBy(sql`min(${talkReactions.createdAt})`);
  for (const row of rows) {
    versions.set(row.messageId, row.version);
    if (row.emoji === null) continue;
    const list = byMessage.get(row.messageId) ?? [];
    list.push({ emoji: row.emoji, memberIds: row.memberIds });
    byMessage.set(row.messageId, list);
  }
  return { byMessage, versions };
}

export type SendResult =
  | { status: "ok"; message: TalkMessage; thread: { id: string; otherMemberId: string } }
  | typeof NOT_FOUND
  | { status: "invalid_body" };

async function insertMessage(
  ex: Ex,
  me: TalkMember,
  threadId: string,
  values: Partial<Pick<MessageRow, "body" | "fileNodeId" | "fileName" | "fileSize" | "fileMime">>,
) {
  // WARNING: stamp the note from the thread row, locked till commit, so a reader never passes it.
  const [stamp] = await ex
    .update(talkThreads)
    .set({ lastMessageAt: sql`greatest(clock_timestamp(), ${talkThreads.lastMessageAt})` })
    .where(
      and(
        eq(talkThreads.id, threadId),
        eq(talkThreads.orgId, me.orgId),
        sql`${me.id} in (${talkThreads.memberAId}, ${talkThreads.memberBId})`,
      ),
    )
    .returning({
      at: talkThreads.lastMessageAt,
      a: talkThreads.memberAId,
      b: talkThreads.memberBId,
    });
  if (!stamp) return NOT_FOUND;
  const [row] = await ex
    .insert(talkMessages)
    .values({ orgId: me.orgId, threadId, authorMemberId: me.id, createdAt: stamp.at!, ...values })
    .returning();
  return {
    status: "ok",
    message: toMessage(row!),
    thread: { id: threadId, otherMemberId: stamp.a === me.id ? stamp.b : stamp.a },
  } satisfies SendResult;
}

/** A text note from `me`. */
export async function sendNote(ex: Ex, me: TalkMember, threadId: string, body: string) {
  const text = body.trim();
  if (!text || text.length > TALK_BODY_MAX) return { status: "invalid_body" } as const;
  return insertMessage(ex, me, threadId, { body: text });
}

/**
 * A file `me` dropped in the thread: a Storage node the Worker made in their My files and granted
 * to the other one. Talk keeps what was sent; Storage decides who opens it.
 */
export async function recordFile(
  ex: Ex,
  me: TalkMember,
  threadId: string,
  file: { nodeId: string; name: string; size: number; mimeType: string | null },
) {
  return insertMessage(ex, me, threadId, {
    fileNodeId: file.nodeId,
    fileName: file.name,
    fileSize: file.size,
    fileMime: file.mimeType,
  });
}

/** One emoji, flags and keycaps included: a single grapheme of at most `EMOJI_MAX_BYTES`. */
export const isEmoji = (value: string) => {
  if (!value || new TextEncoder().encode(value).length > EMOJI_MAX_BYTES) return false;
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return (
    graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)
  );
};

export type ReactResult =
  | {
      status: "ok";
      thread: { id: string; otherMemberId: string };
      /** The note's reactions as they now are. */
      reactions: TalkReaction[];
      /** The note's reaction version after this change: a later change has a higher one. */
      reactionsVersion: number;
    }
  | typeof NOT_FOUND
  | { status: "invalid_emoji" }
  | { status: "too_many_reactions" };

async function messageThread(ex: Ex, me: TalkMember, messageId: string) {
  const [row] = await ex
    .select({ threadId: talkMessages.threadId })
    .from(talkMessages)
    .where(and(eq(talkMessages.id, messageId), eq(talkMessages.orgId, me.orgId)));
  return row ? threadOf(ex, me, row.threadId) : null;
}

/** Adds or takes away `me`'s emoji on a note in one of their threads. Safe to call twice. */
export async function react(ex: Ex, me: TalkMember, messageId: string, emoji: string, on: boolean) {
  if (!isEmoji(emoji)) return { status: "invalid_emoji" } satisfies ReactResult;
  const thread = await messageThread(ex, me, messageId);
  if (!thread) return NOT_FOUND satisfies ReactResult;
  // WARNING: one lock per note, not per person, so each snapshot below has every committed reaction.
  await ex.execute(sql`select pg_advisory_xact_lock(hashtext(${`talk-react:${messageId}`}))`);
  const mine = and(eq(talkReactions.messageId, messageId), eq(talkReactions.memberId, me.id));
  if (!on) {
    await ex.delete(talkReactions).where(and(mine, eq(talkReactions.emoji, emoji)));
  } else {
    const [{ count } = { count: 0 }] = await ex
      .select({ count: sql<number>`count(*)::int` })
      .from(talkReactions)
      .where(and(mine, sql`${talkReactions.emoji} <> ${emoji}`));
    if (count >= TALK_REACTIONS_PER_PERSON) {
      return { status: "too_many_reactions" } satisfies ReactResult;
    }
    await ex
      .insert(talkReactions)
      .values({ orgId: me.orgId, messageId, memberId: me.id, emoji })
      .onConflictDoNothing();
  }
  const [[bumped], now] = await Promise.all([
    ex
      .update(talkMessages)
      .set({ reactionsVersion: sql`${talkMessages.reactionsVersion} + 1` })
      .where(eq(talkMessages.id, messageId))
      .returning({ version: talkMessages.reactionsVersion }),
    reactionsOf(ex, [messageId]),
  ]);
  return {
    status: "ok",
    thread: { id: thread.id, otherMemberId: thread.otherMemberId },
    reactions: now.byMessage.get(messageId) ?? [],
    reactionsVersion: bumped!.version,
  } satisfies ReactResult;
}

/** The Drive file a note in one of `me`'s threads carries, and whether `me` sent it. */
export async function fileOfMessage(ex: Ex, me: TalkMember, messageId: string) {
  const [row] = await ex
    .select()
    .from(talkMessages)
    .where(and(eq(talkMessages.id, messageId), eq(talkMessages.orgId, me.orgId)));
  if (!row?.fileNodeId || !(await threadOf(ex, me, row.threadId))) return NOT_FOUND;
  return { status: "ok", nodeId: row.fileNodeId, sent: row.authorMemberId === me.id } as const;
}
