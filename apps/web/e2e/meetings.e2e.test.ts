import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { forMember, meetingsPipeline, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright-core";
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

async function recordedCall(memberId: string, orgId: string, address: string) {
  const started = await forMember(db, memberId).meetings.start({
    title: "Entregas sitio web",
    event: null,
    attendees: [
      { address, name: "Dana Ruiz" },
      { address: "marta@client.test", name: "Marta Gil" },
    ],
    groupKey: "domain:client.test",
    consent: true,
  });
  if (started.status !== "ok") throw new Error(started.status);
  const pipeline = meetingsPipeline(db);
  await pipeline.saveTranscript(started.meetingId, orgId, {
    language: "es",
    durationMs: 50_100,
    rawNodeId: null,
    turns: [
      {
        speaker: "A",
        startMs: 1200,
        endMs: 6800,
        text: "Hola Marta, quería revisar el calendario.",
      },
      {
        speaker: "B",
        startMs: 7400,
        endMs: 15_900,
        text: "El diseño final está listo el viernes.",
      },
      { speaker: "A", startMs: 16_300, endMs: 19_800, text: "Yo me encargo del acceso hoy." },
    ],
    speakers: [
      { label: "A", name: "Dana Ruiz", address, source: "mic", confidence: 1 },
      { label: "B", name: null, address: null, source: null, confidence: 0 },
    ],
  });
  await pipeline.saveNotes(started.meetingId, orgId, {
    title: null,
    summary: "Dana y Marta acordaron el acceso al servidor hoy y el diseño final el viernes.",
    highlights: [{ text: "Diseño final listo el viernes", atMs: 7400 }],
    topics: ["entregas"],
    actions: [
      {
        kind: "task",
        payload: { title: "Gestionar el acceso al servidor", owner: "Dana Ruiz", due: "hoy" },
      },
      {
        kind: "email",
        payload: {
          to: ["marta@client.test"],
          subject: "Acuerdos de la reunión",
          body: "Hola Marta…",
        },
      },
    ],
    model: "test",
    promptVersion: 1,
  });
  return started.meetingId;
}

test("a recorded meeting reads as its client's group, its notes, actions and named transcript", async () => {
  const org = await createOrg(db, "studio");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const address = `dana-${Date.now()}@studio.example`;
  const member = await createMember(db, org.id, address);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const inbox = await createMailbox(db, org.id, address, "personal");
  await grant(db, org.id, inbox.id, member.id);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, address);
  const meetingId = await recordedCall(member.id, org.id, address);
  const unfinished = await forMember(db, member.id).meetings.start({
    title: "Llamada sin notas",
    event: null,
    attendees: [{ address, name: "Dana Ruiz" }],
    groupKey: "domain:client.test",
    consent: true,
  });
  if (unfinished.status !== "ok") throw new Error(unfinished.status);
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
  const page = await context.newPage();

  await page.goto(new URL(`/${org.slug}/meetings`, origin).toString());
  const sidebar = page.getByRole("link", { name: /client\.test/ });
  await sidebar.waitFor();
  await page.getByText("Diseño final listo el viernes").waitFor();
  await page.getByRole("link", { name: /Llamada sin notas/ }).waitFor();
  await page.getByRole("heading", { name: "client.test" }).waitFor();
  if (shots) await page.screenshot({ path: join(shots, "group.png") });

  await page.getByRole("link", { name: /Entregas sitio web/ }).click();
  await expect.poll(() => page.url()).toContain(`/meetings/${meetingId}`);
  await page.getByRole("tab", { name: "Summary" }).waitFor();
  await page.getByText("Diseño final listo el viernes").waitFor();
  if (shots) await page.screenshot({ path: join(shots, "meeting-summary.png") });

  await page.getByRole("tab", { name: "Transcript" }).click();
  await page.getByText("Hola Marta, quería revisar el calendario.").waitFor();
  await page.getByRole("button", { name: "Speaker 2" }).click();
  await page.getByRole("menuitem", { name: "Marta Gil" }).click();
  await page.getByRole("button", { name: "Marta Gil" }).first().waitFor();
  await page.getByRole("searchbox", { name: "Find in transcript" }).fill("acceso");
  await expect
    .poll(() => page.getByText("Hola Marta, quería revisar el calendario.").count())
    .toBe(0);
  if (shots) await page.screenshot({ path: join(shots, "meeting-transcript.png") });

  await page.getByRole("tab", { name: "Summary" }).click();
  await page.getByText("Gestionar el acceso al servidor").waitFor();
  await page
    .getByRole("checkbox", { name: /Add Gestionar el acceso al servidor/ })
    .click({ force: true });
  await page.getByText("In calendar").waitFor();

  await page.getByRole("button", { name: "Share" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Email" }).fill("ben@studio.example");
  await dialog.getByRole("button", { name: "Invite" }).click();
  await dialog.getByText("ben@studio.example").waitFor();
  if (shots) await page.screenshot({ path: join(shots, "meeting-share.png") });
  const grants = await db
    .select()
    .from(schema.meetingsGrants)
    .where(eq(schema.meetingsGrants.meetingId, meetingId));
  expect(Object.fromEntries(grants.map((g) => [g.address, g.role]))).toMatchObject({
    [address]: "owner",
    "marta@client.test": "viewer",
    "ben@studio.example": "viewer",
  });

  await dialog.getByRole("textbox", { name: "Email" }).press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByText(/ben@studio\.example/).waitFor();
  await page.getByRole("button", { name: "Open draft" }).click();
  await expect.poll(() => page.url()).toContain("/mail/drafts");
  await page.getByRole("textbox", { name: /Subject/ }).waitFor();
  expect(await page.getByRole("textbox", { name: /Subject/ }).inputValue()).toBe(
    "Acuerdos de la reunión",
  );
  const [email] = await db
    .select()
    .from(schema.meetingsActions)
    .where(eq(schema.meetingsActions.kind, "email"));
  expect(email?.state).toBe("done");

  const [task] = await db
    .select()
    .from(schema.calendarTasks)
    .where(eq(schema.calendarTasks.title, "Gestionar el acceso al servidor"));
  expect(task?.ownerMemberId).toBe(member.id);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
