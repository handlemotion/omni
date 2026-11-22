import { randomBytes } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  meetingsActions,
  meetingsAttendees,
  meetingsGrants,
  meetingsJobs,
  meetingsMeetings,
  meetingsSpeakers,
} from "../schema/meetings.ts";
import { storageInsideCompany, storagePolicyOf } from "../storage.ts";
import { recentlyHeard } from "./chunks.ts";
import { FORBIDDEN, NOT_FOUND, withMeeting, type Ex, type MeetingsActor } from "./core.ts";

export interface StartMeeting {
  title: string | null;
  event: { uid: string; recurrenceId: string | null } | null;
  attendees: Array<{ address: string; name: string | null }>;
  groupKey: string | null;
  /** The recorder confirmed everyone was told. Starting without it is refused. */
  consent: boolean;
}

const lower = (a: string) => a.trim().toLowerCase();

const POLICY = { status: "policy" } as const;

/**
 * Starts a recording. A calendar meeting is recorded once per workspace: while someone records
 * it, a second start answers `recording_elsewhere`; after that recording stopped, or went quiet
 * for `RECORDING_STALE_MS`, it becomes the meeting's next part. The recorder owns it; every
 * attendee gets `viewer`.
 */
export async function startMeeting(ex: Db, actor: MeetingsActor, input: StartMeeting) {
  const member = actor.member;
  if (!member) return NOT_FOUND;
  if (!input.consent) return { status: "consent_required" } as const;
  const recurrence = input.event?.recurrenceId ?? "";
  let part = 1;
  if (input.event) {
    const latest = await latestPart(ex, member.orgId, input.event.uid, recurrence);
    if (latest?.status === "recording" && latest.heard) return recordingElsewhere(latest);
    part = (latest?.part ?? 0) + 1;
  }
  const [meeting] = await ex
    .insert(meetingsMeetings)
    .values({
      orgId: member.orgId,
      title: input.title?.trim() || null,
      eventUid: input.event?.uid ?? null,
      eventRecurrenceId: recurrence,
      part,
      groupKey: input.groupKey ?? "pending",
      recordedByMemberId: member.id,
      consentAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (!meeting) {
    const winner = input.event
      ? await latestPart(ex, member.orgId, input.event.uid, recurrence)
      : undefined;
    return recordingElsewhere(winner ?? { id: null, by: null });
  }
  if (!input.groupKey) {
    await ex
      .update(meetingsMeetings)
      .set({ groupKey: `meeting:${meeting.id}` })
      .where(eq(meetingsMeetings.id, meeting.id));
  }

  await shareWithAttendees(ex, actor, member, meeting.id, input.attendees);
  await ex
    .insert(meetingsJobs)
    .values({ meetingId: meeting.id, orgId: member.orgId })
    .onConflictDoNothing();
  return { status: "ok", meetingId: meeting.id, part } as const;
}

async function shareWithAttendees(
  ex: Db,
  actor: MeetingsActor,
  member: NonNullable<MeetingsActor["member"]>,
  meetingId: string,
  people: StartMeeting["attendees"],
) {
  const meeting = { id: meetingId };
  const owner = actor.addresses[0];
  const attendees = new Map(people.map((a) => [lower(a.address), a.name?.trim() || null]));
  if (attendees.size) {
    await ex
      .insert(meetingsAttendees)
      .values(
        [...attendees].map(([address, name]) => ({
          meetingId: meeting.id,
          orgId: member.orgId,
          address,
          name,
        })),
      )
      .onConflictDoNothing();
  }
  const viewers = await shareable(
    ex,
    member.orgId,
    [...attendees.keys()].filter((a) => !actor.addresses.includes(a)),
  );
  const grants = [
    ...(owner ? [{ address: owner, role: "owner" as const }] : []),
    ...viewers.map((address) => ({ address, role: "viewer" as const })),
  ];
  if (grants.length) {
    await ex
      .insert(meetingsGrants)
      .values(
        grants.map((g) => ({
          ...g,
          meetingId: meeting.id,
          orgId: member.orgId,
          grantedByMemberId: member.id,
        })),
      )
      .onConflictDoNothing();
  }
}

async function shareable(ex: Db, orgId: string, addresses: string[]) {
  if (!addresses.length || (await storagePolicyOf(ex, orgId)).outsideSharing) return addresses;
  const inside = await Promise.all(addresses.map((a) => storageInsideCompany(ex, orgId, a)));
  return addresses.filter((_, i) => inside[i]);
}

async function latestPart(ex: Ex, orgId: string, uid: string, recurrenceId: string) {
  const [latest] = await ex
    .select({
      id: meetingsMeetings.id,
      part: meetingsMeetings.part,
      status: meetingsMeetings.status,
      by: meetingsMeetings.recordedByMemberId,
      heard: recentlyHeard(),
    })
    .from(meetingsMeetings)
    .where(
      and(
        eq(meetingsMeetings.orgId, orgId),
        eq(meetingsMeetings.eventUid, uid),
        eq(meetingsMeetings.eventRecurrenceId, recurrenceId),
      ),
    )
    .orderBy(desc(meetingsMeetings.part))
    .limit(1);
  return latest;
}

const recordingElsewhere = (latest: { id: string | null; by: string | null }) =>
  ({ status: "recording_elsewhere", meetingId: latest.id, recordedByMemberId: latest.by }) as const;

export interface MeetingChange {
  title?: string | null;
  access?: "restricted" | "workspace";
  linkAccess?: "off" | "signed_in" | "anyone";
  record?: { kind: string; id: string } | null;
}

/**
 * Title, general access, the link and the CRM record. Editors and the owner. A link open to
 * anyone is refused while the workspace's Drive policy closes public links.
 */
export function changeMeeting(
  ex: Db,
  actor: MeetingsActor | null,
  meetingId: string,
  change: MeetingChange,
) {
  return withMeeting(ex, actor, meetingId, "editor", async ({ meeting }) => {
    const set: Partial<typeof meetingsMeetings.$inferInsert> = {};
    if (change.title !== undefined) set.title = change.title?.trim() || null;
    if (change.access) set.access = change.access;
    if (change.linkAccess === "anyone" && !(await storagePolicyOf(ex, meeting.orgId)).publicLinks) {
      return POLICY;
    }
    if (change.linkAccess) {
      set.linkAccess = change.linkAccess;
      if (change.linkAccess !== "off" && !meeting.linkToken) {
        set.linkToken = randomBytes(18).toString("base64url");
      }
    }
    if (change.record !== undefined) {
      set.recordKind = change.record?.kind ?? "none";
      set.recordId = change.record?.id ?? "";
    }
    if (!Object.keys(set).length) return { status: "ok" } as const;
    await ex.update(meetingsMeetings).set(set).where(eq(meetingsMeetings.id, meetingId));
    return { status: "ok" } as const;
  });
}

/**
 * Shares with an address as viewer or editor. The owner's grant is not changed here. An address
 * outside the company is refused while the workspace's Drive policy closes outside sharing.
 */
export function grantMeeting(
  ex: Db,
  actor: MeetingsActor | null,
  meetingId: string,
  address: string,
  role: "viewer" | "editor",
) {
  return withMeeting(ex, actor, meetingId, "editor", async ({ meeting }) => {
    const to = lower(address);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return { status: "invalid_address" } as const;
    const [current] = await ex
      .select({ role: meetingsGrants.role })
      .from(meetingsGrants)
      .where(and(eq(meetingsGrants.meetingId, meetingId), eq(meetingsGrants.address, to)));
    if (current?.role === "owner") return FORBIDDEN;
    if (
      !(await storagePolicyOf(ex, meeting.orgId)).outsideSharing &&
      !(await storageInsideCompany(ex, meeting.orgId, to))
    ) {
      return POLICY;
    }
    await ex
      .insert(meetingsGrants)
      .values({
        meetingId,
        orgId: meeting.orgId,
        address: to,
        role,
        grantedByMemberId: actor?.member?.id ?? null,
      })
      .onConflictDoUpdate({
        target: [meetingsGrants.meetingId, meetingsGrants.address],
        set: { role },
      });
    return { status: "ok", address: to, created: !current } as const;
  });
}

/** Takes an address's access away, an attendee's too. Never the owner's. */
export function revokeMeeting(
  ex: Ex,
  actor: MeetingsActor | null,
  meetingId: string,
  address: string,
) {
  return withMeeting(ex, actor, meetingId, "editor", async () => {
    await ex
      .delete(meetingsGrants)
      .where(
        and(
          eq(meetingsGrants.meetingId, meetingId),
          eq(meetingsGrants.address, lower(address)),
          ne(meetingsGrants.role, "owner"),
        ),
      );
    return { status: "ok" } as const;
  });
}

/** A person's name for a speaker, for every line of the meeting. */
export function renameSpeaker(
  ex: Ex,
  actor: MeetingsActor | null,
  meetingId: string,
  label: string,
  who: { name: string; address: string | null },
) {
  return withMeeting(ex, actor, meetingId, "editor", async () => {
    const name = who.name.trim();
    if (!name) return { status: "invalid_name" } as const;
    const [row] = await ex
      .update(meetingsSpeakers)
      .set({
        name,
        address: who.address ? lower(who.address) : null,
        source: "person",
        confidence: 1,
      })
      .where(and(eq(meetingsSpeakers.meetingId, meetingId), eq(meetingsSpeakers.label, label)))
      .returning({ label: meetingsSpeakers.label });
    return row ? ({ status: "ok" } as const) : NOT_FOUND;
  });
}

/** Accepts or dismisses a suggested action; an accepted task keeps its calendar task's id. */
export async function decideAction(
  ex: Ex,
  actor: MeetingsActor | null,
  actionId: string,
  decision: { accept: boolean; taskId?: string | null },
) {
  const [action] = await ex.select().from(meetingsActions).where(eq(meetingsActions.id, actionId));
  if (!action) return NOT_FOUND;
  return withMeeting(ex, actor, action.meetingId, "editor", async () => {
    if (action.state !== "open") return { status: "decided", state: action.state } as const;
    const won = await ex
      .update(meetingsActions)
      .set({
        state: decision.accept ? "done" : "dismissed",
        taskId: decision.taskId ?? null,
        decidedByMemberId: actor?.member?.id ?? null,
        decidedAt: new Date(),
      })
      .where(and(eq(meetingsActions.id, actionId), eq(meetingsActions.state, "open")))
      .returning({ id: meetingsActions.id });
    if (won.length === 0) return { status: "decided", state: "done" } as const;
    return {
      status: "ok",
      action: {
        ...action,
        state: decision.accept ? "done" : "dismissed",
        taskId: decision.taskId ?? null,
      },
    } as const;
  });
}

/** Deletes the meeting and everything on it; returns the files the caller deletes from Drive. */
export function deleteMeeting(ex: Ex, actor: MeetingsActor | null, meetingId: string) {
  return withMeeting(ex, actor, meetingId, "owner", async ({ meeting }) => {
    await ex.delete(meetingsMeetings).where(eq(meetingsMeetings.id, meetingId));
    return {
      status: "ok",
      files: [meeting.audioNodeId, meeting.rawNodeId].filter((n): n is string => n !== null),
    } as const;
  });
}
