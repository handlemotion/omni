// Notifications: marking a member's own read, workspace notifications (a teammate joined), and
// whose preferences let one out (B4).

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { memberPreferences, members, notifications } from "./schema/index.ts";
import { type Executor, type NotificationKind } from "./mail.ts";

// Notifications: a member's own.

/** Marks the member's notifications read: these ids, or all of them. Returns how many changed. */
export async function markNotificationsRead(db: Executor, memberId: string, ids: string[] | "all") {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.memberId, memberId),
        isNull(notifications.readAt),
        ids === "all" ? undefined : inArray(notifications.id, ids),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * Tells everyone else in workspace `orgId` that user `userId`, now its member, joined. Once per
 * member, however often it runs. Answers who got a new notification.
 */
export async function notifyMemberJoined(
  db: Executor,
  input: { orgId: string; userId: string },
): Promise<string[]> {
  const [joined] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, input.orgId), eq(members.userId, input.userId)));
  if (!joined) return [];
  const others = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, input.orgId), ne(members.id, joined.id)));
  if (others.length === 0) return [];
  const rows = await db
    .insert(notifications)
    .values(
      others.map((other) => ({
        id: uuidv7(),
        orgId: input.orgId,
        memberId: other.id,
        kind: "member_joined" as const,
        actorMemberId: joined.id,
        dedupeKey: `member_joined:${joined.id}`,
      })),
    )
    .onConflictDoNothing()
    .returning({ memberId: notifications.memberId });
  return rows.map((r) => r.memberId);
}

// Realtime (B4): who hears about a conversation, and whose preferences let a notification out.

/**
 * Of these members, those whose preferences let `kind` through `channel`. No preferences row, or
 * no entry for the kind, means every channel is on.
 */
export async function membersAccepting(
  db: Executor,
  memberIds: string[],
  kind: NotificationKind,
  channel: "realtime" | "desktop" | "push",
) {
  if (memberIds.length === 0) return [];
  const rows = await db
    .select({
      memberId: memberPreferences.memberId,
      notifications: memberPreferences.notifications,
    })
    .from(memberPreferences)
    .where(inArray(memberPreferences.memberId, memberIds));
  const off = new Set(
    rows.filter((r) => r.notifications[kind]?.[channel] === false).map((r) => r.memberId),
  );
  return memberIds.filter((m) => !off.has(m));
}
