// Notifications: marking a member's own read, and whose preferences let one out (B4).

import { and, eq, inArray, isNull } from "drizzle-orm";
import { memberPreferences, notifications } from "./schema/index.ts";
import { type Executor, type NotificationKind } from "./conversation-core.ts";

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
