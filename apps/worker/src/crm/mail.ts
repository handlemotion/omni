// What a record shows of the workspace's mail, read through Mail's door (ADR 0036 decision 3,
// ADR 0039 decision 2): the threads the viewer can open (`threadsWith`, as the viewer, in their
// session's scope) and the activity teammates' mailboxes share (`sharedActivityWith`, as the
// member, in the active company). A thread the viewer can open is never also activity: Mail
// leaves the mailboxes they can open out of the second read.
import { forMember, forUser, type SharedActivity, type ThreadWith } from "@omni/db";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";

/** The addresses and domains Mail is asked about for one record. */
export interface MailSubject {
  addresses: string[];
  domains: string[];
}

/** A timeline position: items strictly older than `(at, id)`. */
export type Before = { at: Date; id: string } | null;

const nothing = (subject: MailSubject) =>
  subject.addresses.length === 0 && subject.domains.length === 0;

/** The viewer's threads with the record, newest first. */
export const threadsOf: (
  c: Context<AppEnv>,
  subject: MailSubject,
  before: Before,
  limit: number,
) => Promise<ThreadWith[]> = async (c, subject, before, limit) => {
  if (nothing(subject)) return [];
  const { user, db } = c.var;
  return forUser(db, user.id, user.scopeOrgId).threadsWith({
    ...subject,
    before: before ? { lastMessageAt: before.at, id: before.id } : undefined,
    limit,
  });
};

/** What teammates' mailboxes share about the record, newest first. */
export const activityOf: (
  c: Context<AppEnv>,
  subject: MailSubject,
  before: Before,
  limit: number,
) => Promise<SharedActivity[]> = async (c, subject, before, limit) => {
  if (nothing(subject)) return [];
  return forMember(c.var.db, c.var.member.id).sharedActivityWith({
    ...subject,
    before: before ? { lastMessageAt: before.at, key: before.id } : undefined,
    limit,
  });
};

/** The newest of both, as ISO, or null: when anyone last corresponded with the record. */
export async function lastContactedAt(c: Context<AppEnv>, subject: MailSubject) {
  const [threads, activity] = await Promise.all([
    threadsOf(c, subject, null, 1),
    activityOf(c, subject, null, 1),
  ]);
  const times = [threads[0]?.lastMessageAt, activity[0]?.lastMessageAt].filter(
    (at): at is Date => at !== undefined,
  );
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((at) => at.getTime()))).toISOString();
}

const addressesOf = (people: { addresses: { address: string }[] }[]) =>
  people.flatMap((person) => person.addresses.map((a) => a.address));

/** A person's own addresses; a deal's people's; a company's people's plus its domains. */
export const subjectOf = (people: { addresses: { address: string }[] }[], domains: string[] = []) =>
  ({ addresses: addressesOf(people), domains }) satisfies MailSubject;
