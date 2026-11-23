import { sql, type SQL } from "drizzle-orm";
import {
  mailboxAccess,
  mailboxes,
  members,
  messages,
  threadState,
  threads,
  triageBucket,
} from "../schema/index.ts";
import type { GrantScope, IsGrantee, Participant } from "./grants.ts";
import { cleanPreview, withoutLinks } from "./thread-preview.ts";
import { messageCondition, type MessageFilters } from "./thread-filters.ts";

const SEARCH_EXACT_HITS = 20;
const SEARCH_WORD_HITS = 25;
const SEARCH_SENDER_WINDOW = 300;
const SEARCH_RECENCY_DAYS = 30;
const SEARCH_FILTER_WINDOW = 200;
const RECALL_COLUMNS = sql.raw(
  'm.id, m.thread_id, m.sent_at, m.mailbox_id, m.from_address, m."to", m.cc',
);
const SEARCH_MAX_WORDS = 6;

function searchWords(query: string) {
  const words = new Set<string>();
  for (const chunk of query.split(/\s+/)) {
    if (chunk.startsWith("-")) continue;
    for (const [word] of chunk.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) words.add(word);
  }
  return { words: [...words].slice(0, SEARCH_MAX_WORDS), prefix: /[\p{L}\p{N}]$/u.test(query) };
}

function headline(query: SQL, options: string) {
  return sql`ts_headline('english', regexp_replace(${withoutLinks(sql`left(m.clean_text, 6000)`)}, '\\s+', ' ', 'g'), ${query}, ${`${options}, StartSel="", StopSel="", ShortWord=2`})`;
}

interface SearchRow {
  org_id: string;
  thread_id: string;
  message_id: string;
  mailbox_id: string;
  mailbox_address: string;
  subject: string;
  from_name: string | null;
  from_address: string;
  sent_at: string | Date;
  last_message_at: string | Date;
  message_count: number;
  score: number;
  triage: (typeof triageBucket.enumValues)[number] | null;
  triage_source: string | null;
  triage_confidence: number | null;
  read: boolean;
  snippet: string;
  excerpt: string;
}

function toSearchHit(row: SearchRow) {
  return {
    orgId: row.org_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    mailboxId: row.mailbox_id,
    mailboxAddress: row.mailbox_address,
    subject: row.subject,
    from: { name: row.from_name, address: row.from_address } satisfies Participant,
    sentAt: new Date(row.sent_at),
    lastMessageAt: new Date(row.last_message_at),
    messageCount: row.message_count,
    score: row.score,
    triage: row.triage,
    triageSource: row.triage_source,
    triageConfidence: row.triage_confidence,
    unread: !row.read,
    snippet: row.snippet,
    excerpt: row.excerpt,
  };
}

function threadColumns(isGrantee: IsGrantee) {
  return sql`t.triage, t.triage_source, t.triage_confidence,
    coalesce((select s.read from ${threadState} s join ${mailboxAccess} sa on sa.member_id = s.member_id and sa.mailbox_id = t.mailbox_id where s.thread_id = t.id and ${isGrantee(sql`sa.member_id`)} limit 1), false) as read,
    (select count(*)::int from ${messages} c where c.thread_id = t.id) as message_count`;
}

function recentMessages(columns: SQL, filter: SQL, window: number, matching: SQL | undefined) {
  const inMailbox = sql`m.mailbox_id = ma.mailbox_id and m.org_id = mem.organization_id and ${filter}`;
  if (!matching) {
    return sql`(select ${columns} from ${messages} m where ${inMailbox} order by m.sent_at desc, m.id desc`;
  }
  return sql`(select ${columns} from (select ${RECALL_COLUMNS} from ${messages} m where ${inMailbox} order by m.sent_at desc, m.id desc limit ${window}) m where ${matching} order by m.sent_at desc, m.id desc`;
}

function recallHits(query: string, matching: SQL | undefined) {
  const { words, prefix } = searchWords(query);
  const terms = words.map((w, i) => (prefix && i === words.length - 1 ? `${w}:*` : w));
  const exact = sql`websearch_to_tsquery('english', ${query})`;
  const recall = (source: SQL, filter: SQL, cap: number) =>
    sql`${recentMessages(sql`m.id, m.thread_id, m.sent_at, ${source} as source`, filter, SEARCH_FILTER_WINDOW, matching)} limit ${cap})`;
  const exactRecall =
    terms.length === 1
      ? sql`(select null::text as id, null::text as thread_id, null::timestamptz as sent_at, null::text as source where false)`
      : recall(sql`'exact'`, sql`m.search_vector @@ ${exact}`, SEARCH_EXACT_HITS);
  const wordRecall = sql.join(
    terms.map(
      (term) =>
        sql` union all ${recall(sql`${term}::text`, sql`m.search_vector @@ to_tsquery('english', ${term}) and numnode(to_tsquery('english', ${term})) > 0`, SEARCH_WORD_HITS)}`,
    ),
  );
  const senderPatterns = words.filter((w) => w.length >= 3).map((w) => `%${w}%`);
  const senderWindow = sql`${recentMessages(sql`m.id, m.thread_id, m.sent_at, m.from_address`, sql`true`, SEARCH_SENDER_WINDOW, matching)} limit ${SEARCH_SENDER_WINDOW}`;
  const senderRecall = senderPatterns.length
    ? sql`union all (select r.id, r.thread_id, r.sent_at, 'sender' as source from ${senderWindow}) r where r.from_address ilike any (array[${sql.join(
        senderPatterns.map((pattern) => sql`${pattern}`),
        sql`, `,
      )}]))`
    : sql``;
  const any = terms.length ? sql`to_tsquery('english', ${terms.join(" | ")})` : exact;
  return { hits: sql`${exactRecall} ${wordRecall} ${senderRecall}`, any };
}

/** Full-text search over the grantees' mail, and the newest threads for an empty query. */
export function searchQueries({ db, isGrantee }: GrantScope) {
  const inMailbox = (mailboxId: string | undefined) =>
    mailboxId ? sql`and ma.mailbox_id = ${mailboxId}` : sql``;
  return {
    async search(
      query: string,
      options: { mailboxId?: string; limit?: number; filters?: MessageFilters } = {},
    ) {
      const { mailboxId, limit = 20 } = options;
      const matching = options.filters && messageCondition("m", options.filters);
      const { hits, any } = recallHits(query, matching);
      const rows = (await db.execute(sql`
        with hits as (
          select h.* from ${mailboxAccess} ma
          join ${members} mem on mem.id = ma.member_id
          cross join lateral (${hits}) h
          where ${isGrantee(sql`ma.member_id`)} ${inMailbox(mailboxId)}
        ),
        weighted as (
          select id, thread_id, sent_at, source,
            case when source in ('exact', 'sender') then 1.0
              else ln(1 + (count(*) over ())::float8 / count(*) over (partition by source)) end as weight
          from hits
        ),
        scored as (
          select id, thread_id,
            sum(weight) * (1 + power(0.5, greatest(extract(epoch from now() - sent_at), 0) / 86400 / ${SEARCH_RECENCY_DAYS}::float8)) as score
          from (select distinct on (id, source) * from weighted) d
          group by id, thread_id, sent_at
        ),
        best as (
          select distinct on (thread_id) thread_id, id, score
          from scored order by thread_id, score desc, id desc
        ),
        top as (select * from best order by score desc, thread_id desc limit ${limit})
        select t.org_id, top.thread_id, m.id as message_id, t.mailbox_id, mb.address as mailbox_address,
          m.subject, m.from_name, m.from_address, m.sent_at, t.last_message_at, top.score::float8 as score,
          ${threadColumns(isGrantee)},
          ${headline(any, "MaxWords=20, MinWords=10, MaxFragments=1")} as snippet,
          ${headline(any, "MaxWords=60, MinWords=40")} as excerpt
        from top
        join ${messages} m on m.id = top.id
        join ${threads} t on t.id = top.thread_id
        join ${mailboxes} mb on mb.id = t.mailbox_id
        order by top.score desc, top.thread_id desc
      `)) as unknown as SearchRow[];
      return rows.map(toSearchHit);
    },

    async searchRecent(options: { mailboxId?: string; limit: number }) {
      const { mailboxId, limit } = options;
      const rows = (await db.execute(sql`
        with page as (
          select t.* from ${mailboxAccess} ma
          join ${members} mem on mem.id = ma.member_id
          cross join lateral (
            select t.id, t.org_id, t.mailbox_id, t.last_message_at, t.triage, t.triage_source, t.triage_confidence
            from ${threads} t
            where t.mailbox_id = ma.mailbox_id and t.org_id = mem.organization_id
            order by t.last_message_at desc, t.id desc limit ${limit}
          ) t
          where ${isGrantee(sql`ma.member_id`)} ${inMailbox(mailboxId)}
          order by t.last_message_at desc, t.id desc limit ${limit}
        )
        select t.org_id, t.id as thread_id, m.id as message_id, t.mailbox_id, mb.address as mailbox_address,
          m.subject, m.from_name, m.from_address, m.sent_at, t.last_message_at, 0::float8 as score,
          ${threadColumns(isGrantee)},
          ${cleanPreview(200, 400)} as snippet,
          ${cleanPreview(1500, 3000)} as excerpt
        from page t
        join lateral (
          select m.id, m.subject, m.from_name, m.from_address, m.sent_at, m.clean_text
          from ${messages} m where m.thread_id = t.id
          order by m.sent_at desc, m.id desc limit 1
        ) m on true
        join ${mailboxes} mb on mb.id = t.mailbox_id
        order by t.last_message_at desc, t.id desc
      `)) as unknown as SearchRow[];
      return rows.map(toSearchHit);
    },
  };
}
