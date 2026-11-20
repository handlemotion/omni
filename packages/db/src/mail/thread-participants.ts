import { domainOf, normalizeAddress } from "@omni/mail-core/addresses";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import type { Executor } from "./conversation-core.ts";
import {
  mailboxes,
  messages,
  threadParticipants,
  threadParticipantsBackfill,
  type Address,
} from "../schema/index.ts";

/** The parts of a message its participants come from. */
export interface ParticipantSource {
  fromAddress: string;
  to?: readonly Address[] | null;
  cc?: readonly Address[] | null;
}

/**
 * A message's distinct participants, normalized (`normalizeAddress`, `domainOf`). An address
 * without a domain (`MAILER-DAEMON`, `undisclosed-recipients:`) has no row: no person or company
 * could be keyed by it, and `domain` is what a company's timeline looks threads up by.
 */
export function participantsOf(message: ParticipantSource) {
  const found = new Map<string, string>();
  for (const raw of [message.fromAddress, ...addresses(message.to), ...addresses(message.cc)]) {
    const address = normalizeAddress(raw);
    const domain = domainOf(address);
    if (domain) found.set(address, domain);
  }
  return [...found].map(([address, domain]) => ({ address, domain }));
}

function addresses(list: readonly Address[] | null | undefined) {
  return (list ?? []).map((entry) => entry?.address ?? "").filter(Boolean);
}

interface ThreadMessage extends ParticipantSource {
  orgId: string;
  mailboxId: string;
  threadId: string;
}

const INSERT_CHUNK = 1000;

/**
 * Adds each message's participants to its thread. Rows already there are left alone. Call it
 * inside a transaction when `rows` may be many: it inserts in chunks.
 */
export async function addParticipants(db: Executor, rows: readonly ThreadMessage[]) {
  const values = rows.flatMap((row) =>
    participantsOf(row).map((p) => ({
      orgId: row.orgId,
      mailboxId: row.mailboxId,
      threadId: row.threadId,
      ...p,
    })),
  );
  let added = 0;
  for (let start = 0; start < values.length; start += INSERT_CHUNK) {
    const inserted = await db
      .insert(threadParticipants)
      .values(values.slice(start, start + INSERT_CHUNK))
      .onConflictDoNothing()
      .returning({ threadId: threadParticipants.threadId });
    added += inserted.length;
  }
  return added;
}

function anyOf(ids: readonly string[]) {
  return sql`any(array(select jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb)))`;
}

const sourceColumns = {
  orgId: messages.orgId,
  mailboxId: messages.mailboxId,
  threadId: messages.threadId,
  fromAddress: messages.fromAddress,
  to: messages.to,
  cc: messages.cc,
};

/**
 * Rebuilds the participants of `threadIds` from the messages they hold now, after messages left
 * them (deleted on the server, or filed under another thread). Call it inside the transaction
 * that moved or deleted them. The threads are locked first, as `upsertMessage` locks a thread
 * before adding to it, so a message stored meanwhile keeps its rows. Threads that no longer
 * exist are skipped (their rows went with them).
 */
export async function rederiveParticipants(db: Executor, threadIds: readonly string[]) {
  if (threadIds.length === 0) return;
  const ids = [...new Set(threadIds)].toSorted();
  await db.execute(sql`select id from threads where id = ${anyOf(ids)} order by id for update`);
  const rows = await db
    .select(sourceColumns)
    .from(messages)
    .where(sql`${messages.threadId} = ${anyOf(ids)}`);
  await db.delete(threadParticipants).where(sql`${threadParticipants.threadId} = ${anyOf(ids)}`);
  await addParticipants(db, rows);
}

/**
 * Copies the participants of `fromThreadIds` onto `intoThreadId`, for a merge: the merged thread
 * holds every message of both, so its participants are the union.
 */
export async function mergeParticipants(
  db: Executor,
  input: { intoThreadId: string; fromThreadIds: readonly string[] },
) {
  if (input.fromThreadIds.length === 0) return;
  await db.execute(sql`insert into thread_participants (org_id, mailbox_id, thread_id, address, domain)
    select org_id, mailbox_id, ${input.intoThreadId}, address, domain from thread_participants
    where thread_id = ${anyOf(input.fromThreadIds)}
    on conflict do nothing`);
}

/** Messages per backfill batch: one short transaction. */
export const PARTICIPANT_BATCH = 500;
/**
 * How old a message must be before the backfill reads past it. Ids are UUIDv7, taken when the
 * mail service stores the message, so one may commit a moment after a younger one: the cursor
 * stays this far behind, and never steps over a message still on its way in.
 */
export const PARTICIPANT_SETTLE_MS = 10 * 60_000;

function uuidv7Floor(ms: number) {
  const hex = Math.max(0, Math.floor(ms)).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/**
 * One batch of the backfill: up to `limit` messages of one mailbox, past
 * its cursor in `thread_participants_backfill` and older than `PARTICIPANT_SETTLE_MS`, get their
 * participants, and the cursor moves to the last one. It covers mail stored before the table
 * existed and mail an older mail service stores during a deploy, so it never finishes: once
 * caught up it follows each mailbox's new mail. The mailbox read longest ago goes first. Safe to
 * run twice or beside itself: inserts are insert-or-nothing and the cursor only moves forward.
 * `messages` is 0 when no mailbox has anything to read.
 */
export async function indexParticipants(
  db: Executor,
  options: { limit?: number; now?: Date } = {},
) {
  const limit = options.limit ?? PARTICIPANT_BATCH;
  const bound = uuidv7Floor((options.now ?? new Date()).getTime() - PARTICIPANT_SETTLE_MS);
  return db.transaction(async (tx) => {
    const [next] = await tx
      .select({
        mailboxId: mailboxes.id,
        orgId: mailboxes.orgId,
        after: threadParticipantsBackfill.lastMessageId,
      })
      .from(mailboxes)
      .leftJoin(threadParticipantsBackfill, eq(threadParticipantsBackfill.mailboxId, mailboxes.id))
      .where(
        sql`exists (select 1 from ${messages} m where m.mailbox_id = ${mailboxes.id}
          and m.id > coalesce(${threadParticipantsBackfill.lastMessageId}, '') and m.id < ${bound})`,
      )
      .orderBy(sql`${threadParticipantsBackfill.updatedAt} asc nulls first`, mailboxes.id)
      .limit(1);
    if (!next) return { messages: 0, participants: 0 };
    const rows = await tx
      .select({ id: messages.id, ...sourceColumns })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, next.mailboxId),
          gt(messages.id, next.after ?? ""),
          lt(messages.id, bound),
        ),
      )
      .orderBy(asc(messages.id))
      .limit(limit)
      .for("share");
    const participants = await addParticipants(tx, rows);
    const last = rows.at(-1)?.id ?? next.after;
    await tx
      .insert(threadParticipantsBackfill)
      .values({ mailboxId: next.mailboxId, orgId: next.orgId, lastMessageId: last })
      .onConflictDoUpdate({
        target: threadParticipantsBackfill.mailboxId,
        set: {
          lastMessageId: sql`greatest(${threadParticipantsBackfill.lastMessageId}, excluded.last_message_id)`,
          updatedAt: new Date(),
        },
      });
    return { messages: rows.length, participants };
  });
}
