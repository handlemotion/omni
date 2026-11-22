import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
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

const MEDIA = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--auto-select-tab-capture-source-by-title=Team call",
];

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

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
  browser = await chromium
    .launch({ args: MEDIA })
    .catch(() => chromium.launch({ channel: "chrome", args: MEDIA }));
});

afterAll(async () => {
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

async function signedIn() {
  const org = await createOrg(db, `rec-${Date.now()}`);
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const address = `dana-${Date.now()}@studio.example`;
  const member = await createMember(db, org.id, address);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const inbox = await createMailbox(db, org.id, address, "personal");
  await grant(db, org.id, inbox.id, member.id);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, address);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: shots ? 2 : 1,
  });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const call = await context.newPage();
  await call.setContent("<title>Team call</title><p>call</p>");
  const page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/meetings`, origin).toString());
  return { page, member };
}

async function record(page: Page) {
  await page.getByRole("button", { name: "Record" }).click();
  const dialog = page.getByRole("alertdialog");
  if (shots) await page.screenshot({ path: join(shots, "recorder-consent.png") });
  await dialog.getByRole("button", { name: "Record" }).click();
  await page.getByRole("button", { name: "Stop" }).waitFor();
  if (shots) await page.screenshot({ path: join(shots, "recorder-recording.png") });
}

const meetingOf = async (memberId: string) =>
  (
    await db
      .select()
      .from(schema.meetingsMeetings)
      .where(eq(schema.meetingsMeetings.recordedByMemberId, memberId))
  )[0];

const chunksOf = (meetingId: string) =>
  db.select().from(schema.meetingsChunks).where(eq(schema.meetingsChunks.meetingId, meetingId));

const keptOnComputer = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open("omni-recorder");
        open.onsuccess = () => {
          const count = open.result.transaction("chunks").objectStore("chunks").count();
          count.onsuccess = () => resolve(count.result);
        };
      }),
  );

test("Record sends the tab and the mic in acknowledged chunks, and Stop ends the meeting whole", async () => {
  const { page, member } = await signedIn();
  await record(page);
  await expect.poll(() => meetingOf(member.id)).toBeTruthy();
  const meeting = await meetingOf(member.id);
  await expect
    .poll(async () => (await chunksOf(meeting!.id)).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => page.url()).toContain(`/meetings/${meeting!.id}`);
  await expect
    .poll(async () => (await meetingOf(member.id))?.status, { timeout: 20_000 })
    .not.toBe("recording");
  const chunks = await chunksOf(meeting!.id);
  const [job] = await db
    .select({ chunkCount: schema.meetingsJobs.chunkCount })
    .from(schema.meetingsJobs)
    .where(eq(schema.meetingsJobs.meetingId, meeting!.id));
  expect(job?.chunkCount).toBe(chunks.length);
  expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
  await expect.poll(() => keptOnComputer(page)).toBe(0);
});

test("a reload mid-recording, with chunks still on the computer, finishes the meeting with them", async () => {
  const { page, member } = await signedIn();
  await record(page);
  await expect.poll(() => meetingOf(member.id)).toBeTruthy();
  const meeting = await meetingOf(member.id);
  await expect
    .poll(async () => (await chunksOf(meeting!.id)).length, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1);

  await page.context().setOffline(true);
  const sent = (await chunksOf(meeting!.id)).length;
  await expect.poll(() => keptOnComputer(page), { timeout: 20_000 }).toBeGreaterThan(sent);
  const kept = await keptOnComputer(page);
  await page.context().setOffline(false);
  await page.reload();

  await expect
    .poll(async () => (await meetingOf(member.id))?.status, { timeout: 30_000 })
    .not.toBe("recording");
  const chunks = await chunksOf(meeting!.id);
  expect(chunks.length).toBeGreaterThanOrEqual(kept);
  expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i));
  const [job] = await db
    .select({ chunkCount: schema.meetingsJobs.chunkCount })
    .from(schema.meetingsJobs)
    .where(eq(schema.meetingsJobs.meetingId, meeting!.id));
  expect(job?.chunkCount).toBe(chunks.length);
  await expect.poll(() => keptOnComputer(page)).toBe(0);
});
