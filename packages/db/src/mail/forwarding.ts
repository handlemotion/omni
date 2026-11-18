import { sameAddress } from "@omni/mail-core/addresses";
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  mailActions,
  mailboxAccess,
  mailboxes,
  members,
  messages,
  type folderRole,
  type forwardScope,
} from "../schema/index.ts";

export type ForwardScope = (typeof forwardScope.enumValues)[number];
type FolderRole = (typeof folderRole.enumValues)[number];

const CLOCK_SLACK_MS = 5 * 60_000;

const THREAD_BACKFILL_LIMIT = 25;

/** Where a mailbox's sends are BCC'd, or null when forwarding is off. */
export async function forwardTarget(db: Db, mailboxId: string) {
  const [row] = await db
    .select({ address: mailboxes.forwardAddress })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.kind, "personal")));
  return row?.address ?? null;
}

/** What a `forward_copy` needs: the stored original and where it goes (null: turned off since). */
export async function forwardCopySource(db: Db, mailboxId: string, messageId: string) {
  const [row] = await db
    .select({ r2Key: messages.r2Key, forwardAddress: mailboxes.forwardAddress })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.mailboxId, mailboxId),
        eq(mailboxes.kind, "personal"),
      ),
    );
  return row ?? null;
}

/**
 * Queues `forward_copy` for what a newly stored copy of `messageId` (in a folder of `role`) makes
 * due under the mailbox's scope. Idempotent: each message is forwarded once per mailbox, so
 * calling it again for every copy, re-sync or retry is safe. Mail older than `forward_since`
 * never qualifies by itself, so a history import queues nothing.
 */
export async function enqueueForwardCopies(
  db: Db,
  input: { mailboxId: string; messageId: string; role: FolderRole },
) {
  const [row] = await db
    .select({
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      forwardAddress: mailboxes.forwardAddress,
      scope: mailboxes.forwardScope,
      since: mailboxes.forwardSince,
      threadId: messages.threadId,
      from: messages.fromAddress,
      sentAt: messages.sentAt,
      automated: messages.automated,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.mailboxId, input.mailboxId),
        eq(mailboxes.kind, "personal"),
      ),
    );
  if (!row?.forwardAddress || !row.since) return 0;
  if (row.sentAt.getTime() < row.since.getTime() - CLOCK_SLACK_MS) return 0;
  const own = sameAddress(row.from, row.address);
  const ids = own
    ? await threadBackfill(db, row, input.messageId)
    : (await receivedQualifies(db, row, input.role))
      ? [input.messageId]
      : [];
  if (ids.length === 0) return 0;
  const created = await db
    .insert(mailActions)
    .values(
      ids.map((messageId) => ({
        orgId: row.orgId,
        mailboxId: input.mailboxId,
        kind: "forward_copy" as const,
        payload: { messageId },
        idempotencyKey: `forward:${input.mailboxId}:${messageId}`,
      })),
    )
    .onConflictDoNothing({ target: mailActions.idempotencyKey })
    .returning({ id: mailActions.id });
  return created.length;
}

interface ForwardContext {
  address: string;
  forwardAddress: string | null;
  scope: ForwardScope;
  threadId: string;
  from: string;
  sentAt: Date;
  automated: boolean;
}

async function receivedQualifies(db: Db, row: ForwardContext, role: FolderRole) {
  if (row.automated || sameAddress(row.from, row.forwardAddress ?? "")) return false;
  switch (row.scope) {
    case "sent":
      return false;
    case "all":
      return role === "inbox";
    case "conversations":
      if (role === "junk" || role === "trash") return false;
      return wroteInThread(db, row);
  }
}

async function wroteInThread(db: Db, row: ForwardContext) {
  const [mine] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, row.threadId),
        sql`lower(${messages.fromAddress}) = lower(${row.address})`,
      ),
    )
    .limit(1);
  return mine !== undefined;
}

async function threadBackfill(db: Db, row: ForwardContext, ownMessageId: string) {
  if (row.scope !== "conversations") return [];
  const received = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, row.threadId),
        ne(messages.id, ownMessageId),
        lt(messages.sentAt, row.sentAt),
        eq(messages.automated, false),
        sql`lower(${messages.fromAddress}) not in (lower(${row.address}), lower(${row.forwardAddress}))`,
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(THREAD_BACKFILL_LIMIT);
  return received.map((r) => r.id);
}

/**
 * A user's forwarding settings: one entry per personal mailbox they own, in every organization
 * they belong to (a personal space and company workspaces alike, ADR 0024). With `scopeOrgId`,
 * only that organization's. The owner grant and the org match are the same checks `forUser` runs.
 */
export function ownedPersonalMailbox(userId: string, scopeOrgId?: string | null) {
  return and(
    eq(mailboxes.kind, "personal"),
    sql`exists (select 1 from ${mailboxAccess} ma join ${members} mm on mm.id = ma.member_id
      where ma.mailbox_id = ${mailboxes.id} and ma.role = 'owner'
        and mm.organization_id = ${mailboxes.orgId} and mm.user_id = ${userId}
        ${scopeOrgId ? sql`and mm.organization_id = ${scopeOrgId}` : sql``})`,
  );
}

export function forwardingFor(db: Db, userId: string, scopeOrgId?: string | null) {
  const owned = ownedPersonalMailbox(userId, scopeOrgId);
  return {
    async list() {
      const latest = db
        .selectDistinctOn([mailActions.mailboxId], {
          mailboxId: mailActions.mailboxId,
          status: mailActions.status,
          lastError: mailActions.lastError,
        })
        .from(mailActions)
        .where(eq(mailActions.kind, "forward_copy"))
        .orderBy(mailActions.mailboxId, desc(mailActions.createdAt))
        .as("latest");
      const rows = await db
        .select({
          mailboxId: mailboxes.id,
          orgId: mailboxes.orgId,
          address: mailboxes.address,
          forwardAddress: mailboxes.forwardAddress,
          scope: mailboxes.forwardScope,
          lastForwardedAt: sql<Date | null>`(select max(${mailActions.completedAt})
            from ${mailActions} where ${mailActions.mailboxId} = ${mailboxes.id}
              and ${mailActions.kind} = 'forward_copy' and ${mailActions.status} = 'done')`.mapWith(
            (v: string | Date | null) => (v === null ? null : new Date(v)),
          ),
          latestStatus: latest.status,
          latestError: latest.lastError,
        })
        .from(mailboxes)
        .leftJoin(latest, eq(latest.mailboxId, mailboxes.id))
        .where(owned)
        .orderBy(mailboxes.address);
      return rows.map(({ latestStatus, latestError, ...row }) => ({
        ...row,
        lastError: row.forwardAddress && latestStatus !== "done" ? latestError : null,
      }));
    },

    async set(mailboxId: string, settings: { address: string; scope: ForwardScope }) {
      const rows = await db
        .update(mailboxes)
        .set({
          forwardAddress: settings.address,
          forwardScope: settings.scope,
          forwardSince: sql`case when ${mailboxes.forwardAddress} is not distinct from ${settings.address}
            then coalesce(${mailboxes.forwardSince}, now()) else now() end`,
        })
        .where(and(eq(mailboxes.id, mailboxId), owned))
        .returning({ id: mailboxes.id });
      return rows.length > 0;
    },

    async clear(mailboxId: string) {
      const rows = await db
        .update(mailboxes)
        .set({ forwardAddress: null, forwardSince: null })
        .where(and(eq(mailboxes.id, mailboxId), owned))
        .returning({ id: mailboxes.id });
      return rows.length > 0;
    },
  };
}
