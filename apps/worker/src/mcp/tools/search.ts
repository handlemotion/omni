// `search`: find threads (ADR 0029), in the shape ChatGPT's deep research expects
// (`results: [{ id, title, url }]`) with what an agent needs to pick which to `fetch`.
//
// - With a query: smart search (full-text recall per mailbox, reranked by Jev when configured),
//   narrowed by the message filters inside recall. Best match first.
// - Without one: the thread list, newest first, with every filter, paged by cursor.
import type { McpServer } from "@modelcontextprotocol/server";
import { LANES, THREAD_VIEWS, type ThreadFilters } from "@omni/db";
import { z } from "zod";
import { smartSearch } from "../../search.ts";
import { laneOf, personSchema, result, threadSummary, threadUrl, toolError } from "../format.ts";
import { findMailbox, readsFor, unknownMailbox, type Reads } from "../scope.ts";
import { guarded, type ToolContext } from "../server.ts";

/**
 * An address or a domain. The domain part is letters, digits and hyphens only: it becomes a LIKE
 * pattern, where `_` and `%` would be wildcards.
 */
const who = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^([\w.+-]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/,
    "an address (ana@acme.com) or a domain (acme.com)",
  );

const when = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "an ISO 8601 date or time")
  .transform((value) => new Date(value));

const inputSchema = z.object({
  query: z
    .string()
    .max(500)
    .default("")
    .describe(
      'Words to find, web search syntax ("exact phrase", -exclude). Empty: list threads by the filters, newest first.',
    ),
  from: who.optional().describe("Sender address or domain (domain covers subdomains)."),
  participant: who.optional().describe("Anyone on a message (from, to or cc): address or domain."),
  after: when.optional().describe("Sent at or after (ISO 8601)."),
  before: when.optional().describe("Sent before (ISO 8601)."),
  has_attachments: z.boolean().optional(),
  from_me: z.boolean().optional().describe("Sent from the inbox's own address."),
  mailbox: z.string().optional().describe("One inbox: its id or address."),
  workspace: z.string().min(1).optional().describe("One workspace id."),
  view: z
    .enum(THREAD_VIEWS)
    .optional()
    .describe("Without a query only. inbox (default), later, done, archive or all."),
  lane: z.enum(LANES).optional().describe("Without a query only. A triage lane."),
  unread: z.boolean().optional().describe("Without a query only. Only unread threads."),
  status: z
    .enum(["open", "pending", "snoozed", "resolved"])
    .optional()
    .describe("Without a query only. Shared inboxes' conversation status."),
  tag: z.string().max(100).optional().describe("Without a query only. A tag name."),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional().describe("Without a query only: `next_cursor` from the last page."),
});

type Input = z.infer<typeof inputSchema>;

const resultSchema = z.object({
  id: z.string().describe("The thread id, for `fetch`."),
  title: z.string(),
  url: z.string(),
  mailbox: z.string(),
  from: personSchema.nullable().describe("Sender of the matching (or latest) message."),
  sent_at: z.string().describe("When the matching (or latest) message was sent."),
  last_message_at: z.string(),
  message_count: z.number(),
  snippet: z.string(),
  unread: z.boolean(),
  lane: z.string().nullable().describe("Triage lane, as in `inbox`; null before triage."),
});

const outputSchema = z.object({
  results: z.array(resultSchema),
  ranking: z.enum(["relevance", "text", "newest"]),
  next_cursor: z.string().optional(),
  note: z.string().optional(),
});

/** Filters that only the thread list applies; a query ignores them, and says so. */
const LIST_ONLY = ["view", "lane", "unread", "status", "tag", "cursor"] as const;

function encodeCursor(row: { lastMessageAt: Date; id: string }) {
  return btoa(JSON.stringify([row.lastMessageAt.toISOString(), row.id]));
}

function decodeCursor(cursor: string) {
  try {
    const [at, id] = JSON.parse(atob(cursor)) as [string, string];
    const lastMessageAt = new Date(at);
    if (typeof id !== "string" || Number.isNaN(lastMessageAt.getTime())) return null;
    return { lastMessageAt, id };
  } catch {
    return null;
  }
}

const filtersOf: (input: Input) => ThreadFilters = (input) => {
  return {
    from: input.from,
    participant: input.participant,
    after: input.after,
    before: input.before,
    hasAttachments: input.has_attachments,
    fromMe: input.from_me,
    status: input.status,
    tag: input.tag,
  };
};

async function find(context: ToolContext, input: Input) {
  const wait = await context.rateLimit("search");
  if (wait) return toolError(`Too many searches. Try again in ${wait} seconds.`);
  const scoped = readsFor(context, input.workspace);
  if ("error" in scoped) return toolError(scoped.error);
  const { reads } = scoped;
  const mailbox = input.mailbox ? await findMailbox(reads, input.mailbox) : undefined;
  if (input.mailbox && !mailbox) return toolError(unknownMailbox(input.mailbox));
  const query = input.query.trim();
  return query
    ? searchByWords(context, reads, input, query, mailbox?.id)
    : listByFilters(context, reads, input, mailbox?.id);
}

async function searchByWords(
  context: ToolContext,
  reads: Reads,
  input: Input,
  query: string,
  mailboxId: string | undefined,
) {
  const { hits, ranking } = await smartSearch(reads, context.config, query, {
    mailboxId,
    limit: input.limit,
    log: context.log,
    filters: filtersOf(input),
  });
  const ignored = LIST_ONLY.filter((key) => input[key] !== undefined);
  return result({
    results: hits.map((hit) => ({
      id: hit.threadId,
      title: hit.subject,
      url: threadUrl(context.webAppURL, hit.threadId),
      mailbox: hit.mailboxAddress,
      from: hit.from,
      sent_at: hit.sentAt.toISOString(),
      last_message_at: hit.lastMessageAt.toISOString(),
      message_count: hit.messageCount,
      snippet: hit.snippet,
      unread: hit.unread,
      lane: laneOf(hit),
    })),
    ranking: ranking === "jev" ? ("relevance" as const) : ("text" as const),
    ...(ignored.length
      ? { note: `With a query, ${ignored.join(", ")} are ignored. Search without one to use them.` }
      : {}),
  });
}

async function listByFilters(
  context: ToolContext,
  reads: Reads,
  input: Input,
  mailboxId: string | undefined,
) {
  const before = input.cursor ? decodeCursor(input.cursor) : undefined;
  if (before === null)
    return toolError("That cursor is not one `search` returned. Start over without it.");
  const [rows, mailboxes] = await Promise.all([
    reads.listThreads({
      mailboxId,
      view: input.view ?? "inbox",
      lane: input.lane,
      unread: input.unread,
      filters: filtersOf(input),
      before,
      // One more than asked: whether there is a next page.
      limit: input.limit + 1,
    }),
    reads.listMailboxes(),
  ]);
  const page = rows.slice(0, input.limit);
  const addressOf = new Map(mailboxes.map((m) => [m.id, m.address]));
  const format = {
    webAppURL: context.webAppURL,
    mailboxAddress: (id: string) => addressOf.get(id) ?? "",
  };
  const last = page.at(-1);
  return result({
    results: page.map((row) => {
      const thread = threadSummary(row, format);
      return {
        id: thread.id,
        title: thread.subject,
        url: thread.url,
        mailbox: thread.mailbox,
        from: thread.from,
        sent_at: thread.last_message_at,
        last_message_at: thread.last_message_at,
        message_count: thread.message_count,
        snippet: thread.snippet,
        unread: thread.unread,
        lane: thread.lane,
      };
    }),
    ranking: "newest" as const,
    ...(rows.length > input.limit && last ? { next_cursor: encodeCursor(last) } : {}),
  });
}

export function registerSearch(server: McpServer, context: ToolContext) {
  server.registerTool(
    "search",
    {
      title: "Search mail",
      description:
        "Find threads. With `query`, the best matches for those words (narrowed by from, participant, after, before, has_attachments, from_me, mailbox). Without one, list threads newest first by any filter, including view, lane, unread, status and tag, with `next_cursor` for more. Returns ids to pass to `fetch`, which reads up to 10 threads at once.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "search", () => find(context, input)),
  );
}
