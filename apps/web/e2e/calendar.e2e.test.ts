import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseCalendar } from "@omni/mail-core/calendar";
import { applyCalendarPart, calendarArrivals, forMember, schema } from "@omni/db";
import { and, eq } from "drizzle-orm";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

const invite = readFileSync(
  join(import.meta.dirname, "../../../fixtures/ics/google-invite.ics"),
  "utf8",
);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, RATE_LIMIT_AUTH: "off" },
  });
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

async function invited() {
  const org = await createOrg(db, "studio");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const address = `rodrigo-${Date.now()}@studio.example`;
  const member = await createMember(db, org.id, address);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const inbox = await createMailbox(db, org.id, address, "personal");
  await grant(db, org.id, inbox.id, member.id);
  const ics = invite
    .replaceAll("rodrigo@studio.example", address)
    .replace("Rodrigo@Studio.example", address);
  const seeded = await seedMessage(db, inbox, {
    subject: "Invitation: Acme × Studio: kickoff",
    fromAddress: "ana@acme.example",
    uid: 1,
    sentAt: new Date("2026-11-20T09:15:03Z"),
  });
  await db.insert(schema.attachments).values({
    orgId: org.id,
    messageId: seeded.messageId,
    filename: "invite.ics",
    mimeType: "text/calendar",
    size: ics.length,
    r2Key: `${org.id}/${inbox.id}/att/invite`,
  });
  const [part] = await calendarArrivals(db, [seeded.messageId]);
  if (!part) throw new Error("no calendar part");
  expect(await applyCalendarPart(db, part, parseCalendar(ics))).toMatchObject({
    status: "applied",
  });
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, address);
  const context = await browser.newContext({
    timezoneId: "Europe/Madrid",
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  return {
    org,
    member,
    address,
    inbox,
    threadId: seeded.threadId,
    page: await context.newPage(),
    origin,
  };
}

const answerOf = (address: string) =>
  db
    .select({ response: schema.calendarAttendees.response })
    .from(schema.calendarAttendees)
    .where(eq(schema.calendarAttendees.address, address));

const replies = (mailboxId: string) =>
  db
    .select({ payload: schema.mailActions.payload })
    .from(schema.mailActions)
    .where(and(eq(schema.mailActions.mailboxId, mailboxId), eq(schema.mailActions.kind, "send")));

const ownEvents = (orgId: string) =>
  db
    .select({ title: schema.calendarEvents.title, startsAt: schema.calendarEvents.startsAt })
    .from(schema.calendarEvents)
    .where(and(eq(schema.calendarEvents.orgId, orgId), eq(schema.calendarEvents.source, "omni")));

async function openWeek(page: Page, origin: string, slug: string) {
  await page.goto(new URL(`/${slug}/calendar?date=2026-11-24&view=week`, origin).toString());
  await page.getByRole("button", { name: /Acme × Studio: kickoff/ }).waitFor();
}

test("an invitation on the week is answered by key, and its answer goes to the organizer", async () => {
  const { org, address, inbox, page, origin } = await invited();
  await openWeek(page, origin, org.slug);
  const kickoff = page.getByRole("button", { name: /Acme × Studio: kickoff/ });
  await expect.poll(() => kickoff.textContent()).toMatch(/4:30\s?PM|16:30/);

  await kickoff.click();
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Acme × Studio: kickoff" }).waitFor();
  await page.keyboard.press("y");
  await expect
    .poll(async () => (await answerOf(address)).map((a) => a.response))
    .toContain("accepted");
  await expect
    .poll(async () =>
      (await replies(inbox.id)).map((r) => (r.payload as { subject: string }).subject),
    )
    .toEqual(["Accepted: Acme × Studio: kickoff"]);
  await expect
    .poll(() => page.getByRole("button", { name: "Yes" }).getAttribute("aria-pressed"))
    .toBe("true");
});

test("c makes an event at the selected slot, and quick arrows add up: four move it an hour", async () => {
  const { org, page, origin } = await invited();
  await openWeek(page, origin, org.slug);
  await page.locator('[data-day="2026-11-24"]').click({ position: { x: 20, y: 10 * 48 + 6 } });
  await page.keyboard.press("c");
  const title = page.getByRole("textbox", { name: "Title" });
  await title.waitFor();
  await title.fill("Focus block");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await ownEvents(org.id)).map((e) => e.title))
    .toEqual(["Focus block"]);
  const [made] = await ownEvents(org.id);
  expect(made?.startsAt).toEqual(new Date("2026-11-24T09:00:00Z"));

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Focus block/ }).click();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => (await ownEvents(org.id))[0]?.startsAt.getTime())
    .toBe((made?.startsAt.getTime() ?? 0) + 60 * 60_000);
});

test("the thread shows the invitation with Yes, No and Maybe, and No answers it", async () => {
  const { org, address, inbox, threadId, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/mail/all/${threadId}`, origin).toString());
  const card = page.getByRole("group", { name: "Invitation: Acme × Studio: kickoff" });
  await card.waitFor();
  await card.getByRole("button", { name: "No" }).click();
  await expect
    .poll(async () => (await answerOf(address)).map((a) => a.response))
    .toContain("declined");
  await expect
    .poll(async () =>
      (await replies(inbox.id)).map((r) => (r.payload as { subject: string }).subject),
    )
    .toEqual(["Declined: Acme × Studio: kickoff"]);
});

test("a to-do added from a section's + is the member's, and checking a dated one on its day completes it", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Send the brief",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
    dueAt: new Date("2026-11-25T22:59:59Z"),
  });
  await openWeek(page, origin, org.slug);

  await page.getByRole("region", { name: "No date" }).hover();
  await page.getByRole("button", { name: "New to-do in No date" }).click();
  const field = page.getByRole("textbox", { name: "New to-do" });
  await field.fill("Book the room");
  await field.press("Enter");
  await expect
    .poll(async () =>
      (
        await db
          .select({
            title: schema.calendarTasks.title,
            assignee: schema.calendarTasks.assigneeMemberId,
          })
          .from(schema.calendarTasks)
          .where(eq(schema.calendarTasks.title, "Book the room"))
      ).map((t) => t.assignee),
    )
    .toEqual([member.id]);

  await page
    .locator('[data-all-day="2026-11-25"]')
    .locator('[data-slot="indicator"]')
    .first()
    .click();
  await expect
    .poll(async () =>
      (
        await db
          .select({ done: schema.calendarTasks.completedAt })
          .from(schema.calendarTasks)
          .where(eq(schema.calendarTasks.title, "Send the brief"))
      ).map((t) => t.done !== null),
    )
    .toEqual([true]);
});

test("a day picked in the month shows its week", async () => {
  const { org, page, origin } = await invited();
  await openWeek(page, origin, org.slug);
  await page.getByRole("grid", { name: /Month/ }).getByText("3", { exact: true }).first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get("date")).toBe("2026-11-03");
  await page.getByRole("heading", { name: /W45/ }).waitFor();
});

test("an event made elsewhere shows on the open week without a reload", async () => {
  const { org, page, origin } = await invited();
  const [calendar] = await db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.orgId, org.id));
  await openWeek(page, origin, org.slug);
  const made = await page.request.post(new URL("/api/calendar/events", origin).toString(), {
    data: {
      calendarId: calendar?.id,
      title: "Live standup",
      start: "2026-11-24T09:00:00.000Z",
      end: "2026-11-24T09:30:00.000Z",
      allDay: false,
      timeZone: "Europe/Madrid",
      guests: [],
    },
  });
  expect(made.status()).toBe(201);
  await page.getByRole("button", { name: /Live standup/ }).waitFor({ timeout: 10_000 });
});

test("editing an overnight event keeps its end on the next day", async () => {
  const { org, page, origin } = await invited();
  const [calendar] = await db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.orgId, org.id));
  await page.goto(origin);
  const made = await page.request.post(new URL("/api/calendar/events", origin).toString(), {
    data: {
      calendarId: calendar?.id,
      title: "Night shift",
      start: "2026-11-24T22:00:00.000Z",
      end: "2026-11-25T00:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Madrid",
      guests: [],
    },
  });
  expect(made.status()).toBe(201);
  await openWeek(page, origin, org.slug);
  await page
    .getByRole("button", { name: /Night shift/ })
    .first()
    .click();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Edit" }).click();
  const title = page.getByRole("textbox", { name: "Title" });
  await title.fill("Night shift (cover)");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await ownEvents(org.id)).map((e) => [e.title, e.startsAt.toISOString()]))
    .toEqual([["Night shift (cover)", "2026-11-24T22:00:00.000Z"]]);
  const [row] = await db
    .select({ endsAt: schema.calendarEvents.endsAt })
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.orgId, org.id),
        eq(schema.calendarEvents.title, "Night shift (cover)"),
      ),
    );
  expect(row?.endsAt).toEqual(new Date("2026-11-25T00:00:00.000Z"));
});

test("a to-do past the first hundred still sits on its day", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values([
    ...Array.from({ length: 101 }, (_, i) => ({
      orgId: org.id,
      title: `Old ${i}`,
      ownerMemberId: member.id,
      assigneeMemberId: member.id,
      dueAt: new Date(Date.UTC(2026, 9, 1, 12, i)),
    })),
    {
      orgId: org.id,
      title: "Send the brief",
      ownerMemberId: member.id,
      assigneeMemberId: member.id,
      dueAt: new Date("2026-11-25T22:59:59Z"),
    },
  ]);
  await openWeek(page, origin, org.slug);
  await expect
    .poll(() => page.locator('[data-all-day="2026-11-25"]').getByText("Send the brief").count())
    .toBe(1);
});

test("arrows leave an all-day event's days alone", async () => {
  const { org, page, origin } = await invited();
  const [calendar] = await db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.orgId, org.id));
  await page.goto(origin);
  const made = await page.request.post(new URL("/api/calendar/events", origin).toString(), {
    data: {
      calendarId: calendar?.id,
      title: "Offsite",
      start: "2026-11-23T00:00:00.000Z",
      end: "2026-11-24T00:00:00.000Z",
      allDay: true,
      timeZone: "Europe/Madrid",
      guests: [],
    },
  });
  expect(made.status()).toBe(201);
  await openWeek(page, origin, org.slug);
  await page.getByRole("button", { name: "Offsite" }).click();
  await page.keyboard.press("Shift+ArrowUp");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("t");
  await page.waitForLoadState("networkidle");
  const [row] = await db
    .select({ startsAt: schema.calendarEvents.startsAt, endsAt: schema.calendarEvents.endsAt })
    .from(schema.calendarEvents)
    .where(
      and(eq(schema.calendarEvents.orgId, org.id), eq(schema.calendarEvents.title, "Offsite")),
    );
  expect([row?.startsAt.toISOString(), row?.endsAt.toISOString()]).toEqual([
    "2026-11-23T00:00:00.000Z",
    "2026-11-24T00:00:00.000Z",
  ]);
});

test("the switcher at the sidebar's foot shows one inbox's calendar alone", async () => {
  const { org, member, page, origin } = await invited();
  const shared = await createMailbox(db, org.id, `team-${Date.now()}@studio.example`, "shared");
  await grant(db, org.id, shared.id, member.id);
  await db.insert(schema.calendarCalendars).values({ orgId: org.id, mailboxId: shared.id });
  await openWeek(page, origin, org.slug);
  await page.getByRole("button", { name: /Switch calendar, currently All calendars/ }).click();
  await page.getByRole("menuitem", { name: /Team/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("calendar")).not.toBeNull();
  await expect
    .poll(() => page.getByRole("button", { name: /Acme × Studio: kickoff/ }).count())
    .toBe(0);
  await page.getByRole("button", { name: /Switch calendar, currently Team/ }).click();
  await page.getByRole("menuitem", { name: "All calendars" }).click();
  await expect
    .poll(() => page.getByRole("button", { name: /Acme × Studio: kickoff/ }).count())
    .toBe(1);
});

test("double-clicking a slot opens the new event at the slot a click there selects", async () => {
  const { org, page, origin } = await invited();
  await openWeek(page, origin, org.slug);
  await page.locator('[data-day="2026-11-24"]').dblclick({ position: { x: 20, y: 10 * 48 + 2 } });
  const start = page.getByRole("textbox", { name: "Start" });
  await start.waitFor();
  expect(await start.inputValue()).toBe("10:00");
});

test("a move after an edit in another view builds on the edit", async () => {
  const { org, page, origin } = await invited();
  const [calendar] = await db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.orgId, org.id));
  await page.goto(origin);
  const made = await page.request.post(new URL("/api/calendar/events", origin).toString(), {
    data: {
      calendarId: calendar?.id,
      title: "Planning",
      start: "2026-11-24T09:00:00.000Z",
      end: "2026-11-24T10:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Madrid",
      guests: [],
    },
  });
  expect(made.status()).toBe(201);
  await openWeek(page, origin, org.slug);
  await page.getByRole("button", { name: /Planning/ }).waitFor();
  await page.keyboard.press("d");
  await page.getByRole("button", { name: /Planning/ }).click();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Start" }).fill("12:00");
  await page.getByRole("textbox", { name: "End" }).fill("13:00");
  await page.keyboard.press("Enter");
  const startOf = async () =>
    (
      await db
        .select({ startsAt: schema.calendarEvents.startsAt })
        .from(schema.calendarEvents)
        .where(
          and(eq(schema.calendarEvents.orgId, org.id), eq(schema.calendarEvents.title, "Planning")),
        )
    )[0]?.startsAt.toISOString();
  await expect.poll(startOf).toBe("2026-11-24T11:00:00.000Z");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Planning/ }).click();
  await page.keyboard.press("ArrowDown");
  await expect.poll(startOf).toBe("2026-11-24T11:15:00.000Z");
});

test("Enter opens the event that has focus, not the one selected before", async () => {
  const { org, page, origin } = await invited();
  const [calendar] = await db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.orgId, org.id));
  await page.goto(origin);
  const made = await page.request.post(new URL("/api/calendar/events", origin).toString(), {
    data: {
      calendarId: calendar?.id,
      title: "Planning",
      start: "2026-11-23T09:00:00.000Z",
      end: "2026-11-23T10:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Madrid",
      guests: [],
    },
  });
  expect(made.status()).toBe(201);
  await openWeek(page, origin, org.slug);
  await page.getByRole("button", { name: /Acme × Studio: kickoff/ }).click();
  await page.getByRole("button", { name: /Planning/ }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Planning" }).waitFor();
});

test("a new event goes on the calendar the switcher shows alone", async () => {
  const { org, member, page, origin } = await invited();
  const shared = await createMailbox(db, org.id, `team-${Date.now()}@studio.example`, "shared");
  await grant(db, org.id, shared.id, member.id);
  const [team] = await db
    .insert(schema.calendarCalendars)
    .values({ orgId: org.id, mailboxId: shared.id })
    .returning({ id: schema.calendarCalendars.id });
  await page.goto(
    new URL(
      `/${org.slug}/calendar?date=2026-11-24&view=week&calendar=${team?.id}`,
      origin,
    ).toString(),
  );
  await page.locator('[data-day="2026-11-24"]').click({ position: { x: 20, y: 10 * 48 + 6 } });
  await page.keyboard.press("c");
  await page.getByRole("textbox", { name: "Title" }).fill("Team sync");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      (
        await db
          .select({ calendarId: schema.calendarEvents.calendarId })
          .from(schema.calendarEvents)
          .where(eq(schema.calendarEvents.title, "Team sync"))
      ).map((e) => e.calendarId),
    )
    .toEqual([team?.id]);
});

test("the sidebar month's arrows step months", async () => {
  const { org, page, origin } = await invited();
  await openWeek(page, origin, org.slug);
  const next = page.getByRole("button", { name: "Next month" });
  const previous = page.getByRole("button", { name: "Previous month" });
  await next.click();
  await expect.poll(() => page.getByRole("heading", { name: "December 2026" }).count()).toBe(1);
  await previous.click();
  await previous.click();
  await expect.poll(() => page.getByRole("heading", { name: "October 2026" }).count()).toBe(1);
});

test("crumbs deepen from month to week to day, and an earlier crumb zooms out", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  await page
    .locator('[data-month-day="2026-11-24"]')
    .getByRole("button", { name: /Acme × Studio: kickoff/ })
    .waitFor();
  await page
    .locator('[data-month-day="2026-11-24"]')
    .getByRole("button", { name: /^Open / })
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("day");
  const crumbs = page.getByRole("heading", { name: /W48/ });
  expect(await crumbs.innerText()).toMatch(
    /November 2026\s*W48\s*Tue,? 24|November 2026\s*W48\s*24/,
  );
  await crumbs.getByRole("button", { name: "W48" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("week");
  await crumbs.getByRole("button", { name: "November 2026" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("month");
});

test("a to-do shows in its section the moment Enter is pressed, before the Worker answers", async () => {
  const { page, origin, org } = await invited();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/calendar/tasks", async (route) => {
    if (route.request().method() === "POST") await released;
    await route.continue().catch(() => undefined);
  });
  await openWeek(page, origin, org.slug);
  const section = page.getByRole("region", { name: "No date" });
  await section.hover();
  await page.getByRole("button", { name: "New to-do in No date" }).click();
  const field = page.getByRole("textbox", { name: "New to-do" });
  await field.fill("Water the plants");
  await field.press("Enter");

  const row = section.getByRole("link", { name: "Water the plants" });
  await expect.poll(() => row.count()).toBe(1);
  const saved = () =>
    db
      .select()
      .from(schema.calendarTasks)
      .where(eq(schema.calendarTasks.title, "Water the plants"));
  expect(await saved()).toEqual([]);
  release();
  await expect.poll(async () => (await saved()).length).toBe(1);
  const [made] = await saved();
  await expect.poll(() => row.getAttribute("href")).toContain(made?.id);
  expect(await row.count()).toBe(1);
});

test("a to-do checked off leaves the sidebar but stays on its day, crossed out", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Call the printer",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
    dueAt: new Date("2026-11-25T22:59:59Z"),
  });
  await openWeek(page, origin, org.slug);
  const inSidebar = page.getByRole("region").filter({ hasText: "Call the printer" });
  await inSidebar.waitFor();
  await inSidebar.locator('[data-slot="indicator"]').first().click();
  await expect
    .poll(async () =>
      (
        await db
          .select({ done: schema.calendarTasks.completedAt })
          .from(schema.calendarTasks)
          .where(eq(schema.calendarTasks.title, "Call the printer"))
      ).map((t) => t.done !== null),
    )
    .toEqual([true]);
  await expect
    .poll(() => page.getByRole("region").filter({ hasText: "Call the printer" }).count())
    .toBe(0);
  const onDay = page.locator('[data-all-day="2026-11-25"]').getByText("Call the printer");
  await expect
    .poll(() => onDay.evaluate((el) => getComputedStyle(el).textDecorationLine))
    .toBe("line-through");

  await page.locator('[data-day="2026-11-24"]').click({ position: { x: 20, y: 10 * 48 + 6 } });
  await page.keyboard.press("c");
  await page.getByRole("textbox", { name: "Title" }).fill("Planning");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /Planning/ }).waitFor();
  await page.waitForLoadState("networkidle");
  expect(await onDay.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe(
    "line-through",
  );
});

const dueOf = async (orgId: string, title: string) =>
  (
    await db
      .select({ dueAt: schema.calendarTasks.dueAt })
      .from(schema.calendarTasks)
      .where(and(eq(schema.calendarTasks.orgId, orgId), eq(schema.calendarTasks.title, title)))
  )[0]?.dueAt?.toISOString();

test("an event dragged to another day and hour moves there, keeping its length", async () => {
  const { org, page, origin } = await invited();
  const [calendar] = await db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.orgId, org.id));
  await page.goto(origin);
  const made = await page.request.post(new URL("/api/calendar/events", origin).toString(), {
    data: {
      calendarId: calendar?.id,
      title: "Planning",
      start: "2026-11-24T09:00:00.000Z",
      end: "2026-11-24T10:00:00.000Z",
      allDay: false,
      timeZone: "Europe/Madrid",
      guests: [],
    },
  });
  expect(made.status()).toBe(201);
  await openWeek(page, origin, org.slug);
  await page
    .getByRole("button", { name: /Planning/ })
    .dragTo(page.locator('[data-day="2026-11-25"]'), {
      sourcePosition: { x: 10, y: 4 },
      targetPosition: { x: 20, y: 14 * 48 + 4 },
    });
  const times = async () =>
    (
      await db
        .select({ startsAt: schema.calendarEvents.startsAt, endsAt: schema.calendarEvents.endsAt })
        .from(schema.calendarEvents)
        .where(
          and(eq(schema.calendarEvents.orgId, org.id), eq(schema.calendarEvents.title, "Planning")),
        )
    ).map((e) => [e.startsAt.toISOString(), e.endsAt.toISOString()]);
  await expect.poll(times).toEqual([["2026-11-25T13:00:00.000Z", "2026-11-25T14:00:00.000Z"]]);
});

test("a to-do dragged onto an hour is due then and sits there; dragged to a day, it's due that day", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Call the printer",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
  });
  await openWeek(page, origin, org.slug);
  const row = page.getByRole("region", { name: "No date" }).locator("[data-todo]").first();
  await row.waitFor();
  await row.dragTo(page.locator('[data-day="2026-11-26"]'), {
    sourcePosition: { x: 40, y: 4 },
    targetPosition: { x: 20, y: 11 * 48 + 4 },
  });
  await expect.poll(() => dueOf(org.id, "Call the printer")).toBe("2026-11-26T10:00:00.000Z");
  const block = page.locator('[data-day="2026-11-26"] [data-todo]');
  await block.waitFor();

  await block.dragTo(page.locator('[data-all-day="2026-11-27"]'), {
    sourcePosition: { x: 60, y: 10 },
  });
  await expect.poll(() => dueOf(org.id, "Call the printer")).toBe("2026-11-27T22:59:59.999Z");
  await expect.poll(() => page.locator('[data-all-day="2026-11-27"] [data-todo]').count()).toBe(1);
});

test("a to-do opens beside the calendar, not in the CRM", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Draft Q1 plan",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
  });
  await openWeek(page, origin, org.slug);
  await page
    .getByRole("region", { name: "No date" })
    .getByRole("link", { name: "Draft Q1 plan" })
    .click();
  await page.getByRole("region", { name: "Task" }).waitFor();
  expect(new URL(page.url()).pathname).toBe(`/${org.slug}/calendar`);
  expect(new URL(page.url()).searchParams.get("task")).not.toBeNull();
});

async function madeEvent(
  orgId: string,
  page: Page,
  origin: string,
  title: string,
  at: [string, string],
  allDay = false,
) {
  const [calendar] = await db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.orgId, orgId));
  await page.goto(origin);
  const made = await page.request.post(new URL("/api/calendar/events", origin).toString(), {
    data: {
      calendarId: calendar?.id,
      title,
      start: at[0],
      end: at[1],
      allDay,
      timeZone: "Europe/Madrid",
      guests: [],
    },
  });
  expect(made.status()).toBe(201);
}

const spanOf = async (orgId: string, title: string) =>
  (
    await db
      .select({
        startsAt: schema.calendarEvents.startsAt,
        endsAt: schema.calendarEvents.endsAt,
        status: schema.calendarEvents.status,
      })
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.orgId, orgId), eq(schema.calendarEvents.title, title)))
  )
    .filter((e) => e.status !== "cancelled")
    .map((e) => [e.startsAt.toISOString(), e.endsAt.toISOString()]);

test("the morning piece of an overnight event dragged an hour down moves the whole event an hour", async () => {
  const { org, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Night run", [
    "2026-11-24T22:00:00.000Z",
    "2026-11-25T00:00:00.000Z",
  ]);
  await openWeek(page, origin, org.slug);
  await page
    .locator('[data-day="2026-11-25"]')
    .getByRole("button", { name: /Night run/ })
    .dragTo(page.locator('[data-day="2026-11-25"]'), {
      sourcePosition: { x: 10, y: 4 },
      targetPosition: { x: 20, y: 48 + 4 },
    });
  await expect
    .poll(() => spanOf(org.id, "Night run"))
    .toEqual([["2026-11-24T23:00:00.000Z", "2026-11-25T01:00:00.000Z"]]);
});

test("the morning piece of a to-do due just before midnight dragged an hour down moves it an hour", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Lock the doors",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
    dueAt: new Date("2026-11-24T22:45:00.000Z"),
  });
  await openWeek(page, origin, org.slug);
  await page
    .locator('[data-day="2026-11-25"] [data-todo]')
    .dragTo(page.locator('[data-day="2026-11-25"]'), {
      sourcePosition: { x: 60, y: 4 },
      targetPosition: { x: 20, y: 48 + 4 },
    });
  await expect.poll(() => dueOf(org.id, "Lock the doors")).toBe("2026-11-24T23:45:00.000Z");
});

test("a multi-day event dragged by a later day's chip moves by the days it was dragged", async () => {
  const { org, page, origin } = await invited();
  await madeEvent(
    org.id,
    page,
    origin,
    "Conference",
    ["2026-11-23T00:00:00.000Z", "2026-11-27T00:00:00.000Z"],
    true,
  );
  await openWeek(page, origin, org.slug);
  await page
    .locator('[data-all-day="2026-11-24"]')
    .getByRole("button", { name: "Conference" })
    .dragTo(page.locator('[data-all-day="2026-11-25"]'), { sourcePosition: { x: 10, y: 4 } });
  await expect
    .poll(() => spanOf(org.id, "Conference"))
    .toEqual([["2026-11-24T00:00:00.000Z", "2026-11-28T00:00:00.000Z"]]);
});

test("keys on a to-do in the grid act on the to-do, not the selected event", async () => {
  const { org, member, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Deep work", [
    "2026-11-24T09:00:00.000Z",
    "2026-11-24T10:00:00.000Z",
  ]);
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "File expenses",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
    dueAt: new Date("2026-11-24T22:59:59.999Z"),
  });
  await openWeek(page, origin, org.slug);
  await page.getByRole("button", { name: /Deep work/ }).click();
  await page
    .locator('[data-all-day="2026-11-24"]')
    .getByRole("button", { name: "File expenses" })
    .focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Task" }).waitFor();
  expect(await spanOf(org.id, "Deep work")).toEqual([
    ["2026-11-24T09:00:00.000Z", "2026-11-24T10:00:00.000Z"],
  ]);
  expect(await page.getByRole("button", { name: "Edit" }).count()).toBe(0);
});

test("the morning piece of an overnight event dropped on the next day's row moves it one day", async () => {
  const { org, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Late deploy", [
    "2026-11-24T22:00:00.000Z",
    "2026-11-25T00:00:00.000Z",
  ]);
  await openWeek(page, origin, org.slug);
  await page
    .locator('[data-day="2026-11-25"]')
    .getByRole("button", { name: /Late deploy/ })
    .dragTo(page.locator('[data-all-day="2026-11-26"]'), {
      sourcePosition: { x: 10, y: 4 },
    });
  await expect
    .poll(() => spanOf(org.id, "Late deploy"))
    .toEqual([["2026-11-25T22:00:00.000Z", "2026-11-26T00:00:00.000Z"]]);
});

test("the morning piece of an event that crossed a clock change moves by what it was dragged", async () => {
  const { org, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Spring retreat", [
    "2026-03-28T23:30:00.000Z",
    "2026-03-29T23:00:00.000Z",
  ]);
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-03-30&view=week`, origin).toString());
  await page
    .locator('[data-day="2026-03-30"]')
    .getByRole("button", { name: /Spring retreat/ })
    .dragTo(page.locator('[data-day="2026-03-30"]'), {
      sourcePosition: { x: 10, y: 4 },
      targetPosition: { x: 20, y: 48 + 4 },
    });
  await expect
    .poll(() => spanOf(org.id, "Spring retreat"))
    .toEqual([["2026-03-29T00:30:00.000Z", "2026-03-30T00:00:00.000Z"]]);
});

test("an all-day event moved twice before the first save lands where it was dropped last", async () => {
  const { org, page, origin } = await invited();
  await madeEvent(
    org.id,
    page,
    origin,
    "Holiday",
    ["2026-11-23T00:00:00.000Z", "2026-11-24T00:00:00.000Z"],
    true,
  );
  await openWeek(page, origin, org.slug);
  await page.route("**/api/calendar/events/*", async (route) => {
    if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const chip = (day: string) =>
    page.locator(`[data-all-day="${day}"]`).getByRole("button", { name: "Holiday" });
  await chip("2026-11-23").dragTo(page.locator('[data-all-day="2026-11-24"]'), {
    sourcePosition: { x: 10, y: 4 },
  });
  await chip("2026-11-24").dragTo(page.locator('[data-all-day="2026-11-25"]'), {
    sourcePosition: { x: 10, y: 4 },
    timeout: 1000,
  });
  await expect
    .poll(() => spanOf(org.id, "Holiday"), { timeout: 10_000 })
    .toEqual([["2026-11-25T00:00:00.000Z", "2026-11-26T00:00:00.000Z"]]);
});

async function gesture(page: Page, dx: number, dy: number) {
  for (let i = 0; i < 12; i++) await page.mouse.wheel(dx, dy);
  await page.waitForTimeout(700);
}

const shownDate = (page: Page) => new URL(page.url()).searchParams.get("date");

test("the month scrolls as one long page past many months, the title following the month in view", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  const day = await page.locator('[data-month-day="2026-11-24"]').boundingBox();
  await page.mouse.move((day?.x ?? 0) + 20, (day?.y ?? 0) + 20);
  const row = day?.height ?? 100;
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, row);
  await page.getByRole("heading", { name: "December 2026" }).first().waitFor();
  await expect.poll(() => shownDate(page)).toBe("2026-12-01");
  for (let i = 0; i < 26; i++) {
    await page.mouse.wheel(0, row);
    await page.waitForTimeout(16);
  }
  await page.getByRole("heading", { name: "June 2027" }).first().waitFor();
  await expect.poll(() => shownDate(page)).toBe("2027-06-01");
  await page.keyboard.press("ArrowLeft");
  await page.getByRole("heading", { name: "May 2027" }).first().waitFor();
  await expect.poll(() => shownDate(page)).toBe("2027-05-01");
  await expect
    .poll(() =>
      page
        .locator('[data-week="2027-04-26"]')
        .evaluate(
          (row) =>
            row.getBoundingClientRect().top - (row.parentElement?.getBoundingClientRect().top ?? 0),
        ),
    )
    .toBeCloseTo(0, 0);
  expect(shownDate(page)).toBe("2027-05-01");
  await page.keyboard.press("w");
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("week");
  await page.keyboard.press("m");
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("month");
});

test("stepping back months past the laid-out weeks lands on the month asked for", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  await page.locator('[data-month-day="2026-11-24"]').waitFor();
  for (const month of ["2026-10-01", "2026-09-01", "2026-08-01"]) {
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => shownDate(page)).toBe(month);
  }
  await expect
    .poll(() =>
      page
        .locator('[data-week="2026-07-27"]')
        .evaluate(
          (row) =>
            row.getBoundingClientRect().top - (row.parentElement?.getBoundingClientRect().top ?? 0),
        ),
    )
    .toBeCloseTo(0, 0);
  expect(shownDate(page)).toBe("2026-08-01");
});

test("Today pressed while the month is still gliding lands on today's month", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2024-03-01&view=month`, origin).toString());
  await page.locator('[data-month-day="2024-03-01"]').waitFor();
  const now = new Date();
  const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("t");
  await expect.poll(() => shownDate(page)?.slice(0, 7)).toBe(first.slice(0, 7));
  await expect
    .poll(() =>
      page
        .locator(`[data-month-day="${first}"]`)
        .evaluate(
          (day) =>
            day.getBoundingClientRect().top -
            (day.closest("[data-week]")?.parentElement?.getBoundingClientRect().top ?? 0),
        ),
    )
    .toBeCloseTo(0, 0);
  expect(shownDate(page)?.slice(0, 7)).toBe(first.slice(0, 7));
});

test("in the month, ] selects only an event of the month in view", async () => {
  const { org, page, origin } = await invited();
  const kickoff = page.getByRole("button", { name: /Acme × Studio: kickoff/, pressed: true });
  await page.goto(new URL(`/${org.slug}/calendar?date=2027-02-01&view=month`, origin).toString());
  await page.locator('[data-month-day="2027-02-01"]').waitFor();
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("]");
  await page.keyboard.press("[");
  expect(await kickoff.count()).toBe(0);

  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  await page
    .locator('[data-month-day="2026-11-24"]')
    .getByRole("button", { name: /kickoff/ })
    .waitFor();
  await page.keyboard.press("]");
  await expect.poll(() => kickoff.count()).toBe(1);
});

test("Today scrolls back to today's month even when the date has not changed", async () => {
  const { org, page, origin } = await invited();
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const first = `${today.slice(0, 7)}-01`;
  await page.goto(new URL(`/${org.slug}/calendar?date=${today}&view=month`, origin).toString());
  const day = page.locator(`[data-month-day="${first}"]`);
  await day.waitFor();
  const topOf = () =>
    day.evaluate(
      (cell) =>
        cell.getBoundingClientRect().top -
        (cell.closest("[data-week]")?.parentElement?.getBoundingClientRect().top ?? 0),
    );
  const box = await day.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
  await page.mouse.wheel(0, box?.height ?? 100);
  await expect.poll(topOf).toBeLessThan(-10);
  expect(shownDate(page)).toBe(today);
  await page.keyboard.press("t");
  await expect.poll(topOf).toBeCloseTo(0, 0);
});

test("resizing the window keeps the month's weeks where they were", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  const week = page.locator('[data-week="2026-10-26"]');
  await week.waitFor();
  const offBy = () =>
    week.evaluate((row) =>
      Math.abs(
        row.getBoundingClientRect().top - (row.parentElement?.getBoundingClientRect().top ?? 0),
      ),
    );
  await expect.poll(offBy).toBeLessThan(1);
  const size = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.setViewportSize({ width: size.width, height: size.height - 220 });
  await expect.poll(offBy).toBeLessThan(1);
  await page.setViewportSize(size);
  await expect.poll(offBy).toBeLessThan(1);
  expect(shownDate(page)).toBe("2026-11-24");
});

test("an event clicked in a visible week outside the month's six takes Enter", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-12-01&view=month`, origin).toString());
  const first = page.locator('[data-month-day="2026-12-01"]');
  await first.waitFor();
  const box = await first.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
  await page.mouse.wheel(0, -(box?.height ?? 100));
  const chip = page
    .locator('[data-month-day="2026-11-24"]')
    .getByRole("button", { name: /Acme × Studio: kickoff/ });
  await chip.click();
  expect(shownDate(page)).toBe("2026-12-01");
  await page.keyboard.press("Enter");
  await page.getByRole("complementary", { name: "Acme × Studio: kickoff" }).waitFor();
});

test("scrolling fast through months never pulls the page back", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  const day = page.locator('[data-month-day="2026-11-24"]');
  await day.waitFor();
  await page.evaluate(() => {
    const scroller = document.querySelector("[data-week]")?.parentElement as HTMLElement;
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    scroller.addEventListener("scroll", () => seen.push(scroller.scrollTop));
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const box = await day.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
  for (let i = 0; i < 60; i++) await page.mouse.wheel(0, (box?.height ?? 100) / 2);
  await expect.poll(() => shownDate(page)).not.toBe("2026-11-24");
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => (window as unknown as { seen: number[] }).seen);
  const back = seen.filter((top, at) => at > 0 && top < (seen[at - 1] ?? 0) - 1);
  expect(back).toEqual([]);
});

test("the sidebar month keeps one height whether its month spans four, five or six weeks", async () => {
  const { org, page, origin } = await invited();
  const heights: number[] = [];
  for (const date of ["2021-02-10", "2012-02-10", "2026-11-10"]) {
    await page.goto(new URL(`/${org.slug}/calendar?date=${date}&view=week`, origin).toString());
    const month = page.getByRole("application", { name: /Month/ });
    await month.waitFor();
    heights.push((await month.boundingBox())?.height ?? 0);
  }
  expect(new Set(heights).size).toBe(1);
});

test("a day picked in the sidebar right after scrolling into another month stays picked", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  await page.locator('[data-month-day="2026-11-24"]').waitFor();
  const title = await page.evaluate(async () => {
    const scroller = document.querySelector("[data-week]")?.parentElement as HTMLElement;
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    scroller.scrollTop += (5 * scroller.clientHeight) / 6;
    const titled = () =>
      [...document.querySelectorAll("h1, h2, h3, [role=heading]")].some(
        (el) => el.textContent?.trim() === "December 2026",
      );
    for (let n = 0; n < 10 && !titled(); n++) await frame();
    const heading = titled() ? "December 2026" : "";
    const cell = [
      ...document.querySelectorAll('[role="grid"] [role="button"], [role="grid"] td span'),
    ].find((el) => el.textContent?.trim() === "10" && !el.closest('[aria-disabled="true"]'));
    (cell as HTMLElement | undefined)?.click();
    return heading;
  });
  expect(title).toContain("December 2026");
  await page.waitForTimeout(800);
  expect(shownDate(page)).toBe("2026-11-10");
});

test("after scrolling a month and back, a month picked in the sidebar scrolls the page there", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=month`, origin).toString());
  const day = page.locator('[data-month-day="2026-11-24"]');
  await day.waitFor();
  const box = await day.boundingBox();
  const row = box?.height ?? 100;
  await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, row);
  }
  await page.getByRole("heading", { name: "January 2027" }).first().waitFor();
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, -row);
  }
  await expect.poll(() => shownDate(page)).toBe("2026-12-01");
  await page
    .getByRole("application", { name: /Month/ })
    .getByRole("button", { name: "Next month" })
    .click();
  await page.getByRole("grid", { name: /Month/ }).getByText("1", { exact: true }).first().click();
  await expect.poll(() => shownDate(page)).toBe("2027-01-01");
  await expect
    .poll(() =>
      page
        .locator('[data-week="2026-12-28"]')
        .evaluate((week) =>
          Math.abs(
            week.getBoundingClientRect().top -
              (week.parentElement?.getBoundingClientRect().top ?? 0),
          ),
        ),
    )
    .toBeLessThan(1);
});

test("scrolling away and back before the URL catches up leaves no stale write behind", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-12-01&view=month`, origin).toString());
  const first = page.locator('[data-month-day="2026-12-01"]');
  await first.waitFor();
  const box = await first.boundingBox();
  const row = box?.height ?? 100;
  await page.mouse.move((box?.x ?? 0) + 20, (box?.y ?? 0) + 20);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, row);
  await page.getByRole("heading", { name: "January 2027" }).first().waitFor();
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -row);
  await page.waitForTimeout(800);
  expect(shownDate(page)).toBe("2026-12-01");
  const sidebar = page.getByRole("application", { name: /Month/ });
  const atTop = (week: string) =>
    page
      .locator(`[data-week="${week}"]`)
      .evaluate((el) =>
        Math.abs(
          el.getBoundingClientRect().top - (el.parentElement?.getBoundingClientRect().top ?? 0),
        ),
      );
  await sidebar.getByRole("button", { name: "Previous month" }).click();
  await sidebar.getByRole("grid").getByText("1", { exact: true }).first().click();
  await expect.poll(() => shownDate(page)).toBe("2026-11-01");
  await expect.poll(() => atTop("2026-10-26")).toBeLessThan(1);
  await sidebar.getByRole("button", { name: "Next month" }).click();
  await sidebar.getByRole("grid").getByText("1", { exact: true }).first().click();
  await expect.poll(() => shownDate(page)).toBe("2026-12-01");
  await expect.poll(() => atTop("2026-11-30")).toBeLessThan(1);
});

test("one sideways swipe steps the week, and each gesture steps once", async () => {
  const { org, page, origin } = await invited();
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-11-24&view=week`, origin).toString());
  const top = await page.locator('[data-all-day="2026-11-24"]').boundingBox();
  await page.mouse.move((top?.x ?? 0) + 20, (top?.y ?? 0) + 200);
  await gesture(page, 0, 30);
  expect(shownDate(page)).toBe("2026-11-24");
  await gesture(page, 30, 0);
  await expect.poll(() => shownDate(page)).toBe("2026-12-01");

  const month = page.getByRole("application", { name: /Month/ });
  const box = await month.boundingBox();
  await page.mouse.move((box?.x ?? 0) + 40, (box?.y ?? 0) + 80);
  await gesture(page, 0, 30);
  await month.getByRole("heading", { name: "January 2027" }).waitFor();
  expect(shownDate(page)).toBe("2026-12-01");

  await page.keyboard.down("Control");
  await gesture(page, 0, 30);
  await page.keyboard.up("Control");
  expect(await month.getByRole("heading", { name: "January 2027" }).count()).toBe(1);
});

test("a to-do dragged twice before its first save lands where it was dropped last", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Water the plants",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
    dueAt: new Date("2026-11-24T09:00:00.000Z"),
  });
  await openWeek(page, origin, org.slug);
  let patches = 0;
  await page.route("**/api/calendar/tasks/*", async (route) => {
    if (route.request().method() === "PATCH" && patches++ === 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });
  const block = () => page.locator("[data-day] [data-todo]");
  await block().dragTo(page.locator('[data-day="2026-11-25"]'), {
    sourcePosition: { x: 60, y: 4 },
    targetPosition: { x: 20, y: 11 * 48 + 4 },
  });
  await page.locator('[data-day="2026-11-25"] [data-todo]').waitFor();
  await block().dragTo(page.locator('[data-day="2026-11-26"]'), {
    sourcePosition: { x: 60, y: 4 },
    targetPosition: { x: 20, y: 15 * 48 + 4 },
  });
  await page.waitForTimeout(2500);
  await expect.poll(() => dueOf(org.id, "Water the plants")).toBe("2026-11-26T14:00:00.000Z");
});

test("a to-do dropped back where it shows, while a later drop is still queued, ends there", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Book the room",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
    dueAt: new Date("2026-11-24T09:00:00.000Z"),
  });
  await openWeek(page, origin, org.slug);
  let patches = 0;
  await page.route("**/api/calendar/tasks/*", async (route) => {
    if (route.request().method() === "PATCH" && patches++ === 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    await route.continue();
  });
  const block = () => page.locator("[data-day] [data-todo]");
  const at = (day: string, hour: number) => ({
    target: page.locator(`[data-day="${day}"]`),
    targetPosition: { x: 20, y: hour * 48 + 4 },
  });
  const drop = async (day: string, hour: number) => {
    const { target, targetPosition } = at(day, hour);
    await block().dragTo(target, { sourcePosition: { x: 60, y: 4 }, targetPosition });
  };
  await drop("2026-11-25", 11);
  await page.locator('[data-day="2026-11-25"] [data-todo]').waitFor();
  await drop("2026-11-26", 15);
  await drop("2026-11-25", 11);
  await page.waitForTimeout(3000);
  await expect.poll(() => dueOf(org.id, "Book the room")).toBe("2026-11-25T10:00:00.000Z");
});

test("an event dropped on the second pass of the hour the clocks go back stays on that pass", async () => {
  const { org, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Night audit", [
    "2026-10-25T03:30:00.000Z",
    "2026-10-25T04:00:00.000Z",
  ]);
  await page.goto(new URL(`/${org.slug}/calendar?date=2026-10-25&view=day`, origin).toString());
  await page
    .getByRole("button", { name: /Night audit/ })
    .dragTo(page.locator('[data-day="2026-10-25"]'), {
      sourcePosition: { x: 10, y: 4 },
      targetPosition: { x: 20, y: 2.5 * 48 + 4 },
    });
  await expect
    .poll(() => spanOf(org.id, "Night audit"))
    .toEqual([["2026-10-25T01:30:00.000Z", "2026-10-25T02:00:00.000Z"]]);
});

test("an event moved again while earlier moves are still saving lands where it was dropped", async () => {
  const { org, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Retro", [
    "2026-11-23T09:00:00.000Z",
    "2026-11-23T10:00:00.000Z",
  ]);
  await openWeek(page, origin, org.slug);
  let patches = 0;
  await page.route("**/api/calendar/events/*", async (route) => {
    if (route.request().method() === "PATCH") {
      const delay = patches++ === 0 ? 1500 : 3000;
      await new Promise((r) => setTimeout(r, delay));
    }
    await route.continue();
  });
  const drop = (day: string) =>
    page.getByRole("button", { name: /Retro/ }).dragTo(page.locator(`[data-day="${day}"]`), {
      sourcePosition: { x: 10, y: 4 },
      targetPosition: { x: 20, y: 10 * 48 + 4 },
    });
  await drop("2026-11-24");
  await drop("2026-11-25");
  await page.waitForTimeout(2500);
  await drop("2026-11-26");
  await expect
    .poll(() => spanOf(org.id, "Retro"), { timeout: 15_000 })
    .toEqual([["2026-11-26T09:00:00.000Z", "2026-11-26T10:00:00.000Z"]]);
});

test("Delete pressed in an open to-do leaves the selected event alone", async () => {
  const { org, member, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Focus time", [
    "2026-11-24T09:00:00.000Z",
    "2026-11-24T10:00:00.000Z",
  ]);
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Send the deck",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
  });
  await openWeek(page, origin, org.slug);
  await page
    .getByRole("region", { name: "No date" })
    .getByRole("link", { name: "Send the deck" })
    .click();
  const task = page.getByRole("region", { name: "Task" });
  await task.waitFor();
  await page.getByRole("button", { name: /Focus time/ }).click();
  await task.getByRole("button", { name: "Close task" }).focus();
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  expect(await spanOf(org.id, "Focus time")).toEqual([
    ["2026-11-24T09:00:00.000Z", "2026-11-24T10:00:00.000Z"],
  ]);
});

test("a to-do picked in the sidebar takes the place of an open event", async () => {
  const { org, member, page, origin } = await invited();
  await madeEvent(org.id, page, origin, "Review", [
    "2026-11-24T09:00:00.000Z",
    "2026-11-24T10:00:00.000Z",
  ]);
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Book the venue",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
  });
  await openWeek(page, origin, org.slug);
  await page.getByRole("button", { name: /Review/ }).dblclick();
  await page.getByRole("button", { name: "Edit" }).waitFor();
  await page
    .getByRole("region", { name: "No date" })
    .getByRole("link", { name: "Book the venue" })
    .click();
  await page.getByRole("region", { name: "Task" }).waitFor();
  await expect.poll(() => page.getByRole("button", { name: "Edit" }).count()).toBe(0);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("a private to-do never shows in the CRM's task list, and one on a record does", async () => {
  const { org, member, page, origin } = await invited();
  const crm = forMember(db, member.id).crm;
  const deal = await crm.createDeal({ name: "Website redesign" });
  if (deal.status !== "ok") throw new Error("seed");
  const linked = await crm.createTask({
    title: "Send the quote",
    record: { dealId: deal.deal.id },
  });
  if (linked.status !== "ok") throw new Error("seed");
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Call the dentist",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
  });

  await openWeek(page, origin, org.slug);
  const todos = page.getByRole("region", { name: "No date" });
  await todos.getByRole("link", { name: "Call the dentist" }).waitFor();
  await todos.getByRole("link", { name: "Send the quote" }).waitFor();

  const crmPage = await page.context().newPage();
  await crmPage.goto(new URL(`/${org.slug}/crm/tasks?assignee=anyone`, origin).toString());
  const list = crmPage.getByRole("region", { name: "No due date" });
  await list.getByText("Send the quote").waitFor();
  expect(await list.getByText("Call the dentist").count()).toBe(0);
});

test("a private to-do is put on a deal from Add to CRM in its panel, and then shows the deal", async () => {
  const { org, member, page, origin } = await invited();
  const deal = await forMember(db, member.id).crm.createDeal({ name: "Rooftop shoot" });
  if (deal.status !== "ok") throw new Error("seed");
  const [task] = await db
    .insert(schema.calendarTasks)
    .values({
      orgId: org.id,
      title: "Scout the roof",
      ownerMemberId: member.id,
      assigneeMemberId: member.id,
    })
    .returning();
  await page.goto(
    new URL(`/${org.slug}/calendar?date=2026-11-24&view=week&task=${task!.id}`, origin).toString(),
  );
  const panel = page.getByRole("region", { name: "Task" });
  await panel.getByText("Add to CRM").waitFor();
  expect(await panel.getByText("Assignee").count()).toBe(0);
  await panel.getByRole("combobox").fill("Roof");
  await page.getByRole("option", { name: "Rooftop shoot" }).click();
  await expect
    .poll(async () => {
      const [row] = await db
        .select({ kind: schema.calendarTasks.recordKind, id: schema.calendarTasks.recordId })
        .from(schema.calendarTasks)
        .where(eq(schema.calendarTasks.id, task!.id));
      return row;
    })
    .toEqual({ kind: "deal", id: deal.deal.id });
  await panel.getByRole("link", { name: "Rooftop shoot" }).waitFor();
  await panel.getByText("Assignee").waitFor();
  expect(new URL(page.url()).pathname).toBe(`/${org.slug}/calendar`);
});

test("Open on a to-do's right-click menu in the grid opens it beside the calendar", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.calendarTasks).values({
    orgId: org.id,
    title: "Print the call sheet",
    ownerMemberId: member.id,
    assigneeMemberId: member.id,
    dueAt: new Date("2026-11-25T22:59:59Z"),
  });
  await openWeek(page, origin, org.slug);
  await page.locator('[data-all-day="2026-11-25"] [data-todo]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open" }).click();
  const title = page.getByRole("region", { name: "Task" }).getByRole("textbox", { name: "Title" });
  await expect.poll(() => title.inputValue()).toBe("Print the call sheet");
  expect(new URL(page.url()).pathname).toBe(`/${org.slug}/calendar`);
});

test("a Personal space keeps its to-dos beside the calendar, with no CRM to add them to", async () => {
  const { org, member, page, origin } = await invited();
  await db.insert(schema.personalSpaces).values({ orgId: org.id, userId: member.userId });
  const [task] = await db
    .insert(schema.calendarTasks)
    .values({
      orgId: org.id,
      title: "Renew the passport",
      ownerMemberId: member.id,
      assigneeMemberId: member.id,
    })
    .returning();
  await page.goto(
    new URL(`/${org.slug}/calendar?date=2026-11-24&view=week&task=${task!.id}`, origin).toString(),
  );
  await page
    .getByRole("region", { name: "No date" })
    .getByRole("link", { name: "Renew the passport" })
    .waitFor();
  const panel = page.getByRole("region", { name: "Task" });
  await panel.getByText("Due").waitFor();
  expect(await panel.getByText("Add to CRM").count()).toBe(0);
});

test("a linked to-do checked off in the calendar leaves a teammate's open CRM list without a reload", async () => {
  const { org, member, page, origin } = await invited();
  const deal = await forMember(db, member.id).crm.createDeal({ name: "Harbor launch" });
  if (deal.status !== "ok") throw new Error("seed");
  const made = await forMember(db, member.id).crm.createTask({
    title: "Book the barge",
    record: { dealId: deal.deal.id },
  });
  if (made.status !== "ok") throw new Error("seed");

  const email = `teammate-${Date.now()}@studio.example`;
  await createMember(db, org.id, email);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const teammate = await context.newPage();
  await teammate.goto(new URL(`/${org.slug}/crm/tasks?assignee=anyone`, origin).toString());
  const list = teammate.getByRole("region", { name: "No due date" });
  await list.getByText("Book the barge").waitFor();

  await openWeek(page, origin, org.slug);
  await page
    .getByRole("region", { name: "No date" })
    .getByRole("checkbox", { name: "Complete Book the barge" })
    .click({ force: true });
  await expect.poll(() => list.getByText("Book the barge").count(), { timeout: 10_000 }).toBe(0);
  await context.close();
});
