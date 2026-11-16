// Notes on one record, and the CRM side of a record's timeline: its events and its notes, each
// paged newest first. Mail joins the timeline in a later layer, merged by the Worker.
import { and, desc, eq, sql } from "drizzle-orm";
import { crmEvents, crmNotes } from "../schema/crm.ts";
import {
  FORBIDDEN,
  NOT_FOUND,
  pageSize,
  type CrmMember,
  type CrmRecordRef,
  type Ex,
  type Forbidden,
  type NotFound,
} from "./core.ts";
import { loadCompany, loadDeal, loadPerson } from "./records.ts";

export interface CrmNote {
  id: string;
  companyId: string | null;
  personId: string | null;
  dealId: string | null;
  body: string;
  /** Null once the author has left the workspace. */
  authorMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrmEvent {
  id: string;
  companyId: string | null;
  personId: string | null;
  dealId: string | null;
  kind: string;
  actorMemberId: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

/** A timeline page's position: the last item's time and id. */
export interface CrmTimelineCursor {
  createdAt: Date;
  id: string;
}

export type InvalidBody = { status: "invalid_body" };
export type NoteResult = { status: "ok"; note: CrmNote } | NotFound | Forbidden | InvalidBody;

export const CRM_NOTE_MAX_LENGTH = 20_000;

const noteColumns = {
  id: crmNotes.id,
  companyId: crmNotes.companyId,
  personId: crmNotes.personId,
  dealId: crmNotes.dealId,
  body: crmNotes.body,
  authorMemberId: crmNotes.authorMemberId,
  createdAt: crmNotes.createdAt,
  updatedAt: crmNotes.updatedAt,
};

const eventColumns = {
  id: crmEvents.id,
  companyId: crmEvents.companyId,
  personId: crmEvents.personId,
  dealId: crmEvents.dealId,
  kind: crmEvents.kind,
  actorMemberId: crmEvents.actorMemberId,
  data: crmEvents.data,
  createdAt: crmEvents.createdAt,
};

/** Whether the record is the member's workspace's, archived or not. */
export async function recordExists(ex: Ex, orgId: string, record: CrmRecordRef) {
  if ("companyId" in record) return Boolean(await loadCompany(ex, orgId, record.companyId));
  if ("personId" in record) return Boolean(await loadPerson(ex, orgId, record.personId));
  return Boolean(await loadDeal(ex, orgId, record.dealId));
}

const cleanBody = (body: string) => {
  const text = body.trim();
  return text.length > 0 && text.length <= CRM_NOTE_MAX_LENGTH ? text : null;
};

/** Exactly one record, as the check constraint wants it. */
const target = (record: CrmRecordRef) => ({
  companyId: "companyId" in record ? record.companyId : null,
  personId: "personId" in record ? record.personId : null,
  dealId: "dealId" in record ? record.dealId : null,
});

export async function createNote(
  tx: Ex,
  member: CrmMember,
  input: { record: CrmRecordRef; body: string },
): Promise<NoteResult> {
  const body = cleanBody(input.body);
  if (!body) return { status: "invalid_body" };
  if (!(await recordExists(tx, member.orgId, input.record))) return NOT_FOUND;
  const [note] = await tx
    .insert(crmNotes)
    .values({ orgId: member.orgId, ...target(input.record), body, authorMemberId: member.id })
    .returning(noteColumns);
  return { status: "ok", note: note! };
}

async function ownNote(tx: Ex, member: CrmMember, id: string) {
  const [note] = await tx
    .select(noteColumns)
    .from(crmNotes)
    .where(and(eq(crmNotes.orgId, member.orgId), eq(crmNotes.id, id)))
    .for("update");
  if (!note) return NOT_FOUND;
  return note.authorMemberId === member.id ? note : FORBIDDEN;
}

/** Only its author edits a note. */
export async function updateNote(
  tx: Ex,
  member: CrmMember,
  id: string,
  input: { body: string },
): Promise<NoteResult> {
  const body = cleanBody(input.body);
  if (!body) return { status: "invalid_body" };
  const note = await ownNote(tx, member, id);
  if ("status" in note) return note;
  const [updated] = await tx
    .update(crmNotes)
    .set({ body })
    .where(eq(crmNotes.id, id))
    .returning(noteColumns);
  return { status: "ok", note: updated! };
}

/** Only its author deletes a note. */
export async function deleteNote(
  tx: Ex,
  member: CrmMember,
  id: string,
): Promise<{ status: "ok" } | NotFound | Forbidden> {
  const note = await ownNote(tx, member, id);
  if ("status" in note) return note;
  await tx.delete(crmNotes).where(eq(crmNotes.id, id));
  return { status: "ok" };
}

export interface TimelinePage {
  cursor?: CrmTimelineCursor | null;
  limit?: number;
}

type Table = typeof crmNotes | typeof crmEvents;

/** The record's column in `table`, and the rows older than the cursor. */
function timelineWhere(
  table: Table,
  orgId: string,
  record: CrmRecordRef,
  cursor?: CrmTimelineCursor | null,
) {
  const column =
    "companyId" in record
      ? eq(table.companyId, record.companyId)
      : "personId" in record
        ? eq(table.personId, record.personId)
        : eq(table.dealId, record.dealId);
  const older = cursor
    ? sql`(${table.createdAt}, ${table.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id})`
    : undefined;
  return and(eq(table.orgId, orgId), column, older);
}

function cut<T extends { createdAt: Date; id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
}

export type TimelineResult<T> =
  | { status: "ok"; items: T[]; nextCursor: CrmTimelineCursor | null }
  | NotFound;

/** The record's events, newest first. */
export async function eventsOf(
  ex: Ex,
  member: CrmMember,
  record: CrmRecordRef,
  page: TimelinePage = {},
): Promise<TimelineResult<CrmEvent>> {
  if (!(await recordExists(ex, member.orgId, record))) return NOT_FOUND;
  const limit = pageSize(page.limit);
  const rows = await ex
    .select(eventColumns)
    .from(crmEvents)
    .where(timelineWhere(crmEvents, member.orgId, record, page.cursor))
    .orderBy(desc(crmEvents.createdAt), desc(crmEvents.id))
    .limit(limit + 1);
  return { status: "ok", ...cut(rows, limit) };
}

/** The record's notes, newest first. */
export async function notesOf(
  ex: Ex,
  member: CrmMember,
  record: CrmRecordRef,
  page: TimelinePage = {},
): Promise<TimelineResult<CrmNote>> {
  if (!(await recordExists(ex, member.orgId, record))) return NOT_FOUND;
  const limit = pageSize(page.limit);
  const rows = await ex
    .select(noteColumns)
    .from(crmNotes)
    .where(timelineWhere(crmNotes, member.orgId, record, page.cursor))
    .orderBy(desc(crmNotes.createdAt), desc(crmNotes.id))
    .limit(limit + 1);
  return { status: "ok", ...cut(rows, limit) };
}
