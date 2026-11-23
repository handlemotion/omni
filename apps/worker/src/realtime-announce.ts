import type { SlaTarget } from "@omni/contracts";
import { mailboxAudience, membersAccepting, type Db, type NotificationKind } from "@omni/db";
import type { Config } from "./env.ts";
import { sendExpoPush } from "./realtime-push.ts";

/** The workspace's realtime object: one per org, named by its id. */
export function realtimeOf(env: Env, orgId: string) {
  return env.REALTIME.get(env.REALTIME.idFromName(orgId));
}

/**
 * Tells every member who can see the mailboxes that these threads changed: `changed` for the
 * mail views and `thread.changed` for helpdesk views. Members with no app open on a mailbox in
 * `push` get an Expo notification instead (when enabled). Watch sockets hear `arrived`, the new
 * mail among the changes (`newArrivals`), as `mail.arrived`.
 */
export async function fanOut(
  env: Env,
  db: Db,
  config: Config,
  changes: Map<string, Set<string>>,
  options: { push?: Set<string>; arrived?: Map<string, Set<string>> } = {},
) {
  const audience = await mailboxAudience(db, [...changes.keys()]);
  const offlineByMailbox = new Map<string, { address: string; memberIds: string[] }>();
  for (const [mailboxId, threadSet] of changes) {
    const rows = audience.filter((row) => row.mailboxId === mailboxId);
    const first = rows[0];
    if (!first) continue;
    const threadIds = [...threadSet];
    const stub = realtimeOf(env, first.orgId);
    const arrived = options.arrived?.get(mailboxId);
    const offline = await stub.send(
      rows.map((row) => row.memberId),
      [
        { type: "changed", mailboxId, threadIds },
        { type: "thread.changed", mailboxId, threadIds },
        ...(arrived?.size
          ? [{ type: "mail.arrived" as const, mailboxId, threadIds: [...arrived] }]
          : []),
      ],
    );
    if (options.push?.has(mailboxId)) {
      offlineByMailbox.set(mailboxId, { address: first.address, memberIds: offline });
    }
  }
  if (config.EXPO_PUSH_ENABLED) {
    for (const { address, memberIds } of offlineByMailbox.values()) {
      await sendExpoPush(db, config, memberIds, { title: address, body: "New message" });
    }
  }
}

/**
 * Tells this member's own apps, on every device, that their state on a thread changed: read,
 * Done, Later. That state is theirs alone, so teammates are not told, and nothing else would
 * tell their other devices (a phone left open kept a read thread unread, and its badge).
 */
export async function announceToMember(
  env: Env,
  input: { orgId: string; memberId: string; mailboxId: string; threadId: string },
) {
  const stub = realtimeOf(env, input.orgId);
  await stub.broadcast([input.memberId], {
    type: "changed",
    mailboxId: input.mailboxId,
    threadIds: [input.threadId],
  });
}

/** Tells everyone who can see the mailbox that threads were merged, so readers can follow. */
export async function announceMerges(
  env: Env,
  db: Db,
  merges: { mailboxId: string; intoThreadId: string; fromThreadIds: string[] }[],
) {
  const audience = await mailboxAudience(db, [...new Set(merges.map((m) => m.mailboxId))]);
  for (const { mailboxId, intoThreadId, fromThreadIds } of merges) {
    const rows = audience.filter((row) => row.mailboxId === mailboxId);
    const first = rows[0];
    if (!first) continue;
    const stub = realtimeOf(env, first.orgId);
    await stub.broadcast(
      rows.map((row) => row.memberId),
      { type: "merged", mailboxId, intoThreadId, fromThreadIds },
    );
  }
}

/** Tells these members, whose preferences allow it, that they have a new notification. */
export async function notifyMembers(
  env: Env,
  db: Db,
  input: { orgId: string; threadId: string | null; memberIds: string[]; kind: NotificationKind },
) {
  if (input.memberIds.length === 0) return;
  const accepting = await membersAccepting(db, input.memberIds, input.kind, "realtime");
  if (accepting.length === 0) return;
  const stub = realtimeOf(env, input.orgId);
  await stub.broadcast(accepting, {
    type: "notification",
    threadId: input.threadId,
    kind: input.kind,
  });
}

/** Tells these members that notifications they had about the thread are gone. */
export async function withdrawNotifications(
  env: Env,
  input: { orgId: string; threadId: string; memberIds: string[] },
) {
  if (input.memberIds.length === 0) return;
  const stub = realtimeOf(env, input.orgId);
  await stub.broadcast(input.memberIds, { type: "notification.removed", threadId: input.threadId });
}

/** Tells everyone who can see the inbox that a note was added. */
export async function announceNote(
  env: Env,
  db: Db,
  note: { orgId: string; mailboxId: string; threadId: string; noteId: string },
) {
  const audience = await mailboxAudience(db, [note.mailboxId]);
  if (audience.length === 0) return;
  const stub = realtimeOf(env, note.orgId);
  await stub.broadcast(
    audience.map((row) => row.memberId),
    {
      type: "note.created",
      mailboxId: note.mailboxId,
      threadId: note.threadId,
      noteId: note.noteId,
    },
  );
}

/** Tells everyone who can see the inbox that a conversation's SLA is at risk or breached. */
export async function announceSla(
  env: Env,
  db: Db,
  alert: {
    orgId: string;
    mailboxId: string;
    threadId: string;
    target: SlaTarget;
    kind: "sla_at_risk" | "sla_breached";
    dueAt: Date;
  },
) {
  const audience = await mailboxAudience(db, [alert.mailboxId]);
  if (audience.length === 0) return;
  const stub = realtimeOf(env, alert.orgId);
  await stub.broadcast(
    audience.map((row) => row.memberId),
    {
      type: alert.kind === "sla_at_risk" ? "sla.at_risk" : "sla.breached",
      mailboxId: alert.mailboxId,
      threadId: alert.threadId,
      target: alert.target,
      dueAt: alert.dueAt.toISOString(),
    },
  );
}

/** Tells each member whose action failed for good, on their org's realtime object. */
export async function notifyFailedActions(
  env: Env,
  failures: { orgId: string; memberId: string | null; actionId: string; error: string }[],
) {
  for (const { orgId, memberId, actionId, error } of failures) {
    if (!memberId) continue;
    const stub = realtimeOf(env, orgId);
    await stub.broadcast([memberId], { type: "action", actionId, status: "failed", error });
  }
}
