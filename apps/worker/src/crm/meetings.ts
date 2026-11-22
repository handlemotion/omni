import { crmMeetingsQuerySchema, type CrmMeeting, type CrmMeetingsResponse } from "@omni/contracts";
import { forMember, type MeetingRecord, type MeetingsOnQuery } from "@omni/db";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";
import { decodeCursor, encodeCursor, memberCrm, refused } from "./http.ts";
import { subjectOf, type Before, type MailSubject } from "./mail.ts";

type RecordKind = "companies" | "people" | "deals";

const KIND: Record<RecordKind, MeetingRecord["kind"]> = {
  companies: "company",
  people: "person",
  deals: "deal",
};

/** Who a record's meetings are with, worked out by the CRM, which checked the member opens it. */
export type MeetingsSubject = MailSubject & { record: MeetingRecord };

/**
 * A record's people and domains, for its meetings: a person's addresses; a company's people's
 * and its domains; a deal's people's and its company's domains, when the member opens it.
 */
export async function meetingsSubject(c: Context<AppEnv>, kind: RecordKind, id: string) {
  const crm = memberCrm(c);
  const record = { kind: KIND[kind], id };
  if (kind === "people") {
    const found = await crm.person(id);
    if (found.status !== "ok") return found;
    return { status: "ok" as const, record, ...subjectOf([found.person]) };
  }
  if (kind === "companies") {
    const found = await crm.company(id);
    if (found.status !== "ok") return found;
    return { status: "ok" as const, record, ...subjectOf(found.people, found.domains) };
  }
  const found = await crm.deal(id);
  if (found.status !== "ok") return found;
  const company = found.deal.companyId ? await crm.company(found.deal.companyId) : null;
  const domains = company?.status === "ok" ? company.domains : [];
  return { status: "ok" as const, record, ...subjectOf(found.people, domains) };
}

/**
 * The record's meetings the member can open, newest first, older than `before`. A deal's leave
 * out those someone put elsewhere or took off; a person's or company's keep them.
 */
export async function meetingsOf(
  c: Context<AppEnv>,
  subject: MeetingsSubject,
  before: Before,
  limit: number,
) {
  const query: MeetingsOnQuery = {
    record: subject.record,
    addresses: subject.addresses,
    domains: subject.domains,
    ...(subject.record.kind === "deal" ? { only: "unplaced" as const } : {}),
    before: before ? { startedAt: before.at, id: before.id } : null,
    limit,
  };
  const found = await forMember(c.var.db, c.var.member.id).meetings.on(query);
  if (found.status !== "ok") return [] as CrmMeeting[];
  return found.meetings.map<CrmMeeting>((m) => ({
    id: m.id,
    title: m.title,
    startedAt: m.startedAt.toISOString(),
    durationMs: m.durationMs,
    status: m.status,
    summary: m.summary,
    openActions: m.openActions,
    placed: m.placed,
  }));
}

const PAGE = 30;
const cursorSchema = z.object({ at: z.iso.datetime(), id: z.string().min(1) });

function meetingRefused(c: Context<AppEnv>, status: string) {
  if (status === "forbidden") {
    return apiError(c, "forbidden", "only the meeting's editors can move it");
  }
  return apiError(c, "not_found", "not found");
}

const LINK = "/:records{companies|people|deals}/:id/meetings/:meetingId";

export const meetings = new Hono<AppEnv>()
  .get("/deals/:id/meetings", zValidator("query", crmMeetingsQuerySchema), async (c) => {
    const subject = await meetingsSubject(c, "deals", c.req.param("id"));
    if (subject.status !== "ok") return refused(c, subject);
    const { cursor, limit = PAGE } = c.req.valid("query");
    const decoded = decodeCursor(cursor, cursorSchema);
    const before = decoded ? { at: new Date(decoded.at), id: decoded.id } : null;
    const found = await meetingsOf(c, subject, before, limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      meetings: page,
      nextCursor:
        found.length > limit && last ? encodeCursor({ at: last.startedAt, id: last.id }) : null,
    } satisfies CrmMeetingsResponse);
  })
  .put(LINK, async (c) => {
    const kind = c.req.param("records") as RecordKind;
    const subject = await meetingsSubject(c, kind, c.req.param("id"));
    if (subject.status !== "ok") return refused(c, subject);
    const moved = await forMember(c.var.db, c.var.member.id).meetings.setRecord(
      c.req.param("meetingId"),
      subject.record,
    );
    if (moved.status !== "ok") return meetingRefused(c, moved.status);
    return c.body(null, 204);
  })
  .delete(LINK, async (c) => {
    const kind = c.req.param("records") as RecordKind;
    const subject = await meetingsSubject(c, kind, c.req.param("id"));
    if (subject.status !== "ok") return refused(c, subject);
    const door = forMember(c.var.db, c.var.member.id).meetings;
    const meetingId = c.req.param("meetingId");
    const found = await door.get(meetingId);
    if (found.status !== "ok") return meetingRefused(c, found.status);
    const placed = found.meeting.record;
    if (placed && (placed.kind !== subject.record.kind || placed.id !== subject.record.id)) {
      return c.body(null, 204);
    }
    const taken = await door.setRecord(meetingId, null);
    if (taken.status !== "ok") return meetingRefused(c, taken.status);
    return c.body(null, 204);
  });
