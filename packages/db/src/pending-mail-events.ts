// Mail events waiting for the Worker (`pending_mail_events`). Writers add a row in the same
// transaction as the change it reports; the mail service delivers rows oldest first and deletes
// each once the Worker accepted it.
import type { MailEvent } from "@omni/contracts";
import { asc, inArray } from "drizzle-orm";
import type { Db } from "./client.ts";
import { pendingMailEvents } from "./schema/index.ts";

type Executor = Pick<Db, "insert">;

/** Queues events for delivery. Pass the transaction that makes the change they report. */
export async function queueMailEvents(
  db: Executor,
  events: Exclude<MailEvent, { type: "message.created" }>[],
) {
  if (events.length === 0) return;
  await db
    .insert(pendingMailEvents)
    .values(events.map((event) => ({ orgId: event.orgId, mailboxId: event.mailboxId, event })));
}

/** Undelivered events, oldest first. `event` is unchecked: validate before sending. */
export function pendingMailEventRows(db: Db, limit: number) {
  return db
    .select({ id: pendingMailEvents.id, event: pendingMailEvents.event })
    .from(pendingMailEvents)
    .orderBy(asc(pendingMailEvents.id))
    .limit(limit);
}

/** The Worker accepted these (or they were unreadable): they are done. */
export async function deletePendingMailEvents(db: Db, ids: string[]) {
  if (ids.length === 0) return;
  await db.delete(pendingMailEvents).where(inArray(pendingMailEvents.id, ids));
}
