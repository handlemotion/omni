import { and, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import {
  attachments,
  listUnsubscribes,
  mailboxAccess,
  mailboxes,
  messages,
  threadState,
  threads,
} from "../schema/index.ts";
import type { GrantScope } from "./grants.ts";

const { searchVector: _searchVector, ...messageColumns } = getTableColumns(messages);

export interface ThreadStatePatch {
  read?: boolean;
  later?: boolean;
  deferredUntil?: Date | null;
  doneThrough?: Date | null;
}

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

function snoozedUntilOf(patch: ThreadStatePatch) {
  if (patch.later !== undefined) return patch.later ? "infinity" : null;
  return iso(patch.deferredUntil);
}

function stateUpdates(patch: ThreadStatePatch) {
  const set: Partial<Record<"read" | "snoozedUntil" | "doneThrough" | "updatedAt", SQL>> = {
    updatedAt: sql`now()`,
  };
  if (patch.read !== undefined) set.read = sql`excluded.read`;
  if (patch.later !== undefined || patch.deferredUntil !== undefined) {
    set.snoozedUntil = sql`excluded.snoozed_until`;
  }
  if (patch.doneThrough !== undefined) set.doneThrough = sql`excluded.done_through`;
  return set;
}

/** One thread with its messages and their attachments, and the member's own state of it. */
export function threadDetailQueries({
  db,
  threadGrant,
  threadOrg,
  messageGrant,
  messageOrg,
  myState,
  threadFields,
  legacyDeferredUntil,
}: GrantScope) {
  async function getThreads(threadIds: readonly string[]) {
    if (threadIds.length === 0) return [];
    const ids = [...new Set(threadIds)];
    const [threadRows, rows, files] = await Promise.all([
      db
        .select({
          ...threadFields,
          mailboxAddress: mailboxes.address,
          mailboxKind: mailboxes.kind,
        })
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
        .leftJoin(threadState, myState)
        .where(inArray(threads.id, ids)),
      db
        .select({
          ...messageColumns,
          unsubscribed: sql<boolean>`coalesce(${messages.sentAt} <= ${listUnsubscribes.unsubscribedAt}, false)`,
        })
        .from(messages)
        .innerJoin(...messageGrant)
        .innerJoin(...messageOrg)
        .leftJoin(
          listUnsubscribes,
          and(
            eq(listUnsubscribes.mailboxId, messages.mailboxId),
            eq(listUnsubscribes.sender, sql`lower(${messages.fromAddress})`),
          ),
        )
        .where(inArray(messages.threadId, ids))
        .orderBy(messages.sentAt, messages.id),
      db
        .select(getTableColumns(attachments))
        .from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .innerJoin(...messageGrant)
        .innerJoin(...messageOrg)
        .where(inArray(messages.threadId, ids)),
    ]);
    const byId = new Map(threadRows.map((thread) => [thread.id, thread]));
    return ids.flatMap((id) => {
      const thread = byId.get(id);
      if (!thread) return [];
      return [
        {
          ...thread,
          messages: rows
            .filter((m) => m.threadId === id)
            .map((m) => ({
              ...m,
              attachments: files.filter((a) => a.messageId === m.id),
            })),
        },
      ];
    });
  }

  return {
    getThreads,

    async getThread(threadId: string) {
      const [thread] = await getThreads([threadId]);
      return thread ?? null;
    },

    async setThreadState(threadId: string, patch: ThreadStatePatch) {
      const [row] = await db
        .insert(threadState)
        .select(
          db
            .select({
              orgId: threads.orgId,
              threadId: threads.id,
              memberId: mailboxAccess.memberId,
              read: sql`${patch.read ?? false}::boolean`.as("read"),
              snoozedUntil: sql`${snoozedUntilOf(patch)}::timestamptz`.as("snoozed_until"),
              doneThrough: (patch.doneThrough
                ? sql`least(${iso(patch.doneThrough)}::timestamptz, ${threads.lastMessageAt})`
                : sql`null::timestamptz`
              ).as("done_through"),
              updatedAt: sql`now()`.as("updated_at"),
            })
            .from(threads)
            .innerJoin(...threadGrant)
            .innerJoin(...threadOrg)
            .where(eq(threads.id, threadId)),
        )
        .onConflictDoUpdate({
          target: [threadState.threadId, threadState.memberId],
          set: stateUpdates(patch),
        })
        .returning({
          orgId: threadState.orgId,
          mailboxId: sql<string>`(select ${threads.mailboxId} from ${threads} where ${threads.id} = ${threadState.threadId})`,
          read: threadState.read,
          later: sql<boolean>`coalesce(${threadState.snoozedUntil} > now(), false)`,
          deferredUntil: legacyDeferredUntil,
          doneThrough: threadState.doneThrough,
          done: sql<boolean>`coalesce((select ${threads.lastMessageAt} from ${threads} where ${threads.id} = ${threadState.threadId}) <= ${threadState.doneThrough}, false)`,
        });
      return row ?? null;
    },
  };
}
