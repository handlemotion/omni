import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
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

const SHOTS = process.env.OMNI_E2E_SHOTS;

test("a client approves one deliverable and sends another back with a note, from the portal", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "studio");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const owner = `owner-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, owner);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const team = await signIn({ url: new URL(origin) }, db, owner);
  const post = async (path: string, body: unknown, method = "POST") => {
    const response = await fetch(new URL(`/api${path}`, origin), {
      method,
      headers: { cookie: team, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBeLessThan(300);
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return (await response.json()) as any;
  };
  const website = (await post("/crm/deals", { name: "Website" })).deal.id as string;
  await post("/crm/deals", { name: "Hidden app" });
  const design = (await post(`/crm/deals/${website}/milestones`, { title: "Design" })).milestone;
  const visible = { status: "in_review", clientVisible: true, milestoneId: design.id };
  const home = (await post(`/crm/deals/${website}/deliverables`, { title: "Homepage", ...visible }))
    .deliverable.id as string;
  const about = (await post(`/crm/deals/${website}/deliverables`, { title: "About", ...visible }))
    .deliverable.id as string;
  await post(`/crm/deals/${website}/deliverables`, { title: "Margins", status: "in_review" });
  const client = `bea-${Date.now()}@client.test`;
  await post(
    `/crm/deals/${website}/access/${encodeURIComponent(client)}`,
    { scope: "client" },
    "PUT",
  );

  const cookie = await signIn({ url: new URL(origin) }, db, client);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL("/portal", origin).toString());
  await page.getByRole("link", { name: /Website/ }).click();
  await page.getByText("Homepage").waitFor();
  expect(await page.getByText("Margins").count()).toBe(0);
  expect(await page.getByText("Hidden app").count()).toBe(0);

  const row = (title: string) => page.locator("div.flex-col.gap-1.py-1", { hasText: title });
  await row("Homepage").getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => (await deliverable(home))?.status).toBe("approved");
  expect((await deliverable(home))?.reviewedByEmail).toBe(client);

  await row("About").getByRole("button", { name: "Request changes" }).click();
  await page.getByRole("textbox", { name: "What should change" }).fill("Bigger team photo");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => {
      const found = await deliverable(about);
      return [found?.status, found?.reviewNote];
    })
    .toEqual(["changes_requested", "Bigger team photo"]);
  await page.locator("p", { hasText: "Bigger team photo" }).waitFor();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/portal.png` });
  await context.close();
});

async function deliverable(id: string) {
  const [found] = await db
    .select()
    .from(schema.crmDeliverables)
    .where(eq(schema.crmDeliverables.id, id));
  return found;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
