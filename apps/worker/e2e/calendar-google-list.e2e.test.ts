import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GOOGLE_CALENDAR_EVENTS_PATH, GOOGLE_CALENDAR_LIST_PATH } from "@omni/contracts";
import { schema } from "@omni/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "./support.ts";

const MINUTE_CRON = "* * * * *";
const TEAM = "c_0f3a9d2b7e41c6a8@group.calendar.google.com";
const HOLIDAYS = "es.mexican#holiday@group.v.calendar.google.com";

type Page = { timeZone: string; nextSyncToken: string; items: Record<string, unknown>[] };
const fixture = <T>(name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "../../../fixtures/google-calendar", name), "utf8"),
  ) as T;
const list = fixture<{ items: Record<string, unknown>[] }>("calendar-list.json");
const pages: Record<string, Page> = {
  primary: fixture("events-page.json"),
  [TEAM]: fixture("events-team.json"),
  [HOLIDAYS]: fixture("events-holidays.json"),
};

interface Account {
  calendars: string[];
  listScope?: boolean;
}
const accounts = new Map<string, Account>();

function answer(path: string, body: { mailboxId?: string; calendarId?: string }) {
  const account = accounts.get(body.mailboxId ?? "");
  if (!account) return { status: 400, json: { error: "unknown mailbox" } };
  if (path === GOOGLE_CALENDAR_LIST_PATH) {
    if (account.listScope === false) {
      return { status: 200, json: { status: "no_access", reason: "no_scope" } };
    }
    const items = list.items.filter(
      (item) => item.primary === true || account.calendars.includes(String(item.id)),
    );
    return { status: 200, json: { status: "ok", items } };
  }
  const page = pages[body.calendarId ?? "primary"];
  if (!page) return { status: 502, json: { error: "no such calendar" } };
  return {
    status: 200,
    json: {
      status: "ok",
      timeZone: page.timeZone,
      items: page.items,
      nextPageToken: null,
      nextSyncToken: page.nextSyncToken,
    },
  };
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint(({ path, body }) =>
    path === GOOGLE_CALENDAR_EVENTS_PATH || path === GOOGLE_CALENDAR_LIST_PATH
      ? answer(path, JSON.parse(body) as { mailboxId?: string })
      : { status: 202, json: {} },
  );
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { GOOGLE_CLIENT_ID: "e2e-client.apps.googleusercontent.com", WEB_APP_URL: WEB_ORIGIN },
    secrets: { GOOGLE_CLIENT_SECRET: "e2e-google-secret" },
  });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
}, 60_000);

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

async function gmailAccount(name: string, calendars: string[]) {
  const { db } = database;
  const email = `${name}-${crypto.randomUUID().slice(0, 6)}@gmail.example`;
  const org = await createOrg(db, name);
  const member = await createMember(db, org.id, email);
  const inbox = await createMailbox(db, org.id, email, "personal", "gmail");
  await grant(db, org.id, inbox.id, member.id);
  accounts.set(inbox.id, { calendars });
  return { org, inbox, email, session: await signIn(worker, db, email) };
}

const api = (session: string, path: string, init: RequestInit = {}) =>
  fetch(new URL(`/api/calendar${path}`, worker.url), {
    ...init,
    headers: { cookie: session, origin: WEB_ORIGIN, "content-type": "application/json" },
  });

async function calendarsOf(session: string) {
  const response = await api(session, "/calendars");
  expect(response.status).toBe(200);
  const { calendars } = (await response.json()) as {
    calendars: {
      id: string;
      address: string;
      name: string | null;
      readOnly: boolean;
      color: string | null;
      hidden: boolean;
    }[];
  };
  return calendars;
}

async function shown(session: string) {
  const [calendars, response] = await Promise.all([
    calendarsOf(session),
    api(session, `/events?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z`),
  ]);
  expect(response.status).toBe(200);
  const nameOf = new Map(calendars.map((c) => [c.id, c.name ?? "own"]));
  const { events } = (await response.json()) as {
    events: { title: string; start: string; calendarId: string }[];
  };
  return events.map((e) => `${nameOf.get(e.calendarId)}: ${e.start} ${e.title}`).toSorted();
}

async function minute() {
  const run = await worker.server.getWorker().scheduled({ cron: MINUTE_CRON });
  expect(run.outcome).toBe("ok");
}

const makeDue = () =>
  database.db
    .update(schema.calendarGoogleSync)
    .set({ nextSyncAt: sql`now() - interval '1 second'` });

const ALL_SHOWN = [
  "Holidays in Mexico: 2026-11-02T00:00:00.000Z All Souls' Day",
  "Holidays in Mexico: 2026-11-16T00:00:00.000Z Revolution Day Holiday",
  "Studio team: 2026-11-24T15:30:00.000Z Acme × Studio: kickoff",
  "Studio team: 2026-11-25T09:00:00.000Z Lookbook shoot",
  "own: 2026-11-02T09:00:00.000Z Weekly sync",
  "own: 2026-11-16T11:00:00.000Z Weekly sync (moved)",
  "own: 2026-11-24T15:30:00.000Z Acme × Studio: kickoff",
  "own: 2026-11-26T09:00:00.000Z Dentist",
  "own: 2026-11-30T09:00:00.000Z Weekly sync",
];

test("a Gmail account with three Google calendars shows three under its address, each with its own events and toggled on its own; one it leaves goes away", async () => {
  const ana = await gmailAccount("ana", [TEAM, HOLIDAYS]);
  await minute();

  const calendars = await calendarsOf(ana.session);
  expect(
    calendars.map(({ address, name, readOnly, color }) => ({ address, name, readOnly, color })),
  ).toEqual([
    { address: ana.email, name: null, readOnly: false, color: "#9fe1e7" },
    { address: ana.email, name: "Holidays in Mexico", readOnly: true, color: "#16a765" },
    { address: ana.email, name: "Studio team", readOnly: true, color: "#fa573c" },
  ]);
  const requested = mailService.requests
    .filter((r) => r.path === GOOGLE_CALENDAR_EVENTS_PATH && r.verified.ok)
    .map((r) => JSON.parse(r.body) as { mailboxId: string; calendarId?: string })
    .filter((b) => b.mailboxId === ana.inbox.id)
    .map((b) => b.calendarId ?? "primary");
  expect(requested.toSorted()).toEqual(["primary", TEAM, HOLIDAYS].toSorted());
  expect(await shown(ana.session)).toEqual(ALL_SHOWN);

  const holidays = calendars.find((c) => c.name === "Holidays in Mexico")!;
  const hide = await api(ana.session, `/calendars/${holidays.id}`, {
    method: "PATCH",
    body: JSON.stringify({ hidden: true }),
  });
  expect(hide.status).toBe(204);
  expect(await shown(ana.session)).toEqual(ALL_SHOWN.filter((e) => !e.startsWith("Holidays")));

  const team = calendars.find((c) => c.name === "Studio team")!;
  const made = await api(ana.session, "/events", {
    method: "POST",
    body: JSON.stringify({
      calendarId: team.id,
      title: "Planning",
      start: "2026-11-27T10:00:00Z",
      end: "2026-11-27T11:00:00Z",
    }),
  });
  expect(made.status).toBe(404);

  accounts.set(ana.inbox.id, { calendars: [HOLIDAYS] });
  await makeDue();
  await minute();
  expect((await calendarsOf(ana.session)).map((c) => c.name)).toEqual([null, "Holidays in Mexico"]);
  expect(await shown(ana.session)).toEqual(ALL_SHOWN.filter((e) => e.startsWith("own")));
});

test("a re-sync from nothing converges on the same calendars and events", async () => {
  const kim = await gmailAccount("kim", [TEAM, HOLIDAYS]);
  await minute();
  const before = await shown(kim.session);
  expect(before).toEqual(ALL_SHOWN);

  await database.db
    .delete(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.mailboxId, kim.inbox.id));
  await minute();
  expect(await shown(kim.session)).toEqual(before);
  await makeDue();
  await minute();
  expect(await shown(kim.session)).toEqual(before);
  expect((await calendarsOf(kim.session)).map((c) => c.name)).toEqual([
    null,
    "Holidays in Mexico",
    "Studio team",
  ]);
});

test("an account connected without the calendar list scope shows its primary calendar alone, and keeps the ones it had", async () => {
  const lee = await gmailAccount("lee", [TEAM]);
  accounts.set(lee.inbox.id, { calendars: [TEAM], listScope: false });
  await minute();
  expect((await calendarsOf(lee.session)).map((c) => c.name)).toEqual([null]);
  expect(await shown(lee.session)).toEqual(ALL_SHOWN.filter((e) => e.startsWith("own")));

  accounts.set(lee.inbox.id, { calendars: [TEAM] });
  await makeDue();
  await minute();
  expect((await calendarsOf(lee.session)).map((c) => c.name)).toEqual([null, "Studio team"]);
  accounts.set(lee.inbox.id, { calendars: [], listScope: false });
  await makeDue();
  await minute();
  expect((await calendarsOf(lee.session)).map((c) => c.name)).toEqual([null, "Studio team"]);
});
