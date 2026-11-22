import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GOOGLE_CALENDAR_EVENTS_PATH } from "@omni/contracts";
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
const page = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../fixtures/google-calendar/events-page.json"),
    "utf8",
  ),
) as { timeZone: string; items: Record<string, unknown>[] };

const answers = new Map<string, (body: Record<string, string>) => unknown>();

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint(({ path, body }) => {
    if (path !== GOOGLE_CALENDAR_EVENTS_PATH) return { status: 202, json: {} };
    const parsed = JSON.parse(body) as Record<string, string>;
    const answer = answers.get(parsed.mailboxId ?? "");
    return answer
      ? { status: 200, json: answer(parsed) }
      : { status: 400, json: { error: "unknown mailbox" } };
  });
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

async function gmailMember(name: string) {
  const { db } = database;
  const email = `${name}-${crypto.randomUUID().slice(0, 6)}@gmail.example`;
  const org = await createOrg(db, name);
  const member = await createMember(db, org.id, email);
  const inbox = await createMailbox(db, org.id, email, "personal", "gmail");
  await grant(db, org.id, inbox.id, member.id);
  return { org, inbox, session: await signIn(worker, db, email) };
}

async function shown(session: string) {
  const query = new URLSearchParams({
    from: "2026-11-01T00:00:00Z",
    to: "2026-12-01T00:00:00Z",
  });
  const response = await fetch(new URL(`/api/calendar/events?${query}`, worker.url), {
    headers: { cookie: session, origin: WEB_ORIGIN },
  });
  expect(response.status).toBe(200);
  const { events } = (await response.json()) as {
    events: { title: string; start: string; source: string }[];
  };
  return events.map((e) => `${e.start} ${e.title} (${e.source})`);
}

const calls = (mailboxId: string) =>
  mailService.requests
    .filter((r) => r.path === GOOGLE_CALENDAR_EVENTS_PATH && r.verified.ok)
    .map((r) => JSON.parse(r.body) as Record<string, string>)
    .filter((b) => b.mailboxId === mailboxId);

async function minute() {
  const run = await worker.server.getWorker().scheduled({ cron: MINUTE_CRON });
  expect(run.outcome).toBe("ok");
}

const makeDue = () =>
  database.db
    .update(schema.calendarGoogleSync)
    .set({ nextSyncAt: sql`now() - interval '1 second'` });

test("a Gmail inbox's Google Calendar shows on its calendar, page by page, a cancelled instance before its series included, then follows changes", async () => {
  const ana = await gmailMember("ana");
  const series = page.items.find((item) => item.id === "f0c5s1k2wq9series");
  const first = page.items.slice(0, 4).filter((item) => item !== series);
  const second = [series, ...page.items.slice(4)];
  answers.set(ana.inbox.id, (body) => {
    if (body.syncToken === "sync-1") {
      return body.pageToken === "changes-2"
        ? {
            status: "ok",
            timeZone: page.timeZone,
            items: [{ id: "3k9a7v1q2b5c8d0e4f6g", status: "cancelled" }],
            nextPageToken: null,
            nextSyncToken: "sync-2",
          }
        : {
            status: "ok",
            timeZone: page.timeZone,
            items: [],
            nextPageToken: "changes-2",
            nextSyncToken: null,
          };
    }
    return body.pageToken === "page-2"
      ? {
          status: "ok",
          timeZone: page.timeZone,
          items: second,
          nextPageToken: null,
          nextSyncToken: "sync-1",
        }
      : {
          status: "ok",
          timeZone: page.timeZone,
          items: first,
          nextPageToken: "page-2",
          nextSyncToken: null,
        };
  });

  await minute();
  expect(calls(ana.inbox.id)).toEqual([
    { orgId: ana.org.id, mailboxId: ana.inbox.id },
    { orgId: ana.org.id, mailboxId: ana.inbox.id, pageToken: "page-2" },
  ]);
  expect(await shown(ana.session)).toEqual([
    "2026-11-02T09:00:00.000Z Weekly sync (google)",
    "2026-11-16T11:00:00.000Z Weekly sync (moved) (google)",
    "2026-11-24T15:30:00.000Z Acme × Studio: kickoff (google)",
    "2026-11-26T09:00:00.000Z Dentist (google)",
    "2026-11-30T09:00:00.000Z Weekly sync (google)",
  ]);

  await minute();
  expect(calls(ana.inbox.id)).toHaveLength(2);

  await makeDue();
  await minute();
  expect(calls(ana.inbox.id).slice(2)).toEqual([
    { orgId: ana.org.id, mailboxId: ana.inbox.id, syncToken: "sync-1" },
    { orgId: ana.org.id, mailboxId: ana.inbox.id, syncToken: "sync-1", pageToken: "changes-2" },
  ]);
  expect(await shown(ana.session)).not.toContain(
    "2026-11-24T15:30:00.000Z Acme × Studio: kickoff (google)",
  );
});

test("an account connected without the calendar scope keeps working and is asked again later", async () => {
  const lee = await gmailMember("lee");
  answers.set(lee.inbox.id, () => ({ status: "no_access", reason: "no_scope" }));
  await minute();
  expect(calls(lee.inbox.id)).toHaveLength(1);
  const [calendar] = await database.db
    .select({ id: schema.calendarCalendars.id })
    .from(schema.calendarCalendars)
    .where(eq(schema.calendarCalendars.mailboxId, lee.inbox.id));
  const [state] = await database.db
    .select()
    .from(schema.calendarGoogleSync)
    .where(eq(schema.calendarGoogleSync.calendarId, calendar!.id));
  expect(state?.state).toBe("no_access");
  expect(state!.nextSyncAt.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
  expect(await shown(lee.session)).toEqual([]);
});

test("Google forgetting the sync token starts a full pass that drops what Google no longer has", async () => {
  const kim = await gmailMember("kim");
  let reset = false;
  answers.set(kim.inbox.id, (body) => {
    if (body.syncToken === "old" && !reset) {
      reset = true;
      return { status: "reset" };
    }
    const items = reset ? [page.items.find((i) => i.id === "7wl3floating")] : page.items;
    return {
      status: "ok",
      timeZone: page.timeZone,
      items,
      nextPageToken: null,
      nextSyncToken: "old",
    };
  });
  await minute();
  expect(await shown(kim.session)).toContain(
    "2026-11-24T15:30:00.000Z Acme × Studio: kickoff (google)",
  );

  await makeDue();
  await minute();
  expect(calls(kim.inbox.id).slice(-2)).toEqual([
    { orgId: kim.org.id, mailboxId: kim.inbox.id, syncToken: "old" },
    { orgId: kim.org.id, mailboxId: kim.inbox.id },
  ]);
  expect(await shown(kim.session)).toEqual(["2026-11-26T09:00:00.000Z Dentist (google)"]);
});
