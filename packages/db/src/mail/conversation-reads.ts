import { and, eq, sql } from "drizzle-orm";
import {
  businessHours,
  conversationEvents,
  mailboxAccess,
  mailboxes,
  members,
  notes,
  slaPolicies,
  tags,
  threadTags,
  threads,
  users,
} from "../schema/index.ts";
import { visibleMailbox, type GrantScope, grantInOrg } from "./grants.ts";

/** One shared conversation and what a helpdesk shows around it: tags, SLA settings, teammates. */
export function conversationReadQueries(scope: GrantScope) {
  const { db, isGrantee, threadGrant, threadOrg, mailboxGrant, mailboxOrg } = scope;
  return {
    async getConversation(threadId: string) {
      const [[conversation], tagRows, events, noteRows] = await Promise.all([
        db
          .select({
            id: threads.id,
            orgId: threads.orgId,
            mailboxId: threads.mailboxId,
            mailboxKind: mailboxes.kind,
            status: threads.status,
            assigneeMemberId: threads.assigneeMemberId,
            priority: threads.priority,
            snoozedUntil: threads.snoozedUntil,
            resolvedAt: threads.resolvedAt,
            customerId: threads.customerId,
            firstRespondedAt: threads.firstRespondedAt,
            firstResponseDueAt: threads.firstResponseDueAt,
            nextResponseDueAt: threads.nextResponseDueAt,
            resolutionDueAt: threads.resolutionDueAt,
          })
          .from(threads)
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
          .where(eq(threads.id, threadId))
          .limit(1),
        db
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(threadTags)
          .innerJoin(tags, eq(tags.id, threadTags.tagId))
          .innerJoin(threads, eq(threads.id, threadTags.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(eq(threadTags.threadId, threadId))
          .orderBy(sql`lower(${tags.name})`),
        db
          .select({
            id: conversationEvents.id,
            kind: conversationEvents.kind,
            actorMemberId: conversationEvents.actorMemberId,
            data: conversationEvents.data,
            createdAt: conversationEvents.createdAt,
          })
          .from(conversationEvents)
          .innerJoin(threads, eq(threads.id, conversationEvents.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(eq(conversationEvents.threadId, threadId))
          .orderBy(conversationEvents.createdAt, conversationEvents.id),
        db
          .select({
            id: notes.id,
            authorMemberId: notes.authorMemberId,
            body: notes.body,
            mentions: notes.mentions,
            createdAt: notes.createdAt,
            updatedAt: notes.updatedAt,
          })
          .from(notes)
          .innerJoin(threads, eq(threads.id, notes.threadId))
          .innerJoin(...threadGrant)
          .innerJoin(...threadOrg)
          .where(eq(notes.threadId, threadId))
          .orderBy(notes.createdAt, notes.id),
      ]);
      if (!conversation) return null;
      return { ...conversation, tags: tagRows, events, notes: noteRows };
    },

    async listSharedInboxTags() {
      const inboxes = await db
        .select({ id: mailboxes.id, address: mailboxes.address })
        .from(mailboxes)
        .innerJoin(...mailboxGrant)
        .innerJoin(...mailboxOrg)
        .where(eq(mailboxes.kind, "shared"))
        .orderBy(mailboxes.address);
      if (inboxes.length === 0) return [];
      const rows = await db
        .select({
          id: tags.id,
          mailboxId: tags.mailboxId,
          name: tags.name,
          color: tags.color,
          description: tags.description,
        })
        .from(tags)
        .innerJoin(mailboxes, eq(mailboxes.id, tags.mailboxId))
        .innerJoin(...mailboxGrant)
        .innerJoin(...mailboxOrg)
        .where(eq(mailboxes.kind, "shared"))
        .orderBy(sql`lower(${tags.name})`, tags.id);
      return inboxes.map((inbox) => ({
        ...inbox,
        tags: rows
          .filter((tag) => tag.mailboxId === inbox.id)
          .map(({ mailboxId: _mailboxId, ...tag }) => tag),
      }));
    },

    async listTags(mailboxId: string) {
      const [visible, rows] = await Promise.all([
        visibleMailbox(scope, eq(mailboxes.id, mailboxId)),
        db
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(tags)
          .innerJoin(mailboxes, eq(mailboxes.id, tags.mailboxId))
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(eq(tags.mailboxId, mailboxId))
          .orderBy(sql`lower(${tags.name})`, tags.id),
      ]);
      return visible ? rows : null;
    },

    async threadAudience(threadId: string) {
      const [thread] = await db
        .select({ mailboxId: threads.mailboxId, orgId: threads.orgId })
        .from(threads)
        .innerJoin(...threadGrant)
        .innerJoin(...threadOrg)
        .where(eq(threads.id, threadId))
        .limit(1);
      if (!thread) return null;
      const rows = await db
        .select({ memberId: mailboxAccess.memberId })
        .from(mailboxAccess)
        .innerJoin(members, grantInOrg(thread.orgId))
        .where(eq(mailboxAccess.mailboxId, thread.mailboxId));
      return { mailboxId: thread.mailboxId, memberIds: rows.map((r) => r.memberId) };
    },

    async slaSettings(mailboxId: string) {
      const visible = and(eq(mailboxes.id, mailboxId), eq(mailboxes.kind, "shared"));
      const [mailbox, policies, [hours]] = await Promise.all([
        visibleMailbox(scope, visible),
        db
          .select({
            priority: slaPolicies.priority,
            firstResponseMinutes: slaPolicies.firstResponseMinutes,
            nextResponseMinutes: slaPolicies.nextResponseMinutes,
            resolutionMinutes: slaPolicies.resolutionMinutes,
            businessHoursOnly: slaPolicies.businessHoursOnly,
          })
          .from(slaPolicies)
          .innerJoin(mailboxes, eq(mailboxes.id, slaPolicies.mailboxId))
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(visible)
          .orderBy(slaPolicies.priority),
        db
          .select({
            timezone: businessHours.timezone,
            windows: businessHours.windows,
            holidays: businessHours.holidays,
          })
          .from(businessHours)
          .innerJoin(mailboxes, eq(mailboxes.id, businessHours.mailboxId))
          .innerJoin(...mailboxGrant)
          .innerJoin(...mailboxOrg)
          .where(visible)
          .limit(1),
      ]);
      if (!mailbox) return null;
      return { policies, businessHours: hours ?? null, autoAssign: mailbox.autoAssign };
    },

    async mailboxAssignees(mailboxId: string) {
      const [visible, rows] = await Promise.all([
        visibleMailbox(scope, eq(mailboxes.id, mailboxId)),
        db.execute(sql`
          select am.id as "memberId", u.name, u.email, u.image
          from ${mailboxes} mb
          join ${mailboxAccess} ga on ga.mailbox_id = mb.id and ${isGrantee(sql`ga.member_id`)}
          join ${members} gm on gm.id = ga.member_id and gm.organization_id = mb.org_id
          join ${mailboxAccess} aa on aa.mailbox_id = mb.id
          join ${members} am on am.id = aa.member_id and am.organization_id = mb.org_id
          join ${users} u on u.id = am.user_id
          where mb.id = ${mailboxId}
          order by u.name, am.id`),
      ]);
      if (!visible) return null;
      return (
        rows as unknown as { memberId: string; name: string; email: string; image: string | null }[]
      ).map((r) => ({ memberId: r.memberId, name: r.name, email: r.email, image: r.image }));
    },
  };
}
