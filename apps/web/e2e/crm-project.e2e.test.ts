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

test("the team plans a project and adds a client from the deal page", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "studio");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `plan-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const headers = { cookie, origin, "content-type": "application/json", "omni-workspace": org.id };
  const made = await fetch(new URL("/api/crm/deals", origin), {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Website" }),
  });
  expect(made.status).toBe(201);
  const { deal } = (await made.json()) as { deal: { id: string } };

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/crm/deals/${deal.id}`, origin).toString());
  await page.getByRole("tab", { name: "Plan" }).click();

  await page.getByRole("button", { name: "New milestone" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Design");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect
    .poll(async () => (await milestones(deal.id)).map((m) => m.title))
    .toEqual(["Design"]);

  await page.getByRole("button", { name: "New deliverable" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Homepage");
  await page.getByText("Show to client").click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect
    .poll(async () => (await deliverables(deal.id)).map((d) => [d.title, d.clientVisible]))
    .toEqual([["Homepage", true]]);
  const [milestone] = await milestones(deal.id);
  expect((await deliverables(deal.id))[0]?.milestoneId).toBe(milestone?.id);

  await page.getByRole("button", { name: "Homepage actions" }).click();
  await page.getByRole("menuitem", { name: "In review" }).click();
  await expect.poll(async () => (await deliverables(deal.id))[0]?.status).toBe("in_review");

  for (const title of ["Build", "Launch"]) {
    await page.getByRole("button", { name: "New milestone" }).click();
    await page.getByRole("textbox", { name: "Title" }).fill(title);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: `${title} actions` }).waitFor();
  }
  await page.getByRole("button", { name: "Build actions" }).click();
  await page.getByRole("menuitem", { name: "Delete milestone" }).click();
  await expect.poll(async () => (await milestones(deal.id)).length).toBe(2);
  await page.getByRole("button", { name: "Build actions" }).waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Launch actions" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect
    .poll(async () =>
      (await milestones(deal.id)).sort((a, b) => a.position - b.position).map((m) => m.title),
    )
    .toEqual(["Launch", "Design"]);

  await page.getByRole("button", { name: "New deliverable" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Notes");
  await page.getByRole("combobox", { name: "Milestone" }).click();
  await page.getByRole("option", { name: "None" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect
    .poll(async () => (await deliverables(deal.id)).find((d) => d.title === "Notes")?.milestoneId)
    .toBeNull();

  await db
    .update(schema.crmDeliverables)
    .set({
      status: "changes_requested",
      reviewNote: "Bigger logo",
      reviewedByEmail: "bea@client.test",
      reviewedAt: new Date(),
    })
    .where(eq(schema.crmDeliverables.title, "Homepage"));
  await page.reload();
  await page.getByRole("tab", { name: "Plan" }).click();
  await page.getByRole("link", { name: "Homepage" }).click();
  const panel = page.getByRole("region", { name: "Deliverable" });
  await panel.getByText("Bigger logo").waitFor();
  await panel.getByRole("textbox", { name: "Notes" }).fill("Hero, nav and footer");
  await panel.getByRole("textbox", { name: "Notes" }).blur();
  await expect
    .poll(
      async () => (await deliverables(deal.id)).find((d) => d.title === "Homepage")?.description,
    )
    .toBe("Hero, nav and footer");
  await page.getByRole("link", { name: "Launch" }).click();
  await page.getByRole("region", { name: "Milestone" }).getByText("Launch").first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("region", { name: "Milestone" }).waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Add someone" }).click();
  await page.getByRole("textbox", { name: "Email" }).fill("bea@client.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await db
          .select()
          .from(schema.crmProjectMembers)
          .where(eq(schema.crmProjectMembers.dealId, deal.id))
      ).map((row) => [row.email, row.scope]),
    )
    .toEqual([["bea@client.test", "client"]]);
  await page.getByText("bea@client.test").first().waitFor();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/deal-plan.png` });
  await context.close();
});

const milestones = (dealId: string) =>
  db.select().from(schema.crmMilestones).where(eq(schema.crmMilestones.dealId, dealId));
const deliverables = (dealId: string) =>
  db.select().from(schema.crmDeliverables).where(eq(schema.crmDeliverables.dealId, dealId));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
