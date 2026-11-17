import { sql, type SQL } from "drizzle-orm";

/** Conditions on the messages of a thread: some message must match all of them. */
export interface MessageFilters {
  /** Sender: an address (`ana@acme.com`) or a domain (`acme.com`, which covers its subdomains). */
  from?: string;
  /** Anyone on a message (from, to or cc): an address or a domain. */
  participant?: string;
  /** Sent at or after. */
  after?: Date;
  /** Sent before. */
  before?: Date;
  hasAttachments?: boolean;
  /** Sent from the inbox's own address (by the person or, on a shared inbox, their team). */
  fromMe?: boolean;
}

/** Conditions on the thread itself (shared inboxes' helpdesk state). */
export interface ConversationFilters {
  status?: "open" | "pending" | "snoozed" | "resolved";
  /** A tag on the thread, by name (case-insensitive). */
  tag?: string;
}

export type ThreadFilters = MessageFilters & ConversationFilters;

/** Whether `filters` sets any message condition. */
export function hasMessageFilters(filters: MessageFilters) {
  return Object.values(messageOnly(filters)).some((value) => value !== undefined);
}

function messageOnly({ from, participant, after, before, hasAttachments, fromMe }: MessageFilters) {
  return { from, participant, after, before, hasAttachments, fromMe };
}

const addressMatches: (address: SQL, who: string) => SQL = (address, who) => {
  const target = who.toLowerCase();
  if (target.includes("@")) return sql`lower(${address}) = ${target}`;
  return sql`(lower(${address}) like ${`%@${target}`} or lower(${address}) like ${`%.${target}`})`;
};

/**
 * The message conditions on the message row aliased `alias` (a constant in our code, never input),
 * or undefined when there are none.
 */
export const messageCondition: (alias: string, filters: MessageFilters) => SQL | undefined = (
  alias,
  filters,
) => {
  const m = sql.raw(alias);
  const parts: SQL[] = [];
  if (filters.from) parts.push(addressMatches(sql`${m}.from_address`, filters.from));
  if (filters.participant) {
    const who = filters.participant;
    parts.push(
      sql`(${addressMatches(sql`${m}.from_address`, who)} or exists (select 1 from jsonb_array_elements(${m}."to" || ${m}.cc) p where ${addressMatches(sql`(p->>'address')`, who)}))`,
    );
  }
  if (filters.after) parts.push(sql`${m}.sent_at >= ${filters.after.toISOString()}::timestamptz`);
  if (filters.before) parts.push(sql`${m}.sent_at < ${filters.before.toISOString()}::timestamptz`);
  if (filters.hasAttachments !== undefined) {
    const has = sql`exists (select 1 from attachments a where a.message_id = ${m}.id and not a.inline)`;
    parts.push(filters.hasAttachments ? has : sql`not ${has}`);
  }
  if (filters.fromMe !== undefined) {
    const mine = sql`lower(${m}.from_address) = (select lower(mb.address) from mailboxes mb where mb.id = ${m}.mailbox_id)`;
    parts.push(filters.fromMe ? mine : sql`not ${mine}`);
  }
  return parts.length ? sql.join(parts, sql` and `) : undefined;
};

/** The conversation conditions on the thread row aliased `alias`, or undefined. */
export const conversationCondition: (
  alias: string,
  filters: ConversationFilters,
) => SQL | undefined = (alias, filters) => {
  const t = sql.raw(alias);
  const parts: SQL[] = [];
  if (filters.status) parts.push(sql`${t}.status = ${filters.status}`);
  if (filters.tag) {
    parts.push(
      sql`exists (select 1 from thread_tags tt join tags tg on tg.id = tt.tag_id where tt.thread_id = ${t}.id and lower(tg.name) = ${filters.tag.toLowerCase()})`,
    );
  }
  return parts.length ? sql.join(parts, sql` and `) : undefined;
};
