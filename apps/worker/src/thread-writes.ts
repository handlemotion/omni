import {
  enqueueAction,
  forMember,
  setThreadArchived,
  threadActionTargets,
  type Db,
  type MailActionRequest,
} from "@omni/db";

export interface ThreadWriter {
  db: Db;
  memberId: string;
  requestId: string;
}

/**
 * Queues actions that each target one folder's copies, keyed by member, `key`, kind and folder,
 * so a retry under the same key queues nothing new. Returns the action ids.
 */
export async function enqueuePerFolder(
  writer: ThreadWriter,
  mailbox: { orgId: string; mailboxId: string },
  key: string,
  requests: Exclude<MailActionRequest, { kind: "send" | "forward_copy" }>[],
) {
  const actionIds: string[] = [];
  for (const request of requests) {
    const action = await enqueueAction(writer.db, {
      orgId: mailbox.orgId,
      mailboxId: mailbox.mailboxId,
      memberId: writer.memberId,
      requestId: writer.requestId,
      idempotencyKey: [writer.memberId, key, request.kind, request.payload.folder].join(":"),
      ...request,
    });
    actionIds.push(action.id);
  }
  return actionIds;
}

/**
 * Read or unread for this member. On a personal mailbox it also syncs the IMAP \Seen flag; a
 * shared mailbox never changes it (spec: "Sync rules"), and neither does a Google account, where
 * \Seen means Done (ADR 0044). Null when the member cannot see the thread.
 */
export async function markRead(writer: ThreadWriter, threadId: string, read: boolean, key: string) {
  const state = await forMember(writer.db, writer.memberId).setThreadState(threadId, { read });
  if (!state) return null;
  const found = await threadActionTargets(writer.db, writer.memberId, threadId);
  const actionIds =
    found?.mailboxKind === "personal" && found.mailboxProvider !== "gmail"
      ? await enqueueFlag(writer, found, read ? "mark_read" : "mark_unread", key)
      : [];
  return { state, actionIds, mailboxId: found?.mailboxId };
}

type Found = NonNullable<Awaited<ReturnType<typeof threadActionTargets>>>;

function enqueueFlag(
  writer: ThreadWriter,
  found: Found,
  kind: "mark_read" | "mark_unread",
  key: string,
  done?: true,
) {
  return enqueuePerFolder(
    writer,
    found,
    key,
    found.targets.map(({ role: _role, ...target }) => ({
      kind,
      payload: done ? { ...target, done } : target,
    })),
  );
}

export type TriagePatch = Parameters<ReturnType<typeof forMember>["setThreadState"]>[1];

/**
 * Done and Later for this member (ADR 0007, ADR 0027): Postgres only, except on a Google
 * account, where Done is Gmail's read (ADR 0044). There, a thread that is now done has every
 * copy marked read, and one taken out of Done (or put in Later) has its newest message marked
 * unread, which is what keeps it out of Done when Gmail is synced again. Nothing is ever moved
 * or deleted. Null when the member cannot see the thread.
 */
export async function setTriage(
  writer: ThreadWriter,
  threadId: string,
  patch: TriagePatch,
  key: string,
) {
  const state = await forMember(writer.db, writer.memberId).setThreadState(threadId, patch);
  if (!state) return null;
  const kind = state.done ? "mark_read" : patch.doneThrough === null ? "mark_unread" : null;
  if (!kind) return { state, actionIds: [] };
  const found = await threadActionTargets(
    writer.db,
    writer.memberId,
    threadId,
    kind === "mark_unread" ? "newest" : (state.doneThrough ?? undefined),
  );
  const actionIds =
    found?.mailboxProvider === "gmail" ? await enqueueFlag(writer, found, kind, key, true) : [];
  return { state, actionIds };
}

/** Where a thread's mail is: each folder's copies, as the outbox targets them. */
export type ThreadTargets = NonNullable<Awaited<ReturnType<typeof threadActionTargets>>>["targets"];

/**
 * Archives the thread: Postgres now (every member's app updates at once), and an outbox move out
 * of each folder that is not already Archive or Trash. `key` may be derived from where the mail
 * is, so the same archive repeats only once the mail has moved. Null when the member cannot see it.
 */
export async function archiveThread(
  writer: ThreadWriter,
  threadId: string,
  key: string | ((targets: ThreadTargets) => Promise<string>),
) {
  const found = await threadActionTargets(writer.db, writer.memberId, threadId);
  if (!found) return null;
  const actionKey = typeof key === "string" ? key : await key(found.targets);
  await setThreadArchived(writer.db, writer.memberId, threadId, true);
  const actionIds = await enqueuePerFolder(
    writer,
    found,
    actionKey,
    found.targets
      .filter(({ role }) => role !== "archive" && role !== "trash")
      .map(({ role: _role, ...target }) => ({ kind: "archive", payload: target })),
  );
  return { actionIds, mailboxId: found.mailboxId };
}
