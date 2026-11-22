import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { forMember, meetingsPipeline, schema } from "@omni/db";
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

async function signedIn() {
  const t = Date.now();
  const org = await createOrg(db, `crm-meet-${t}`);
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const address = `dana-${t}@studio.example`;
  const member = await createMember(db, org.id, address);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const inbox = await createMailbox(db, org.id, address, "personal");
  await grant(db, org.id, inbox.id, member.id);
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, address);
  const crm = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(`/api/crm${path}`, origin), {
      method,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return (await response.json()) as any;
  };
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
  return { org, member, address, crm, tab, at, t };
}

async function recorded(memberId: string, orgId: string, title: string, attendees: string[]) {
  const started = await forMember(db, memberId).meetings.start({
    title,
    event: null,
    attendees: attendees.map((address) => ({ address, name: null })),
    consent: true,
  });
  if (started.status !== "ok") throw new Error(started.status);
  await meetingsPipeline(db).advance(started.meetingId, ["recording"], "writing");
  await meetingsPipeline(db).advance(started.meetingId, ["recording"], "writing");
  await meetingsPipeline(db).saveNotes(started.meetingId, orgId, {
    title: null,
    summary: `${title}: agreed the next steps.`,
    highlights: [],
    topics: [],
    actions: [{ kind: "task", payload: { title: "Send the brief" } }],
    model: "recorded",
    promptVersion: 1,
  });
  return started.meetingId;
}

test("a project's Meetings tab, a person's timeline and a meeting's record link each other", async () => {
  const s = await signedIn();
  const carla = `carla@acme-${s.t}.test`;
  const person = await s.crm("POST", "/people", { name: "Carla Ruiz", address: carla });
  const { id: personId, companyId } = person.person;
  const deal = await s.crm("POST", "/deals", { name: "Website", companyId, personIds: [personId] });
  const dealId = deal.deal.id as string;
  const other = await s.crm("POST", "/deals", { name: "Rebrand", companyId });
  const kickoff = await recorded(s.member.id, s.org.id, "Kickoff with Carla", [s.address, carla]);
  await recorded(s.member.id, s.org.id, "Design review", [`lee@acme-${s.t}.test`]);
  await recorded(s.member.id, s.org.id, "Unrelated call", ["x@else.test"]);

  await s.tab.goto(s.at(`/crm/deals/${dealId}`));
  await s.tab.getByRole("tab", { name: "Meetings" }).click();
  await s.tab.getByRole("link", { name: /Kickoff with Carla/ }).waitFor();
  await s.tab.getByRole("link", { name: /Design review/ }).waitFor();
  expect(await s.tab.getByRole("link", { name: /Unrelated call/ }).count()).toBe(0);
  await s.tab.getByText("1 open action").first().waitFor();
  if (shots) await s.tab.screenshot({ path: join(shots, "deal-meetings.png") });

  await s.tab.getByRole("button", { name: "Actions for Design review" }).click();
  await s.tab.getByRole("menuitem", { name: "Take off this project" }).click();
  await expect.poll(() => s.tab.getByRole("link", { name: /Design review/ }).count()).toBe(0);

  await s.tab.goto(s.at(`/crm/people/${personId}`));
  const line = s.tab.getByRole("link", { name: /Kickoff with Carla: agreed the next steps/ });
  await line.waitFor();

  if (shots) await s.tab.screenshot({ path: join(shots, "person-timeline.png") });
  await line.click();
  await expect.poll(() => s.tab.url()).toContain(`/meetings/${kickoff}`);

  await s.tab.getByRole("link", { name: "Website" }).waitFor();
  if (shots) await s.tab.screenshot({ path: join(shots, "meeting-record.png") });
  await s.tab.getByRole("combobox", { name: "Record" }).fill("Rebr");
  await s.tab.getByRole("option", { name: "Rebrand" }).click();
  await s.tab.getByRole("button", { name: "Remove from record" }).waitFor();
  await s.tab.getByRole("link", { name: "Rebrand" }).click();
  await expect.poll(() => s.tab.url()).toContain(`/crm/deals/${other.deal.id}`);
  const [row] = await db
    .select()
    .from(schema.meetingsMeetings)
    .where(eq(schema.meetingsMeetings.id, kickoff));
  expect(row).toMatchObject({ recordKind: "deal", recordId: other.deal.id });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
