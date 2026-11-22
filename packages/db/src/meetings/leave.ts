import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { meetingsAttendees, meetingsGrants, meetingsMeetings } from "../schema/meetings.ts";
import { storageHandOverRecipient } from "../storage.ts";
import { addressesOf } from "./core.ts";

/**
 * When a member leaves, the meetings they recorded go to whoever receives their files
 * (`docs/spec/meetings.md`, "Sharing"): that member becomes their owner, and the leaver's owner
 * grant is dropped, or becomes `viewer` on a meeting they attended. Nothing else changes, so it is
 * safe to run again.
 */
export function handOverMemberMeetings(
  db: Db,
  input: { memberId: string; toMemberId?: string | null },
) {
  return db.transaction(async (tx) => {
    const [leaving] = await tx
      .select({ orgId: members.organizationId, userId: members.userId })
      .from(members)
      .where(eq(members.id, input.memberId));
    if (!leaving) return { moved: 0, toMemberId: null };
    const recipient = await storageHandOverRecipient(
      tx,
      leaving.orgId,
      input.memberId,
      input.toMemberId,
    );
    const moved = await tx
      .update(meetingsMeetings)
      .set({ recordedByMemberId: recipient?.id ?? null })
      .where(
        and(
          eq(meetingsMeetings.orgId, leaving.orgId),
          eq(meetingsMeetings.recordedByMemberId, input.memberId),
        ),
      )
      .returning({ id: meetingsMeetings.id });
    const addresses = await addressesOf(tx, leaving.userId);
    if (addresses.length) await dropOwnerGrants(tx, leaving.orgId, addresses);
    return { moved: moved.length, toMemberId: recipient?.id ?? null };
  });
}

async function dropOwnerGrants(ex: Db, orgId: string, addresses: string[]) {
  const owned = await ex
    .select({ meetingId: meetingsGrants.meetingId, address: meetingsGrants.address })
    .from(meetingsGrants)
    .where(
      and(
        eq(meetingsGrants.orgId, orgId),
        eq(meetingsGrants.role, "owner"),
        inArray(meetingsGrants.address, addresses),
      ),
    );
  for (const grant of owned) {
    const where = and(
      eq(meetingsGrants.meetingId, grant.meetingId),
      eq(meetingsGrants.address, grant.address),
    );
    const [attended] = await ex
      .select({ address: meetingsAttendees.address })
      .from(meetingsAttendees)
      .where(
        and(
          eq(meetingsAttendees.meetingId, grant.meetingId),
          inArray(meetingsAttendees.address, addresses),
        ),
      );
    if (attended) await ex.update(meetingsGrants).set({ role: "viewer" }).where(where);
    else await ex.delete(meetingsGrants).where(where);
  }
}
