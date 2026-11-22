import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { meetingsAttendees, meetingsGrants, meetingsMeetings } from "../schema/meetings.ts";
import { storageHandOverRecipient } from "../storage.ts";
import { addressesOf } from "./core.ts";

/**
 * When a member leaves, the meetings they own go to whoever receives their files
 * (`docs/spec/meetings.md`, "Sharing"): that member gets an `owner` grant, and the leaver's owner
 * grant is dropped, or becomes `viewer` on a meeting they attended. Who recorded it does not
 * change, so a transcript still being made names the right voice. With no one to receive them,
 * nothing changes, as a refused leave must leave everything as it was. Safe to run again.
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
    const [to] = recipient ? await recipientAddresses(tx, recipient.id) : [];
    if (!recipient || !to) return { moved: 0, toMemberId: null };
    const addresses = await addressesOf(tx, leaving.userId);
    const owned = await tx
      .select({ id: meetingsMeetings.id })
      .from(meetingsMeetings)
      .where(
        and(
          eq(meetingsMeetings.orgId, leaving.orgId),
          or(
            eq(meetingsMeetings.recordedByMemberId, input.memberId),
            addresses.length
              ? inArray(
                  meetingsMeetings.id,
                  tx
                    .select({ id: meetingsGrants.meetingId })
                    .from(meetingsGrants)
                    .where(
                      and(
                        eq(meetingsGrants.role, "owner"),
                        inArray(meetingsGrants.address, addresses),
                      ),
                    ),
                )
              : undefined,
          ),
        ),
      );
    for (const { id } of owned) {
      await tx
        .insert(meetingsGrants)
        .values({ meetingId: id, orgId: leaving.orgId, address: to, role: "owner" })
        .onConflictDoUpdate({
          target: [meetingsGrants.meetingId, meetingsGrants.address],
          set: { role: "owner" },
        });
      if (addresses.length) await dropOwnerGrant(tx, id, addresses);
    }
    return { moved: owned.length, toMemberId: recipient.id };
  });
}

async function recipientAddresses(ex: Db, memberId: string) {
  const [member] = await ex
    .select({ userId: members.userId })
    .from(members)
    .where(eq(members.id, memberId));
  return member ? addressesOf(ex, member.userId) : [];
}

async function dropOwnerGrant(ex: Db, meetingId: string, addresses: string[]) {
  const theirs = and(
    eq(meetingsGrants.meetingId, meetingId),
    eq(meetingsGrants.role, "owner"),
    inArray(meetingsGrants.address, addresses),
  );
  const [attended] = await ex
    .select({ address: meetingsAttendees.address })
    .from(meetingsAttendees)
    .where(
      and(
        eq(meetingsAttendees.meetingId, meetingId),
        inArray(meetingsAttendees.address, addresses),
      ),
    );
  if (attended) await ex.update(meetingsGrants).set({ role: "viewer" }).where(theirs);
  else await ex.delete(meetingsGrants).where(theirs);
}
