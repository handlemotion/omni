import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members, users } from "../schema/auth.ts";
import { personalSpaces } from "../schema/identity.ts";
import { talkThreads } from "../schema/talk.ts";

export type Ex = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;

/** A member who may use Talk: a teammate in a company workspace, never a freelancer. */
export interface TalkMember {
  id: string;
  orgId: string;
  userId: string;
}

export const NO_TALK = { status: "no_talk" } as const;
export const NOT_FOUND = { status: "not_found" } as const;
export type NoTalk = typeof NO_TALK;
export type NotFound = typeof NOT_FOUND;

/** Roles a teammate holds: any but a freelancer's alone. Owners and admins are teammates. */
export const isTeammateRole = (role: string) => {
  const roles = role.split(",").map((r) => r.trim());
  return roles.some((r) => r !== "freelancer");
};

/** The member, when Talk is open to them; null otherwise. */
export async function loadTalkMember(ex: Ex, memberId: string) {
  const [row] = await ex
    .select({
      id: members.id,
      orgId: members.organizationId,
      userId: members.userId,
      role: members.role,
      personal: sql<boolean>`exists (select 1 from ${personalSpaces} where ${personalSpaces.orgId} = ${members.organizationId})`,
    })
    .from(members)
    .where(eq(members.id, memberId));
  if (!row || row.personal || !isTeammateRole(row.role)) return null;
  return { id: row.id, orgId: row.orgId, userId: row.userId } satisfies TalkMember;
}

/** A teammate of `me`, by member id, with what the window shows of them; null otherwise. */
export async function teammateOf(ex: Ex, me: TalkMember, memberId: string) {
  if (memberId === me.id) return null;
  const [row] = await ex
    .select({
      id: members.id,
      userId: members.userId,
      role: members.role,
      name: users.name,
      email: users.email,
    })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.id, memberId), eq(members.organizationId, me.orgId)));
  return row && isTeammateRole(row.role) ? row : null;
}

/** The pair in the order a thread keeps it. */
export const pairOf = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

/** The thread, when `me` is one of its two; with the other one's member id. */
export async function threadOf(ex: Ex, me: TalkMember, threadId: string) {
  const [row] = await ex
    .select()
    .from(talkThreads)
    .where(
      and(
        eq(talkThreads.id, threadId),
        eq(talkThreads.orgId, me.orgId),
        sql`${me.id} in (${talkThreads.memberAId}, ${talkThreads.memberBId})`,
      ),
    );
  if (!row) return null;
  return { ...row, otherMemberId: row.memberAId === me.id ? row.memberBId : row.memberAId };
}

export type TalkThreadRow = NonNullable<Awaited<ReturnType<typeof threadOf>>>;

/** Runs `fn` as the member, or answers `no_talk`. */
export async function asTalkMember<T>(ex: Ex, memberId: string, fn: (m: TalkMember) => Promise<T>) {
  const member = await loadTalkMember(ex, memberId);
  return member ? fn(member) : NO_TALK;
}
