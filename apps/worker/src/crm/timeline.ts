// A record's timeline (docs/spec/crm.md "The timeline"): its events, its notes, the threads
// that involve its addresses and the activity teammates share about them, merged newest first.
// The threads come from Mail's own door as the viewer (`forUser(...).threadsWith`), so each
// member sees exactly the mail they can open in the inbox, from every mailbox in their session's
// scope. Shared activity (ADR 0039 decision 2) comes from Mail's member door
// (`sharedActivityWith`): who in the company corresponded with them and when, from mailboxes the
// member cannot open, never a thread itself. A thread is one or the other, never both.
//
// A contract's events (`contract_*` in `crm_events`, written on its deal or else its company)
// are `contract` items, never repeated as `event` items.
//
// Paging: every item is ordered by `(at, id)`, newest first; ids are UUIDs (an activity's is its
// UUID-shaped key), unique across the sources. The cursor is the last item's `(at, id)`. Each
// source is asked for one page strictly older than it, the pages are merged and cut to the
// limit, so an item is never shown twice or skipped, whichever source it came from.
import type { CrmTimelineItem, CrmTimelineResponse } from "@omni/contracts";
import { crmContractStatusSchema, crmTimelineQuerySchema } from "@omni/contracts";
import type { CrmEvent, CrmRecordRef } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { threadUrl } from "../mcp/format.ts";
import { zValidator } from "../validator.ts";
import { activityOf, subjectOf, threadsOf, type MailSubject } from "./mail.ts";
import {
  decodeCursor,
  encodeCursor,
  memberCrm,
  refused,
  wireEvent,
  wireNote,
  type CrmRefusal,
} from "./http.ts";

const DEFAULT_LIMIT = 30;

const timelineCursor = z.object({ at: z.iso.datetime(), id: z.string().min(1) });

type RecordKind = "companies" | "people" | "deals";

/** What the timeline asks the sources about: the record, and the addresses Mail is asked for. */
type Subject = ({ status: "ok"; ref: CrmRecordRef } & MailSubject) | CrmRefusal;

/** A person's own addresses; a deal's people's; a company's people's plus its domains. */
async function recordSubject(c: Context<AppEnv>, kind: RecordKind, id: string): Promise<Subject> {
  const crm = memberCrm(c);
  if (kind === "people") {
    const found = await crm.person(id);
    if (found.status !== "ok") return found;
    return { status: "ok", ref: { personId: id }, ...subjectOf([found.person]) };
  }
  if (kind === "deals") {
    const found = await crm.deal(id);
    if (found.status !== "ok") return found;
    return { status: "ok", ref: { dealId: id }, ...subjectOf(found.people) };
  }
  const found = await crm.company(id);
  if (found.status !== "ok") return found;
  return { status: "ok", ref: { companyId: id }, ...subjectOf(found.people, found.domains) };
}

const CONTRACT_CHANGES = {
  contract_created: "created",
  contract_status_changed: "status",
  contract_document_changed: "document",
  contract_deleted: "deleted",
} as const;

const contractChange = (kind: string) =>
  Object.hasOwn(CONTRACT_CHANGES, kind)
    ? CONTRACT_CHANGES[kind as keyof typeof CONTRACT_CHANGES]
    : null;

/** What every contract event carries (`@omni/db`'s `contractEvent`). */
const contractData = z.object({
  contractId: z.string().min(1),
  title: z.string(),
  status: crmContractStatusSchema,
});

/** An event as its timeline item: a contract's own events are `contract` items. */
function eventItem(event: CrmEvent): CrmTimelineItem {
  const at = event.createdAt.toISOString();
  const change = contractChange(event.kind);
  const parsed = change && contractData.safeParse(event.data);
  if (!parsed?.success) return { kind: "event", id: event.id, at, event: wireEvent(event) };
  return {
    kind: "contract",
    id: event.id,
    at,
    contract: { ...parsed.data, change: change!, actorMemberId: event.actorMemberId },
  };
}

const newestFirst = (a: CrmTimelineItem, b: CrmTimelineItem) =>
  a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;

async function timeline(c: Context<AppEnv>, kind: RecordKind, id: string, page: Query) {
  const subject = await recordSubject(c, kind, id);
  if (subject.status !== "ok") return refused(c, subject);
  const limit = page.limit ?? DEFAULT_LIMIT;
  const decoded = decodeCursor(page.cursor, timelineCursor);
  const cursor = decoded ? { at: new Date(decoded.at), id: decoded.id } : null;
  const crm = memberCrm(c);
  const crmPage = { cursor: cursor && { createdAt: cursor.at, id: cursor.id }, limit };
  // Mail's sources are asked for one more than `limit`, to tell whether more exist.
  const [events, notes, threads, activity] = await Promise.all([
    crm.events(subject.ref, crmPage),
    crm.notes(subject.ref, crmPage),
    threadsOf(c, subject, cursor, limit + 1),
    activityOf(c, subject, cursor, limit + 1),
  ]);
  // The record was there a moment ago; deleted since, it is gone.
  if (events.status !== "ok") return refused(c, events);
  if (notes.status !== "ok") return refused(c, notes);

  const webAppURL = c.var.config.auth.webAppURL;
  const merged: CrmTimelineItem[] = [
    ...events.items.map(eventItem),
    ...notes.items.map((note) => ({
      kind: "note" as const,
      id: note.id,
      at: note.createdAt.toISOString(),
      note: wireNote(note),
    })),
    ...threads.map((thread) => ({
      kind: "thread" as const,
      id: thread.id,
      at: thread.lastMessageAt.toISOString(),
      thread: {
        id: thread.id,
        mailboxId: thread.mailboxId,
        subject: thread.subject,
        snippet: thread.snippet,
        lastMessageAt: thread.lastMessageAt.toISOString(),
        latestFrom: thread.latestFrom,
        url: threadUrl(webAppURL, thread.id),
      },
    })),
    ...activity.map((item) => ({
      kind: "activity" as const,
      id: item.key,
      at: item.lastMessageAt.toISOString(),
      activity: { mailbox: item.mailbox, direction: item.direction, subject: item.subject },
    })),
  ].toSorted(newestFirst);
  const items = merged.slice(0, limit);
  const more = merged.length > limit || events.nextCursor !== null || notes.nextCursor !== null;
  const last = items.at(-1);
  return c.json({
    items,
    nextCursor: more && last ? encodeCursor({ at: last.at, id: last.id }) : null,
  } satisfies CrmTimelineResponse);
}

type Query = z.output<typeof crmTimelineQuerySchema>;

const query = zValidator("query", crmTimelineQuerySchema);

export const timelines = new Hono<AppEnv>()
  .get("/companies/:id/timeline", query, (c) =>
    timeline(c, "companies", c.req.param("id"), c.req.valid("query")),
  )
  .get("/people/:id/timeline", query, (c) =>
    timeline(c, "people", c.req.param("id"), c.req.valid("query")),
  )
  .get("/deals/:id/timeline", query, (c) =>
    timeline(c, "deals", c.req.param("id"), c.req.valid("query")),
  );
