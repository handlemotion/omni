import { normalizeAddress } from "@omni/mail-core/addresses";
import {
  bookingSlots,
  bookingWindow,
  isIanaZone,
  type BookingRules,
  type BusyBlock,
} from "@omni/mail-core/calendar";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { memberMail } from "../mail.ts";
import { calendarBookingLinks, members, users } from "../schema/index.ts";
import { calendarsOf, NOT_FOUND, ownCalendarsOf, type Ex, type VisibleMailbox } from "./core.ts";
import { listEvents } from "./read.ts";
import { createOwnEvent, type InvalidEvent } from "./write.ts";

type LinkRow = typeof calendarBookingLinks.$inferSelect;

export const BOOKING_TITLE_MAX = 200;
export const BOOKING_NAME_MAX = 200;
export const BOOKING_NOTE_MAX = 2_000;

export interface BookingLinkInput {
  calendarId: string;
  title: string;
  durationMinutes: number;
  timeZone: string;
  weekdays?: number[];
  startMinute?: number;
  endMinute?: number;
  noticeMinutes?: number;
  horizonDays?: number;
}

export type BookingLinkPatch = Partial<BookingLinkInput>;

/** A booking link as its owner sees it. */
export interface BookingLinkView {
  id: string;
  slug: string;
  calendarId: string;
  title: string;
  durationMinutes: number;
  timeZone: string;
  weekdays: number[];
  startMinute: number;
  endMinute: number;
  noticeMinutes: number;
  horizonDays: number;
  createdAt: Date;
}

const viewOf = (row: LinkRow) =>
  ({
    id: row.id,
    slug: row.slug,
    calendarId: row.calendarId,
    title: row.title,
    durationMinutes: row.durationMinutes,
    timeZone: row.timeZone,
    weekdays: row.weekdays,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    noticeMinutes: row.noticeMinutes,
    horizonDays: row.horizonDays,
    createdAt: row.createdAt,
  }) satisfies BookingLinkView;

const rulesOf = (row: LinkRow) =>
  ({
    timeZone: row.timeZone,
    weekdays: row.weekdays,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    durationMinutes: row.durationMinutes,
    noticeMinutes: row.noticeMinutes,
    horizonDays: row.horizonDays,
  }) satisfies BookingRules;

const invalidAt = (field: string) => ({ status: "invalid_event", field }) satisfies InvalidEvent;

const between = (value: number | undefined, low: number, high: number) =>
  value === undefined || (Number.isInteger(value) && value >= low && value <= high);

function badShape(input: BookingLinkPatch) {
  const title = input.title;
  if (title !== undefined && (!title.trim() || title.length > BOOKING_TITLE_MAX)) return "title";
  if (!between(input.durationMinutes, 5, 480)) return "durationMinutes";
  if (input.timeZone !== undefined && !isIanaZone(input.timeZone)) return "timeZone";
  const days = input.weekdays;
  if (days && (days.length === 0 || !days.every((d) => between(d, 0, 6)))) return "weekdays";
  if (!between(input.noticeMinutes, 0, 30 * 1440)) return "noticeMinutes";
  return between(input.horizonDays, 1, 60) ? null : "horizonDays";
}

function badHours(input: BookingLinkPatch, current?: LinkRow) {
  const start = input.startMinute ?? current?.startMinute ?? 540;
  const end = input.endMinute ?? current?.endMinute ?? 1020;
  return between(start, 0, 1439) && between(end, 1, 1440) && start < end ? null : "endMinute";
}

const badLink = (input: BookingLinkPatch, current?: LinkRow) =>
  badShape(input) ?? badHours(input, current);

function newSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The member's booking links whose calendar they can still open, newest first. */
export async function memberBookingLinks(
  ex: Ex,
  memberId: string,
  mailboxes: readonly VisibleMailbox[],
) {
  const [rows, calendars] = await Promise.all([
    ex
      .select()
      .from(calendarBookingLinks)
      .where(eq(calendarBookingLinks.memberId, memberId))
      .orderBy(desc(calendarBookingLinks.createdAt)),
    calendarsOf(ex, mailboxes),
  ]);
  const open = new Set(calendars.map((c) => c.id));
  return rows.filter((row) => open.has(row.calendarId)).map(viewOf);
}

/** Makes a booking link on a calendar of an inbox the member can open. */
export async function createBookingLink(
  ex: Ex,
  memberId: string,
  mailboxes: readonly VisibleMailbox[],
  input: BookingLinkInput,
) {
  const bad = badLink(input);
  if (bad) return invalidAt(bad);
  const [calendar] = (await ownCalendarsOf(ex, mailboxes)).filter((c) => c.id === input.calendarId);
  if (!calendar) return NOT_FOUND;
  const [row] = await ex
    .insert(calendarBookingLinks)
    .values({
      ...input,
      title: input.title.trim(),
      orgId: calendar.orgId,
      memberId,
      slug: newSlug(),
    })
    .returning();
  if (!row) throw new Error("booking link insert returned nothing");
  return { status: "ok" as const, link: viewOf(row) };
}

async function ownLink(ex: Ex, memberId: string, mailboxes: readonly VisibleMailbox[], id: string) {
  const [row] = await ex
    .select()
    .from(calendarBookingLinks)
    .where(and(eq(calendarBookingLinks.id, id), eq(calendarBookingLinks.memberId, memberId)));
  if (!row) return null;
  const open = await calendarsOf(ex, mailboxes);
  return open.some((c) => c.id === row.calendarId) ? row : null;
}

/** Changes one of the member's booking links. A new calendar must be one they can open. */
export async function updateBookingLink(
  ex: Ex,
  memberId: string,
  mailboxes: readonly VisibleMailbox[],
  id: string,
  patch: BookingLinkPatch,
) {
  const row = await ownLink(ex, memberId, mailboxes, id);
  if (!row) return NOT_FOUND;
  const bad = badLink(patch, row);
  if (bad) return invalidAt(bad);
  const calendar = patch.calendarId
    ? (await ownCalendarsOf(ex, mailboxes)).find((c) => c.id === patch.calendarId)
    : null;
  if (patch.calendarId && (!calendar || calendar.orgId !== row.orgId)) return NOT_FOUND;
  const [updated] = await ex
    .update(calendarBookingLinks)
    .set({ ...patch, ...(patch.title !== undefined ? { title: patch.title.trim() } : {}) })
    .where(eq(calendarBookingLinks.id, row.id))
    .returning();
  return updated ? { status: "ok" as const, link: viewOf(updated) } : NOT_FOUND;
}

/** Deletes one of the member's booking links: its page answers `404` from then on. */
export async function deleteBookingLink(ex: Ex, memberId: string, id: string) {
  const deleted = await ex
    .delete(calendarBookingLinks)
    .where(and(eq(calendarBookingLinks.id, id), eq(calendarBookingLinks.memberId, memberId)))
    .returning({ id: calendarBookingLinks.id });
  return deleted.length > 0 ? { status: "ok" as const } : NOT_FOUND;
}

/** The workspace a booking link belongs to, or null when there is no such link. */
export async function bookingLinkOrg(ex: Ex, slug: string) {
  const [row] = await ex
    .select({ orgId: calendarBookingLinks.orgId })
    .from(calendarBookingLinks)
    .where(eq(calendarBookingLinks.slug, slug));
  return row?.orgId ?? null;
}

async function linkBySlug(ex: Ex, db: Db, slug: string) {
  const [found] = await ex
    .select({ link: calendarBookingLinks, ownerName: users.name })
    .from(calendarBookingLinks)
    .innerJoin(members, eq(members.id, calendarBookingLinks.memberId))
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(calendarBookingLinks.slug, slug));
  if (!found) return null;
  const mailboxes = (await memberMail(db, found.link.memberId).listMailboxes()).map((m) => ({
    ...m,
    address: normalizeAddress(m.address),
  }));
  const [calendar] = (await calendarsOf(ex, mailboxes)).filter(
    (c) => c.id === found.link.calendarId && c.orgId === found.link.orgId,
  );
  return calendar ? { ...found, mailboxes, calendar } : null;
}

async function busyOf(ex: Ex, mailboxes: readonly VisibleMailbox[], from: Date, to: Date) {
  const listed = await listEvents(ex, mailboxes, { from, to });
  if (listed.status !== "ok") return [];
  return listed.events
    .filter((e) => e.busy && e.status !== "cancelled" && e.myResponse !== "declined")
    .map((e) => ({ start: e.start, end: e.end }) satisfies BusyBlock);
}

/**
 * A booking link's public page: its title, length, owner's name and the slots left, and nothing
 * of what fills the rest. `not_found` once the link is deleted or its calendar is not its owner's.
 */
export async function bookingPage(db: Db, slug: string, now = new Date()) {
  const found = await linkBySlug(db, db, slug);
  if (!found) return NOT_FOUND;
  const rules = rulesOf(found.link);
  const window = bookingWindow(rules, now);
  const busy = await busyOf(db, found.mailboxes, window.from, window.to);
  return {
    status: "ok" as const,
    page: {
      title: found.link.title,
      ownerName: found.ownerName,
      durationMinutes: found.link.durationMinutes,
      timeZone: found.link.timeZone,
      slots: bookingSlots(rules, busy, now),
    },
  };
}

export interface BookingInput {
  start: Date;
  name: string;
  email: string;
  note?: string | null;
  /** The visitor's zone, for the words of their invitation. */
  timeZone?: string | null;
}

const isAddress = (email: string) => {
  const [local, domain, ...rest] = email.split("@");
  if (rest.length > 0 || !local || !domain || email.length > 320 || /\s/.test(email)) return false;
  const labels = domain.split(".");
  return labels.length > 1 && labels.every(Boolean);
};

async function lockCalendars(tx: Ex, mailboxes: readonly VisibleMailbox[]) {
  const ids = (await calendarsOf(tx, mailboxes)).map((c) => c.id).toSorted();
  for (const id of ids) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`booking:${id}`}))`);
  }
}

export type SlotTaken = { status: "slot_taken" };

/**
 * Books a slot: the event lands on the link's calendar, made by its owner, and the visitor is
 * invited by mail from that inbox. Bookings that share a calendar run one at a time and each checks
 * its slot is still free, so two visitors never get the same time and a retry is refused once the
 * first one landed.
 */
export async function bookSlot(
  db: Db,
  slug: string,
  input: BookingInput,
  requestId: string | null,
  now = new Date(),
) {
  const name = input.name.trim();
  if (!name || name.length > BOOKING_NAME_MAX) return invalidAt("name");
  if ((input.note?.length ?? 0) > BOOKING_NOTE_MAX) return invalidAt("note");
  if (!isAddress(input.email.trim())) return invalidAt("email");
  const zone = input.timeZone && isIanaZone(input.timeZone) ? input.timeZone : null;
  return db.transaction(async (tx) => {
    const found = await linkBySlug(tx, db, slug);
    if (!found) return NOT_FOUND;
    await lockCalendars(tx, found.mailboxes);
    const rules = rulesOf(found.link);
    const window = bookingWindow(rules, now);
    const busy = await busyOf(tx, found.mailboxes, window.from, window.to);
    const free = bookingSlots(rules, busy, now).some((s) => s.getTime() === input.start.getTime());
    if (!free) return { status: "slot_taken" } satisfies SlotTaken;
    const end = new Date(input.start.getTime() + rules.durationMinutes * 60_000);
    const made = await createOwnEvent(
      tx,
      { memberId: found.link.memberId, requestId, mailboxes: found.mailboxes },
      {
        calendarId: found.calendar.id,
        title: `${found.link.title} (${name})`,
        start: input.start,
        end,
        timeZone: zone ?? found.link.timeZone,
        description: input.note?.trim() || null,
        guests: [{ address: input.email.trim(), name }],
      },
    );
    if (made.status !== "ok") return made;
    return {
      status: "ok" as const,
      eventId: made.eventId,
      calendarId: found.calendar.id,
      mailboxId: found.calendar.mailboxId,
      start: input.start,
      end,
    };
  });
}
