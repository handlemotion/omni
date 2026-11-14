// Tags (ADR 0021): an inbox's list, managed by anyone who can see the inbox.

import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { mailboxAccess, mailboxes, members, tags } from "./schema/index.ts";
import { type Executor } from "./conversation-core.ts";

async function memberSeesMailbox(db: Executor, memberId: string, mailboxId: string) {
  const [row] = await db
    .select({ orgId: mailboxes.orgId, kind: mailboxes.kind })
    .from(mailboxes)
    .innerJoin(
      mailboxAccess,
      and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.memberId, memberId)),
    )
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailboxes.orgId)),
    )
    .where(eq(mailboxes.id, mailboxId));
  return row ?? null;
}

const tagColumns = {
  id: tags.id,
  name: tags.name,
  color: tags.color,
  description: tags.description,
};

/**
 * Creates a tag, or returns the one with the same name ignoring case (so a retry or a teammate
 * typing it at the same time gets the same tag). Null when the member cannot see the inbox.
 */
export async function createTag(
  db: Executor,
  memberId: string,
  mailboxId: string,
  input: { name: string; color?: string | null; description?: string | null },
) {
  const mailbox = await memberSeesMailbox(db, memberId, mailboxId);
  if (!mailbox) return null;
  const [created] = await db
    .insert(tags)
    .values({
      id: uuidv7(),
      orgId: mailbox.orgId,
      mailboxId,
      name: input.name,
      color: input.color ?? null,
      description: input.description?.trim() || null,
    })
    .onConflictDoNothing()
    .returning(tagColumns);
  if (created) return { tag: created, created: true };
  const [existing] = await db
    .select(tagColumns)
    .from(tags)
    .where(and(eq(tags.mailboxId, mailboxId), sql`lower(${tags.name}) = lower(${input.name})`));
  return { tag: existing!, created: false };
}

/**
 * Renames, recolors or re-describes a tag (a blank description clears it). `conflict` when another
 * tag already has the name.
 */
export async function updateTag(
  db: Executor,
  memberId: string,
  mailboxId: string,
  tagId: string,
  patch: { name?: string; color?: string | null; description?: string | null },
) {
  if (!(await memberSeesMailbox(db, memberId, mailboxId))) return { status: "not_found" as const };
  if (patch.description !== undefined) {
    patch = { ...patch, description: patch.description?.trim() || null };
  }
  try {
    const [row] = await db
      .update(tags)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(tags.id, tagId), eq(tags.mailboxId, mailboxId)))
      .returning(tagColumns);
    return row ? { status: "ok" as const, tag: row } : { status: "not_found" as const };
  } catch (error) {
    if (
      (error as { cause?: { code?: string } }).cause?.code === "23505" ||
      (error as { code?: string }).code === "23505"
    ) {
      return { status: "conflict" as const };
    }
    throw error;
  }
}

/** Deletes a tag and removes it from every conversation. False when nothing was deleted. */
export async function deleteTag(db: Executor, memberId: string, mailboxId: string, tagId: string) {
  if (!(await memberSeesMailbox(db, memberId, mailboxId))) return false;
  const rows = await db
    .delete(tags)
    .where(and(eq(tags.id, tagId), eq(tags.mailboxId, mailboxId)))
    .returning({ id: tags.id });
  return rows.length > 0;
}
