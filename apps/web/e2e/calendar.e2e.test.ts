import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseCalendar } from "@omni/mail-core/calendar";
import { applyCalendarPart, calendarArrivals, schema } from "@omni/db";
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

test("c makes an event at the selected slot, and two quick arrows move it half an hour", async () => {
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
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => (await ownEvents(org.id))[0]?.startsAt.getTime())
    .toBe((made?.startsAt.getTime() ?? 0) + 30 * 60_000);
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
  await db.insert(schema.crmTasks).values({
    orgId: org.id,
    title: "Send the brief",
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
          .select({ title: schema.crmTasks.title, assignee: schema.crmTasks.assigneeMemberId })
          .from(schema.crmTasks)
          .where(eq(schema.crmTasks.title, "Book the room"))
      ).map((t) => t.assignee),
    )
    .toEqual([member.id]);

  await page.locator('[data-all-day="2026-11-25"]').getByText("Send the brief").click();
  await expect
    .poll(async () =>
      (
        await db
          .select({ done: schema.crmTasks.completedAt })
          .from(schema.crmTasks)
          .where(eq(schema.crmTasks.title, "Send the brief"))
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
  await db.insert(schema.crmTasks).values([
    ...Array.from({ length: 101 }, (_, i) => ({
      orgId: org.id,
      title: `Old ${i}`,
      assigneeMemberId: member.id,
      dueAt: new Date(Date.UTC(2026, 9, 1, 12, i)),
    })),
    {
      orgId: org.id,
      title: "Send the brief",
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

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
