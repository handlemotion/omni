import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { applyGoogleChanges, forMember, meetingsPipeline, schema } from "@omni/db";
import { readGoogleEvent, type GoogleCalendarChange } from "@omni/mail-core/calendar";
import { and, eq } from "drizzle-orm";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  type TestDb,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;

const shots = process.env.MEETINGS_SHOTS;
const page = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../../fixtures/google-calendar/events-page.json"),
    "utf8",
  ),
) as { timeZone: string; items: Record<string, unknown>[] };
const MOVED = new Date("2026-11-16T09:00:00.000Z");

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: {
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      RATE_LIMIT_AUTH: "off",
      TRANSCRIBE_PROVIDER: "openai",
      TRANSCRIBE_URL: "http://127.0.0.1:9/never-called",
    },
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

async function signedIn(slug: string) {
  const org = await createOrg(db, slug);
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const address = `dana-${Date.now()}@studio.example`;
  const member = await createMember(db, org.id, address);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const inbox = await createMailbox(db, org.id, address, "personal", "gmail");
  await grant(db, org.id, inbox.id, member.id);
  const [calendar] = await db
    .insert(schema.calendarCalendars)
    .values({ orgId: org.id, mailboxId: inbox.id })
    .returning();
  const changes = page.items
    .map((item) => readGoogleEvent(item, page.timeZone))
    .filter((change): change is GoogleCalendarChange => change !== null);
  await applyGoogleChanges(db, { id: calendar!.id, orgId: org.id }, changes);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, address);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: shots ? 2 : 1,
  });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const tab: Page = await context.newPage();
  const at = (path: string) => new URL(`/${org.slug}${path}`, origin).toString();
  return { org, member, calendarId: calendar!.id, tab, at };
}

test("an event's recording, its summary and its notes show in the calendar's panel and open", async () => {
  const s = await signedIn(`cal-meet-${Date.now()}`);
  const [moved] = await db
    .select()
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.calendarId, s.calendarId),
        eq(schema.calendarEvents.recurrenceId, MOVED),
      ),
    );
  const started = await forMember(db, s.member.id).meetings.start({
    title: null,
    event: { id: moved!.id, recurrenceId: MOVED.toISOString() },
    attendees: [],
    consent: true,
  });
  if (started.status !== "ok") throw new Error(started.status);
  const pipeline = meetingsPipeline(db);
  await pipeline.advance(started.meetingId, ["recording"], "writing");
  await pipeline.saveNotes(started.meetingId, s.org.id, {
    title: null,
    summary: "We moved the launch to Friday.",
    highlights: [],
    topics: [],
    actions: [],
    model: "recorded",
    promptVersion: 1,
  });
  const notes = await forMember(db, s.member.id).storage.createFolder(
    { space: "personal" },
    "Weekly sync notes",
  );
  if (notes.status !== "ok") throw new Error(notes.status);
  await pipeline.setFiles(started.meetingId, { notesNodeId: notes.node.id });

  await s.tab.goto(s.at("/calendar?date=2026-11-16&view=week"));
  await s.tab
    .getByRole("button", { name: /Weekly sync \(moved\)/ })
    .first()
    .dblclick();
  const panel = s.tab.getByRole("complementary", { name: "Weekly sync (moved)" });
  await panel.getByText("We moved the launch to Friday.").waitFor();
  if (shots) await s.tab.screenshot({ path: join(shots, "calendar-event-recording.png") });

  await panel.getByRole("button", { name: "Notes" }).click();
  await expect.poll(() => s.tab.url()).toContain(`file=${notes.node.id}`);

  await s.tab.goto(s.at("/calendar?date=2026-11-16&view=week"));
  await s.tab
    .getByRole("button", { name: /Weekly sync \(moved\)/ })
    .first()
    .dblclick();
  await s.tab.getByRole("link", { name: "Recording" }).click();
  await expect.poll(() => s.tab.url()).toContain(`/meetings/${started.meetingId}`);

  await s.tab.goto(s.at("/calendar?date=2026-11-02&view=week"));
  await s.tab
    .getByRole("button", { name: /Weekly sync/ })
    .first()
    .dblclick();
  await s.tab.getByRole("complementary", { name: "Weekly sync" }).waitFor();
  expect(await s.tab.getByRole("link", { name: "Recording" }).count()).toBe(0);
});

test("a task accepted from a meeting links back to it from the calendar", async () => {
  const s = await signedIn(`task-meet-${Date.now()}`);
  const started = await forMember(db, s.member.id).meetings.start({
    title: "Kickoff with Acme",
    event: null,
    attendees: [],
    consent: true,
  });
  if (started.status !== "ok") throw new Error(started.status);
  const task = await forMember(db, s.member.id).calendar.createTask({ title: "Send the brief" });
  if (task.status !== "ok") throw new Error(task.status);
  const [action] = await db
    .insert(schema.meetingsActions)
    .values({
      meetingId: started.meetingId,
      orgId: s.org.id,
      seq: 0,
      kind: "task",
      payload: { title: "Send the brief" },
    })
    .returning();
  await forMember(db, s.member.id).meetings.decideAction(action!.id, {
    accept: true,
    taskId: task.task.id,
  });

  await s.tab.goto(s.at(`/calendar?task=${task.task.id}`));
  const link = s.tab.getByRole("link", { name: "Kickoff with Acme" });
  await link.waitFor();
  if (shots) await s.tab.screenshot({ path: join(shots, "calendar-task-meeting.png") });
  await link.click();
  await expect.poll(() => s.tab.url()).toContain(`/meetings/${started.meetingId}`);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
