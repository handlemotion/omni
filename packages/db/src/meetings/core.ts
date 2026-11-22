import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.ts";
import { storageAddresses } from "../storage.ts";
import { members, users } from "../schema/auth.ts";
import { userEmails } from "../schema/identity.ts";
import { meetingsGrants, meetingsMeetings } from "../schema/meetings.ts";

export type Ex = Pick<
  Db,
  "select" | "selectDistinctOn" | "insert" | "update" | "delete" | "execute"
>;

export const NOT_FOUND = { status: "not_found" } as const;
export const FORBIDDEN = { status: "forbidden" } as const;

export const ROLES = ["viewer", "editor", "owner"] as const;
export type MeetingRole = (typeof ROLES)[number];

/** Who is asking: a member of one workspace, or a signed-in person through the user door. */
export interface MeetingsActor {
  userId: string;
  /** Lowercase, verified. */
  addresses: string[];
  /** Set for the member door: the workspace they are in. */
  member: { id: string; orgId: string; teammate: boolean } | null;
  /** The user door may be scoped to one workspace. */
  scopeOrgId: string | null;
}

const teammateRole = (role: string) => role.split(",").some((r) => r.trim() !== "freelancer");

/** The person's verified addresses, lowercase. */
export async function addressesOf(ex: Ex, userId: string) {
  const [user] = await ex
    .select({ email: users.email, verified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId));
  const extra = await ex
    .select({ email: userEmails.email })
    .from(userEmails)
    .where(eq(userEmails.userId, userId));
  const all = [...(user?.verified ? [user.email] : []), ...extra.map((e) => e.email)];
  return [...new Set(all.map((a) => a.toLowerCase()))];
}

export async function memberActor(ex: Ex, memberId: string) {
  const [row] = await ex
    .select({
      id: members.id,
      orgId: members.organizationId,
      userId: members.userId,
      role: members.role,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row) return null;
  return {
    userId: row.userId,
    addresses: await addressesOf(ex, row.userId),
    member: { id: row.id, orgId: row.orgId, teammate: teammateRole(row.role) },
    scopeOrgId: row.orgId,
  } satisfies MeetingsActor;
}

export async function userActor(ex: Ex, userId: string, scopeOrgId: string | null) {
  return {
    userId,
    addresses: scopeOrgId
      ? await storageAddresses(ex as Db, userId, scopeOrgId)
      : await addressesOf(ex, userId),
    member: null,
    scopeOrgId,
  } satisfies MeetingsActor;
}

/**
 * The meetings `actor` may open, as a condition on `meetings_meetings`: a grant to one of their
 * addresses, being its recorder, or `workspace` access for a teammate of its workspace. A member
 * reaches only their own workspace's meetings; the user door any it was granted, or one scope.
 * The user door never counts an `owner` grant: a recorder reaches their meetings as a member, so
 * one who left the workspace keeps none of them, as their My files go to someone else.
 */
export function reachable(actor: MeetingsActor) {
  const m = meetingsMeetings;
  const byOwner = actor.member ? sql`` : sql` and g.role <> 'owner'`;
  const granted = actor.addresses.length
    ? sql`exists (select 1 from ${meetingsGrants} g where g.meeting_id = ${m.id} and g.address in ${actor.addresses}${byOwner})`
    : sql`false`;
  const ways: SQL[] = [granted];
  if (actor.member) {
    ways.push(eq(m.recordedByMemberId, actor.member.id));
    if (actor.member.teammate) ways.push(eq(m.access, "workspace"));
  }
  const inScope = actor.scopeOrgId ? eq(m.orgId, actor.scopeOrgId) : undefined;
  return and(inScope, or(...ways));
}

const best = (roles: MeetingRole[]) =>
  roles.reduce<MeetingRole | null>(
    (top, r) => (top === null || ROLES.indexOf(r) > ROLES.indexOf(top) ? r : top),
    null,
  );

/** The meeting and the actor's role on it; null when they cannot open it. */
export async function access(ex: Ex, actor: MeetingsActor, meetingId: string) {
  const [meeting] = await ex
    .select()
    .from(meetingsMeetings)
    .where(and(eq(meetingsMeetings.id, meetingId), reachable(actor)));
  if (!meeting) return null;
  const grants = actor.addresses.length
    ? await ex
        .select({ role: meetingsGrants.role })
        .from(meetingsGrants)
        .where(
          and(
            eq(meetingsGrants.meetingId, meetingId),
            inArray(meetingsGrants.address, actor.addresses),
          ),
        )
    : [];
  const roles: MeetingRole[] = grants
    .map((g) => g.role)
    .filter((role) => actor.member || role !== "owner");
  if (actor.member && meeting.recordedByMemberId === actor.member.id) roles.push("owner");
  if (actor.member?.teammate && meeting.access === "workspace") roles.push("viewer");
  const role = best(roles) ?? "viewer";
  return { meeting, role };
}

export const atLeast = (role: MeetingRole, needed: MeetingRole) =>
  ROLES.indexOf(role) >= ROLES.indexOf(needed);

/**
 * Runs `fn` with the meeting when the actor reaches it with at least `needed`. `not_found` when
 * they cannot open it at all (its existence does not leak); `forbidden` when they can only read.
 */
export async function withMeeting<R>(
  ex: Ex,
  actor: MeetingsActor | null,
  meetingId: string,
  needed: MeetingRole,
  fn: (found: NonNullable<Awaited<ReturnType<typeof access>>>) => Promise<R>,
) {
  if (!actor) return NOT_FOUND;
  const found = await access(ex, actor, meetingId);
  if (!found) return NOT_FOUND;
  if (!atLeast(found.role, needed)) return FORBIDDEN;
  return fn(found);
}

/**
 * Where a meeting's group is: `series:<UID>` for a recurring event, `domain:<domain>` for the
 * outside company most attendees are from (webmail and the workspace's own domains skipped),
 * else `meeting:<id>`.
 */
export function groupKeyFor(input: {
  meetingId: string;
  eventUid: string | null;
  recurring: boolean;
  attendees: string[];
  ownDomains: string[];
}) {
  if (input.eventUid && input.recurring) return `series:${input.eventUid}`;
  const own = new Set(input.ownDomains.map((d) => d.toLowerCase()));
  const counts = new Map<string, number>();
  for (const address of input.attendees) {
    const domain = address.split("@")[1]?.toLowerCase();
    if (!domain || own.has(domain) || WEBMAIL.has(domain)) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const top = [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return top ? `domain:${top[0]}` : `meeting:${input.meetingId}`;
}

/** Personal mail providers: a meeting with someone on them is not a meeting with a company. */
export const WEBMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
]);
