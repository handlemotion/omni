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

type Subject = ({ status: "ok"; ref: CrmRecordRef } & MailSubject) | CrmRefusal;

const recordSubject: (
  c: Context<AppEnv>,
  kind: RecordKind,
  id: string,
) => Promise<Subject> = async (c, kind, id) => {
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
};

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

const contractData = z.object({
  contractId: z.string().min(1),
  title: z.string(),
  status: crmContractStatusSchema,
});

const eventItem: (event: CrmEvent) => CrmTimelineItem = (event) => {
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
};

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
  const [events, notes, threads, activity] = await Promise.all([
    crm.events(subject.ref, crmPage),
    crm.notes(subject.ref, crmPage),
    threadsOf(c, subject, cursor, limit + 1),
    activityOf(c, subject, cursor, limit + 1),
  ]);
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
