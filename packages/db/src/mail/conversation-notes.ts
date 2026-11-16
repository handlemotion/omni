// Internal notes (ADR 0021): in the timeline, never sent, never on IMAP. @mentions notify, and
// so does every note on a conversation you take part in (its assignee, earlier note authors).

import { and, eq, exists, inArray, isNotNull, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  conversationEvents,
  mailboxAccess,
  members,
  notes,
  notifications,
} from "../schema/index.ts";
import { type Executor, lockConversation, writeEvents, notify } from "./conversation-core.ts";

export const NOTE_MAX_LENGTH = 20_000;

/**
 * Adds a note as `memberId`, who must see the conversation. Mentions of members who cannot see
 * the inbox are dropped (they could not open it); each one left is notified once.
 */
export async function createNote(
  db: Executor,
  input: { threadId: string; memberId: string; body: string; mentions: string[] },
) {
  return db.transaction(async (tx) => {
    const locked = await lockConversation(tx, input.threadId, input.memberId);
    if (!locked) return { ok: false as const, reason: "not_found" as const };
    const { kind, ...row } = locked;
    if (kind !== "shared") return { ok: false as const, reason: "personal_mailbox" as const };
    const wanted = [...new Set(input.mentions)];
    const allowed = wanted.length
      ? (
          await tx
            .select({ id: mailboxAccess.memberId })
            .from(mailboxAccess)
            .innerJoin(members, eq(members.id, mailboxAccess.memberId))
            .where(
              and(
                eq(mailboxAccess.mailboxId, row.mailboxId),
                eq(members.organizationId, row.orgId),
                inArray(mailboxAccess.memberId, wanted),
              ),
            )
        ).map((m) => m.id)
      : [];
    const mentions = wanted.filter((m) => allowed.includes(m));
    const [note] = await tx
      .insert(notes)
      .values({
        id: uuidv7(),
        orgId: row.orgId,
        mailboxId: row.mailboxId,
        threadId: row.id,
        authorMemberId: input.memberId,
        body: input.body,
        mentions,
      })
      .returning();
    await writeEvents(tx, row, input.memberId, [{ kind: "note", data: { noteId: note!.id } }]);
    const notified = await notify(tx, row, {
      memberIds: mentions,
      kind: "mention",
      actorMemberId: input.memberId,
      dedupeKey: `mention:${note!.id}`,
      noteId: note!.id,
    });
    // The mentioned already heard; everyone else taking part hears about the note itself.
    const participants = (await participantsOf(tx, row)).filter((m) => !mentions.includes(m));
    const followed = await notify(tx, row, {
      memberIds: participants,
      kind: "note",
      actorMemberId: input.memberId,
      dedupeKey: `note:${note!.id}`,
      noteId: note!.id,
    });
    return { ok: true as const, note: note!, conversation: row, notified, followed };
  });
}

/**
 * Who takes part in a shared conversation: its assignee and whoever left a note on it before,
 * among those who can still see the inbox.
 */
async function participantsOf(
  tx: Executor,
  row: { id: string; orgId: string; mailboxId: string; assigneeMemberId: string | null },
) {
  const authors = await tx
    .selectDistinct({ id: notes.authorMemberId })
    .from(notes)
    .where(and(eq(notes.threadId, row.id), isNotNull(notes.authorMemberId)));
  const wanted = [
    ...new Set([row.assigneeMemberId, ...authors.map((a) => a.id)].filter((m) => m !== null)),
  ];
  if (wanted.length === 0) return [];
  const allowed = await tx
    .select({ id: mailboxAccess.memberId })
    .from(mailboxAccess)
    .innerJoin(members, eq(members.id, mailboxAccess.memberId))
    .where(
      and(
        eq(mailboxAccess.mailboxId, row.mailboxId),
        eq(members.organizationId, row.orgId),
        inArray(mailboxAccess.memberId, wanted),
      ),
    );
  return allowed.map((m) => m.id);
}

/**
 * Edits the body of the author's own note. New mentions in the edit are not notified again: an
 * edit is a correction, not a new note. Null when it is not their note or they lost access.
 */
export async function updateNote(
  db: Executor,
  input: { threadId: string; noteId: string; memberId: string; body: string },
) {
  const [row] = await db
    .update(notes)
    .set({ body: input.body, updatedAt: new Date() })
    .where(
      and(
        eq(notes.id, input.noteId),
        eq(notes.threadId, input.threadId),
        eq(notes.authorMemberId, input.memberId),
        exists(
          db
            .select({ one: sql`1` })
            .from(mailboxAccess)
            .where(
              and(
                eq(mailboxAccess.mailboxId, notes.mailboxId),
                eq(mailboxAccess.memberId, input.memberId),
              ),
            ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Deletes the author's own note (its timeline event and notifications go with it). `notified`
 * is who had a notification about it.
 */
export async function deleteNote(
  db: Executor,
  input: { threadId: string; noteId: string; memberId: string },
) {
  return db.transaction(async (tx) => {
    // Who was notified about it: those notifications go with the note (cascade).
    const notified = await tx
      .select({ memberId: notifications.memberId })
      .from(notifications)
      .where(eq(notifications.noteId, input.noteId));
    const [row] = await tx
      .delete(notes)
      .where(
        and(
          eq(notes.id, input.noteId),
          eq(notes.threadId, input.threadId),
          eq(notes.authorMemberId, input.memberId),
          exists(
            tx
              .select({ one: sql`1` })
              .from(mailboxAccess)
              .where(
                and(
                  eq(mailboxAccess.mailboxId, notes.mailboxId),
                  eq(mailboxAccess.memberId, input.memberId),
                ),
              ),
          ),
        ),
      )
      .returning({
        id: notes.id,
        threadId: notes.threadId,
        mailboxId: notes.mailboxId,
        orgId: notes.orgId,
        mentions: notes.mentions,
      });
    if (!row) return null;
    await tx
      .delete(conversationEvents)
      .where(
        and(
          eq(conversationEvents.threadId, row.threadId),
          eq(conversationEvents.kind, "note"),
          sql`${conversationEvents.data}->>'noteId' = ${row.id}`,
        ),
      );
    return { ...row, notified: [...new Set(notified.map((n) => n.memberId))] };
  });
}
