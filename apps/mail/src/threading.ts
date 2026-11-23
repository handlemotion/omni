import {
  claimProviderThread,
  createThread,
  type Db,
  findThreadByProviderId,
  mergeThreads,
  type MergedThreads,
  moveMessageToThread,
  subjectThreadCandidates,
  threadReferencing,
  threadsByMessageIds,
  threadsReplyingTo,
} from "@omni/db";
import { decideThread, normalizeSubject, type ParsedMessage } from "@omni/mail-core";

const SUBJECT_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000;

/** The mailbox a message is threaded in. */
export interface ThreadingMailbox {
  id: string;
  orgId: string;
  address: string;
}

export interface ThreadingDeps {
  db: Db;
  /** Called after threads were merged into one (see `mergeThreads`). Must not throw. */
  onMerged: (merged: { orgId: string; mailboxId: string } & MergedThreads) => void;
}

/**
 * The thread a new message joins: the one its provider thread id names, else the one its reply
 * headers or subject point at (merging threads its headers prove are one), else a new one.
 */
export async function assignThread(
  deps: ThreadingDeps,
  mailbox: ThreadingMailbox,
  message: ParsedMessage,
  sentAt: Date,
  providerThreadId?: string,
) {
  const { db } = deps;
  const mailboxId = mailbox.id;
  if (providerThreadId) {
    const known = await findThreadByProviderId(db, mailboxId, providerThreadId);
    if (known) return known satisfies string;
  }
  const replyIds = [message.inReplyTo, ...message.references].filter(
    (id): id is string => id !== null,
  );
  const knownMessageIds = await threadsByMessageIds(db, mailboxId, replyIds);
  const relatedThreadId =
    knownMessageIds.size === 0
      ? await threadReferencing(db, mailboxId, [message.messageId, ...replyIds])
      : null;
  const subjectKey = normalizeSubject(message.subject);
  const candidates =
    replyIds.length === 0 && subjectKey !== ""
      ? await subjectThreadCandidates(db, {
          mailboxId,
          subjectKey,
          since: new Date(sentAt.getTime() - SUBJECT_LOOKBACK_MS),
        })
      : [];
  const decision = decideThread(
    { ...message, sentAt },
    { knownMessageIds, candidates, selfAddresses: [mailbox.address], relatedThreadId },
  );
  if (decision.kind === "headers" && !providerThreadId) {
    const linked = new Set([
      decision.threadId,
      ...knownMessageIds.values(),
      ...(await threadsReplyingTo(db, mailboxId, message.messageId)),
    ]);
    if (linked.size > 1) {
      const merged = await mergeThreads(db, { mailboxId, threadIds: [...linked] });
      if (merged.fromThreadIds.length > 0) {
        deps.onMerged({ orgId: mailbox.orgId, mailboxId, ...merged });
      }
      return merged.intoThreadId satisfies string;
    }
  }
  if (decision.kind !== "new") {
    if (!providerThreadId) return decision.threadId satisfies string;
    if (await claimProviderThread(db, decision.threadId, providerThreadId)) {
      return decision.threadId satisfies string;
    }
  }
  return createThread(db, {
    orgId: mailbox.orgId,
    mailboxId,
    subjectKey: decision.kind === "new" ? decision.subjectKey : normalizeSubject(message.subject),
    lastMessageAt: sentAt,
    providerThreadId: providerThreadId ?? null,
  }) satisfies Promise<string>;
}

/**
 * A stored message seen again with a provider thread id (Gmail's X-GM-THRID) moves to that
 * thread: its own thread claims the id when no thread has it, else it joins (or starts) the one
 * that does.
 */
export async function followProviderThread(
  db: Db,
  mailbox: Omit<ThreadingMailbox, "address">,
  stored: { id: string; threadId: string },
  providerThreadId: string,
  fresh: { subjectKey: string; lastMessageAt: Date },
) {
  const mailboxId = mailbox.id;
  const known = await findThreadByProviderId(db, mailboxId, providerThreadId);
  if (known === stored.threadId) return;
  if (!known && (await claimProviderThread(db, stored.threadId, providerThreadId))) return;
  const threadId =
    known ??
    (await createThread(db, {
      orgId: mailbox.orgId,
      mailboxId,
      ...fresh,
      providerThreadId,
    }));
  await moveMessageToThread(db, { mailboxId, messageId: stored.id, threadId });
}
