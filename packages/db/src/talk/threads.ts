import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { storageAddresses } from "../storage.ts";
import { talkReads, talkThreads } from "../schema/talk.ts";
import {
  isTeammateRole,
  NOT_FOUND,
  pairOf,
  teammateOf,
  threadOf,
  type Ex,
  type TalkMember,
} from "./core.ts";

/** A teammate as Talk lists them, with the thread between you, if there is one yet. */
export interface TalkPerson {
  memberId: string;
  name: string;
  email: string;
  image: string | null;
  threadId: string | null;
  /** Their notes you have not read. */
  unread: number;
  lastMessageAt: Date | null;
}

/** Every teammate but `me`, with your thread with each and its unread count. */
export async function listPeople(ex: Ex, me: TalkMember) {
  const rows = await ex
    .select({
      memberId: members.id,
      role: members.role,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, me.orgId), ne(members.id, me.id)));
  const threads = await ex
    .select({
      id: talkThreads.id,
      a: talkThreads.memberAId,
      b: talkThreads.memberBId,
      lastMessageAt: talkThreads.lastMessageAt,
      // WARNING: drizzle leaves the outer table off its columns; a bare "id" here is the note's.
      unread: sql<number>`(
        select count(*)::int from talk_messages m
        where m.thread_id = "talk_threads"."id"
          and m.author_member_id <> ${me.id}
          and m.created_at > coalesce((
            select r.read_at from talk_reads r
            where r.thread_id = "talk_threads"."id" and r.member_id = ${me.id}
          ), '-infinity'::timestamptz)
      )`,
    })
    .from(talkThreads)
    .where(
      and(
        eq(talkThreads.orgId, me.orgId),
        sql`${me.id} in (${talkThreads.memberAId}, ${talkThreads.memberBId})`,
      ),
    );
  const byOther = new Map(threads.map((t) => [t.a === me.id ? t.b : t.a, t]));
  const people: TalkPerson[] = rows
    .filter((row) => isTeammateRole(row.role))
    .map((row) => {
      const thread = byOther.get(row.memberId);
      return {
        memberId: row.memberId,
        name: row.name,
        email: row.email,
        image: row.image,
        threadId: thread?.id ?? null,
        unread: thread?.unread ?? 0,
        lastMessageAt: thread?.lastMessageAt ?? null,
      };
    })
    .sort((x, y) => x.name.localeCompare(y.name));
  return { status: "ok", people } as const;
}

export type OpenThreadResult =
  | { status: "ok"; thread: { id: string; otherMemberId: string }; created: boolean }
  | typeof NOT_FOUND;

/** The thread between `me` and the teammate, made on first use. Safe to call twice. */
export async function openThread(ex: Ex, me: TalkMember, memberId: string) {
  const other = await teammateOf(ex, me, memberId);
  if (!other) return NOT_FOUND satisfies OpenThreadResult;
  const [memberAId, memberBId] = pairOf(me.id, other.id);
  const [made] = await ex
    .insert(talkThreads)
    .values({ orgId: me.orgId, memberAId, memberBId })
    .onConflictDoNothing({
      target: [talkThreads.orgId, talkThreads.memberAId, talkThreads.memberBId],
    })
    .returning({ id: talkThreads.id });
  const id =
    made?.id ??
    (
      await ex
        .select({ id: talkThreads.id })
        .from(talkThreads)
        .where(
          and(
            eq(talkThreads.orgId, me.orgId),
            eq(talkThreads.memberAId, memberAId),
            eq(talkThreads.memberBId, memberBId),
          ),
        )
    )[0]!.id;
  return {
    status: "ok",
    thread: { id, otherMemberId: other.id },
    created: made !== undefined,
  } satisfies OpenThreadResult;
}

/**
 * The thread, when `me` is in it and the other one is still a teammate, with who they are and the
 * address a file shared with them opens from in this workspace, scoped sessions included.
 */
export async function getThread(db: Db, me: TalkMember, threadId: string) {
  const thread = await threadOf(db, me, threadId);
  const other = thread ? await teammateOf(db, me, thread.otherMemberId) : null;
  if (!thread || !other) return NOT_FOUND;
  const inWorkspace = await storageAddresses(db, other.userId, me.orgId);
  const primary = other.email.toLowerCase();
  return {
    status: "ok",
    thread: { id: thread.id, otherMemberId: thread.otherMemberId },
    other: {
      name: other.name,
      email: other.email,
      shareTo: inWorkspace.includes(primary) ? primary : (inWorkspace[0] ?? primary),
    },
  } as const;
}

/** Reads the thread up to now. */
export async function readThread(ex: Ex, me: TalkMember, threadId: string) {
  const thread = await threadOf(ex, me, threadId);
  if (!thread) return NOT_FOUND;
  // WARNING: read only up to the last committed note; one still sending is stamped later.
  const readAt = sql`(select coalesce(${talkThreads.lastMessageAt}, ${talkThreads.createdAt}) from ${talkThreads} where ${talkThreads.id} = ${threadId})`;
  const [row] = await ex
    .insert(talkReads)
    .values({ orgId: me.orgId, threadId, memberId: me.id, readAt })
    .onConflictDoUpdate({
      target: [talkReads.threadId, talkReads.memberId],
      set: { readAt: sql`greatest(${talkReads.readAt}, excluded.read_at)` },
    })
    .returning({ readAt: talkReads.readAt });
  return { status: "ok", readAt: row!.readAt } as const;
}
