import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readGoogleCalendars,
  readGoogleEvent,
  type GoogleCalendarChange,
} from "@omni/mail-core/calendar";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, test } from "vitest";
import {
  applyGoogleChanges,
  claimGoogleCalendars,
  saveGoogleCalendarList,
} from "../src/calendar.ts";
import { calendarOf } from "../src/calendar/core.ts";
import { forMember } from "../src/for-member.ts";
import { calendarCalendars, calendarEvents, mailboxes } from "../src/schema/index.ts";
import { createMailbox, createMember, createOrg, createTestDatabase, grant } from "./support.ts";

const { db, teardown } = await createTestDatabase();
afterAll(teardown);

const fixtures = join(import.meta.dirname, "../../../fixtures/google-calendar");
const read = <T>(name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8")) as T;
type Page = { timeZone: string; items: Record<string, unknown>[] };
const list = read<{ items: Record<string, unknown>[] }>("calendar-list.json");
const primaryPage = read<Page>("events-page.json");
const teamPage = read<Page>("events-team.json");
const holidayPage = read<Page>("events-holidays.json");

const TEAM = "c_0f3a9d2b7e41c6a8@group.calendar.google.com";
const HOLIDAYS = "es.mexican#holiday@group.v.calendar.google.com";
const KICKOFF = "3k9a7v1q2b5c8d0e4f6g";
const NOV = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-12-31T00:00:00Z") };

const changes = (page: Page, items = page.items) =>
  items
    .map((item) => readGoogleEvent(item, page.timeZone))
    .filter((change): change is GoogleCalendarChange => change !== null);

const listed = (without: readonly string[] = []) =>
  readGoogleCalendars(list.items.filter((item) => !without.includes(String(item.id))));

async function gmailInbox(slug: string) {
  const org = await createOrg(db, `${slug}-${crypto.randomUUID().slice(0, 8)}`);
  const rodrigo = await createMember(db, org.id, "rodrigo");
  const box = await createMailbox(db, org.id, "rodrigo@studio.example");
  await db
    .update(mailboxes)
    .set({ provider: "gmail", kind: "personal" })
    .where(eq(mailboxes.id, box.id));
  await grant(db, org.id, box.id, rodrigo.id);
  const own = { id: await calendarOf(db, box), orgId: org.id };
  return { org, rodrigo, box, own, door: forMember(db, rodrigo.id).calendar };
}

async function calendarIdOf(mailboxId: string, googleId: string) {
  const [row] = await db
    .select({ id: calendarCalendars.id, orgId: calendarCalendars.orgId })
    .from(calendarCalendars)
    .where(
      and(eq(calendarCalendars.mailboxId, mailboxId), eq(calendarCalendars.googleId, googleId)),
    );
  if (!row) throw new Error(`no calendar ${googleId} on ${mailboxId}`);
  return row;
}

async function shownOn(door: ReturnType<typeof forMember>["calendar"], calendarId: string) {
  const found = await door.events({ ...NOV, calendarIds: [calendarId] });
  if (found.status !== "ok") throw new Error(found.status);
  return found.events.map((e) => `${e.start.toISOString()} ${e.title}`);
}

describe("a Gmail inbox's Google calendar list", () => {
  test("adds the account's other calendars under its inbox, named and coloured by Google, the primary staying the inbox's own, and saving it again adds nothing", async () => {
    const { box, own, door } = await gmailInbox("list-add");
    expect(await saveGoogleCalendarList(db, box, listed())).toEqual({
      added: 3,
      retired: [],
      updated: true,
    });
    const view = (await door.calendars()).map(({ name, readOnly, color, address }) => ({
      address,
      name,
      readOnly,
      color,
    }));
    expect(view).toEqual([
      { address: "rodrigo@studio.example", name: null, readOnly: false, color: "#9fe1e7" },
      { address: "rodrigo@studio.example", name: "Family", readOnly: true, color: "#ac725e" },
      {
        address: "rodrigo@studio.example",
        name: "Holidays in Mexico",
        readOnly: true,
        color: "#16a765",
      },
      { address: "rodrigo@studio.example", name: "Studio team", readOnly: true, color: "#fa573c" },
    ]);
    expect((await door.calendars())[0]?.id).toBe(own.id);
    expect(await saveGoogleCalendarList(db, box, listed())).toEqual({
      added: 0,
      retired: [],
      updated: false,
    });
    expect(await door.calendars()).toHaveLength(4);
  });

  test("a colour the member picked wins over Google's, and a calendar renamed or recoloured in Google changes in Omni and says so", async () => {
    const { box, door } = await gmailInbox("list-rename");
    await saveGoogleCalendarList(db, box, listed());
    const team = await calendarIdOf(box.id, TEAM);
    await door.setPrefs(team.id, { color: "#123456" });
    const renamed = listed().map((c) =>
      c.googleId === TEAM ? { ...c, name: "Studio crew", color: "#000000" } : c,
    );
    expect(await saveGoogleCalendarList(db, box, renamed)).toEqual({
      added: 0,
      retired: [],
      updated: true,
    });
    const recoloured = renamed.map((c) => (c.primary ? { ...c, color: "#ffffff" } : c));
    expect((await saveGoogleCalendarList(db, box, recoloured)).updated).toBe(true);
    expect((await saveGoogleCalendarList(db, box, recoloured)).updated).toBe(false);
    expect((await door.calendars()).find((c) => c.id === team.id)).toMatchObject({
      name: "Studio crew",
      color: "#123456",
    });
  });

  test("a calendar the list no longer has goes with its events, and the others keep theirs", async () => {
    const { box, own, door } = await gmailInbox("list-retire");
    await saveGoogleCalendarList(db, box, listed());
    const team = await calendarIdOf(box.id, TEAM);
    const holidays = await calendarIdOf(box.id, HOLIDAYS);
    await applyGoogleChanges(db, own, changes(primaryPage));
    await applyGoogleChanges(db, team, changes(teamPage));
    await applyGoogleChanges(db, holidays, changes(holidayPage));
    expect(await shownOn(door, team.id)).toContain("2026-11-25T09:00:00.000Z Lookbook shoot");

    const saved = await saveGoogleCalendarList(db, box, listed([TEAM]));
    expect(saved).toEqual({ added: 0, retired: [team.id], updated: false });
    expect((await door.calendars()).map((c) => c.name)).toEqual([
      null,
      "Family",
      "Holidays in Mexico",
    ]);
    expect(
      await db.select().from(calendarEvents).where(eq(calendarEvents.calendarId, team.id)),
    ).toEqual([]);
    expect(await shownOn(door, holidays.id)).toEqual([
      "2026-11-02T00:00:00.000Z All Souls' Day",
      "2026-11-16T00:00:00.000Z Revolution Day Holiday",
    ]);
    expect(await shownOn(door, own.id)).toContain(
      "2026-11-24T15:30:00.000Z Acme × Studio: kickoff",
    );
  });

  test("a list without the primary, or an empty one, never retires the inbox's own calendar", async () => {
    const { box, own, door } = await gmailInbox("list-empty");
    await saveGoogleCalendarList(db, box, listed());
    await saveGoogleCalendarList(db, box, []);
    expect((await door.calendars()).map((c) => c.id)).toEqual([own.id]);
  });

  test("an event deleted on one calendar stays on another that has the same meeting", async () => {
    const { box, own, door } = await gmailInbox("list-cancel");
    await saveGoogleCalendarList(db, box, listed());
    const team = await calendarIdOf(box.id, TEAM);
    await applyGoogleChanges(db, own, changes(primaryPage));
    await applyGoogleChanges(db, team, changes(teamPage));
    await applyGoogleChanges(db, team, changes(teamPage, [{ id: KICKOFF, status: "cancelled" }]));
    expect(await shownOn(door, team.id)).toEqual(["2026-11-25T09:00:00.000Z Lookbook shoot"]);
    expect(await shownOn(door, own.id)).toContain(
      "2026-11-24T15:30:00.000Z Acme × Studio: kickoff",
    );
  });

  test("nothing Omni makes lands on a Google calendar", async () => {
    const { box, own, door } = await gmailInbox("list-readonly");
    await saveGoogleCalendarList(db, box, listed());
    const team = await calendarIdOf(box.id, TEAM);
    const event = {
      title: "Planning",
      start: new Date("2026-11-27T10:00:00Z"),
      end: new Date("2026-11-27T11:00:00Z"),
    };
    expect(await door.createEvent({ ...event, calendarId: team.id })).toEqual({
      status: "not_found",
    });
    const link = { title: "Intro", durationMinutes: 30, timeZone: "Europe/Madrid" };
    expect(await door.createBookingLink({ ...link, calendarId: team.id })).toEqual({
      status: "not_found",
    });
    expect((await door.createEvent({ ...event, calendarId: own.id })).status).toBe("ok");
  });

  test("each calendar of the inbox is claimed for its own sync, with the Google calendar it reads", async () => {
    const { box, own } = await gmailInbox("list-claim");
    await saveGoogleCalendarList(db, box, listed());
    const claims = await claimGoogleCalendars(db, [box], { now: new Date() });
    expect(claims.map((c) => c.googleId ?? "own").toSorted()).toEqual(
      ["own", TEAM, HOLIDAYS, "ruiz.family.4x2@gmail.example"].toSorted(),
    );
    expect(claims.find((c) => c.googleId === null)?.calendarId).toBe(own.id);
  });
});
