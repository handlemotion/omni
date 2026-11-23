import { and, eq } from "drizzle-orm";
import {
  drafts,
  mailActions,
  mailboxAccess,
  mailboxes,
  members,
  threads,
} from "../schema/index.ts";
import type { GrantScope } from "./grants.ts";

const memberColumns = {
  id: members.id,
  orgId: members.organizationId,
  userId: members.userId,
  role: members.role,
};

/** The grantees' mailboxes, and which of their members reaches a mailbox, thread or action. */
export function memberLookupQueries({
  db,
  access,
  threadGrant,
  threadOrg,
  mailboxGrant,
  mailboxOrg,
}: GrantScope) {
  async function memberForMailbox(mailboxId: string) {
    const [row] = await db
      .select(memberColumns)
      .from(mailboxes)
      .innerJoin(...mailboxGrant)
      .innerJoin(...mailboxOrg)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1);
    return row ?? null;
  }

  return {
    memberForMailbox,

    async memberForResource(kind: "draft" | "action", id: string) {
      const table = kind === "draft" ? drafts : mailActions;
      const [row] = await db
        .select({ mailboxId: table.mailboxId })
        .from(table)
        .where(eq(table.id, id));
      return row ? memberForMailbox(row.mailboxId) : null;
    },

    async memberFor(threadId: string) {
      const [row] = await db
        .select(memberColumns)
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .where(eq(threads.id, threadId))
        .limit(1);
      return row ?? null;
    },

    async listMailboxes() {
      return db
        .select({
          id: mailboxes.id,
          orgId: mailboxes.orgId,
          address: mailboxes.address,
          kind: mailboxes.kind,
          provider: mailboxes.provider,
          status: mailboxes.status,
          role: mailboxAccess.role,
          label: mailboxes.label,
          picture: mailboxes.picture,
        })
        .from(mailboxes)
        .innerJoin(...mailboxGrant)
        .innerJoin(...mailboxOrg)
        .orderBy(mailboxes.address);
    },

    async googleAccounts() {
      return db
        .select({
          id: mailboxes.id,
          orgId: mailboxes.orgId,
          address: mailboxes.address,
          status: mailboxes.status,
          memberId: mailboxAccess.memberId,
        })
        .from(mailboxes)
        .innerJoin(...mailboxGrant)
        .innerJoin(...mailboxOrg)
        .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.kind, "personal")))
        .orderBy(mailboxes.address);
    },

    async getAction(actionId: string) {
      const [actionGrant, actionOrg] = access(mailActions.mailboxId, mailActions.orgId);
      const [row] = await db
        .select({
          id: mailActions.id,
          mailboxId: mailActions.mailboxId,
          kind: mailActions.kind,
          status: mailActions.status,
          attempts: mailActions.attempts,
          error: mailActions.lastError,
          createdAt: mailActions.createdAt,
          completedAt: mailActions.completedAt,
        })
        .from(mailActions)
        .innerJoin(...actionGrant)
        .innerJoin(...actionOrg)
        .where(and(eq(mailActions.id, actionId), eq(mailActions.memberId, mailboxAccess.memberId)));
      return row ?? null;
    },
  };
}
