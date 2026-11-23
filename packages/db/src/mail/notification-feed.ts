import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  mailboxAccess,
  members,
  messages,
  notifications,
  threads,
  users,
} from "../schema/index.ts";
import { cursorAt, type ConversationCursor } from "./conversation-views.ts";
import type { GrantScope } from "./grants.ts";

/** The grantees' notifications, newest first, with who caused each and its thread's subject. */
export function notificationFeedQueries({ db, isGrantee }: GrantScope) {
  return {
    async listNotifications(
      options: { unreadOnly?: boolean; before?: ConversationCursor; limit?: number } = {},
    ) {
      const { unreadOnly = false, before, limit = 50 } = options;
      const visible = and(
        isGrantee(notifications.memberId),
        sql`(
          (${notifications.threadId} is null and exists (
            select 1 from ${members} vm
            where vm.id = ${notifications.memberId} and vm.organization_id = ${notifications.orgId}
          ))
          or exists (
            select 1 from ${mailboxAccess} va
            join ${members} vm on vm.id = va.member_id and vm.organization_id = ${threads.orgId}
            where va.mailbox_id = ${threads.mailboxId} and va.member_id = ${notifications.memberId}
          )
        )`,
      );
      const actorMember = alias(members, "actor_member");
      const actorUser = alias(users, "actor_user");
      const [rows, [unread]] = await Promise.all([
        db
          .select({
            id: notifications.id,
            kind: notifications.kind,
            threadId: notifications.threadId,
            mailboxId: threads.mailboxId,
            noteId: notifications.noteId,
            actorMemberId: notifications.actorMemberId,
            actor: { name: actorUser.name, email: actorUser.email, image: actorUser.image },
            data: notifications.data,
            readAt: notifications.readAt,
            createdAt: notifications.createdAt,
            pageAt: cursorAt(notifications.createdAt),
            subject: sql<string>`coalesce((select m.subject from ${messages} m where m.thread_id = ${threads.id} order by m.sent_at desc, m.id desc limit 1), '')`,
          })
          .from(notifications)
          .leftJoin(threads, eq(threads.id, notifications.threadId))
          .leftJoin(actorMember, eq(actorMember.id, notifications.actorMemberId))
          .leftJoin(actorUser, eq(actorUser.id, actorMember.userId))
          .where(
            and(
              visible,
              unreadOnly ? sql`${notifications.readAt} is null` : undefined,
              before
                ? sql`(${notifications.createdAt}, ${notifications.id}) < (${before.at}::timestamptz, ${before.id})`
                : undefined,
            ),
          )
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(notifications)
          .leftJoin(threads, eq(threads.id, notifications.threadId))
          .where(and(visible, sql`${notifications.readAt} is null`)),
      ]);
      return { notifications: rows, unread: unread?.count ?? 0 };
    },
  };
}
