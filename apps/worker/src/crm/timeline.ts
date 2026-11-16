// A record's timeline (docs/spec/crm.md "The timeline"): its events, its notes and the threads
// that involve its addresses, merged newest first. The threads come from Mail's own door as the
// viewer (`forUser(...).threadsWith`), so each member sees exactly the mail they can open in the
// inbox, from every mailbox in their session's scope, and nothing of anyone else's.
//
// Paging: every item is ordered by `(at, id)`, newest first; ids are UUIDs, unique across the
// three sources. The cursor is the last item's `(at, id)`. Each source is asked for one page
// strictly older than it, the pages are merged and cut to the limit, so an item is never shown
// twice or skipped, whichever source it came from.
import type { CrmTimelineItem, CrmTimelineResponse } from "@omni/contracts";
import { crmTimelineQuerySchema } from "@omni/contracts";
import { forUser, type CrmRecordRef, type ThreadWith } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { threadUrl } from "../mcp/format.ts";
import { zValidator } from "../validator.ts";
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
type Subject =
  | { status: "ok"; ref: CrmRecordRef; addresses: string[]; domains: string[] }
  | CrmRefusal;

const addressesOf = (people: { addresses: { address: string }[] }[]) =>
  people.flatMap((person) => person.addresses.map((a) => a.address));

/** A person's own addresses; a deal's people's; a company's people's plus its domains. */
async function subjectOf(c: Context<AppEnv>, kind: RecordKind, id: string): Promise<Subject> {
  const crm = memberCrm(c);
  if (kind === "people") {
    const found = await crm.person(id);
    if (found.status !== "ok") return found;
    return {
      status: "ok",
      ref: { personId: id },
      addresses: addressesOf([found.person]),
      domains: [],
    };
  }
  if (kind === "deals") {
    const found = await crm.deal(id);
    if (found.status !== "ok") return found;
    return { status: "ok", ref: { dealId: id }, addresses: addressesOf(found.people), domains: [] };
  }
  const found = await crm.company(id);
  if (found.status !== "ok") return found;
  return {
    status: "ok",
    ref: { companyId: id },
    addresses: addressesOf(found.people),
    domains: found.domains,
  };
}

const newestFirst = (a: CrmTimelineItem, b: CrmTimelineItem) =>
  a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1;

/** The viewer's threads with the record, one more than `limit` to tell whether more exist. */
async function threadsOf(
  c: Context<AppEnv>,
  subject: { addresses: string[]; domains: string[] },
  before: { at: Date; id: string } | null,
  limit: number,
): Promise<ThreadWith[]> {
  if (subject.addresses.length === 0 && subject.domains.length === 0) return [];
  const { user, db } = c.var;
  return forUser(db, user.id, user.scopeOrgId).threadsWith({
    addresses: subject.addresses,
    domains: subject.domains,
    before: before ? { lastMessageAt: before.at, id: before.id } : undefined,
    limit: limit + 1,
  });
}

async function timeline(c: Context<AppEnv>, kind: RecordKind, id: string, page: Query) {
  const subject = await subjectOf(c, kind, id);
  if (subject.status !== "ok") return refused(c, subject);
  const limit = page.limit ?? DEFAULT_LIMIT;
  const decoded = decodeCursor(page.cursor, timelineCursor);
  const cursor = decoded ? { at: new Date(decoded.at), id: decoded.id } : null;
  const crm = memberCrm(c);
  const crmPage = { cursor: cursor && { createdAt: cursor.at, id: cursor.id }, limit };
  const [events, notes, threads] = await Promise.all([
    crm.events(subject.ref, crmPage),
    crm.notes(subject.ref, crmPage),
    threadsOf(c, subject, cursor, limit),
  ]);
  // The record was there a moment ago; deleted since, it is gone.
  if (events.status !== "ok") return refused(c, events);
  if (notes.status !== "ok") return refused(c, notes);

  const webAppURL = c.var.config.auth.webAppURL;
  const merged: CrmTimelineItem[] = [
    ...events.items.map((event) => ({
      kind: "event" as const,
      id: event.id,
      at: event.createdAt.toISOString(),
      event: wireEvent(event),
    })),
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
