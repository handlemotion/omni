// Thread writes shared by the member routes and the MCP `triage` tool (ADR 0029), so a change an
// agent makes is the same change the app makes: the same rows, the same outbox actions under the
// same idempotency keys. Callers ping the mail service when actions were queued.
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
  requests: Exclude<MailActionRequest, { kind: "send" }>[],
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
 * shared mailbox never changes it (spec: "Sync rules"). Null when the member cannot see the thread.
 */
export async function markRead(writer: ThreadWriter, threadId: string, read: boolean, key: string) {
  const state = await forMember(writer.db, writer.memberId).setThreadState(threadId, { read });
  if (!state) return null;
  const found = await threadActionTargets(writer.db, writer.memberId, threadId);
  const kind = read ? "mark_read" : "mark_unread";
  const actionIds =
    found?.mailboxKind === "personal"
      ? await enqueuePerFolder(
          writer,
          found,
          key,
          found.targets.map(({ role: _role, ...target }) => ({ kind, payload: target })),
        )
      : [];
  return { state, actionIds, mailboxId: found?.mailboxId };
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
