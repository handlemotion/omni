import { WORKSPACE_HEADER } from "@omni/client";
import { createOrgWithOwner } from "@omni/db";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
} from "../../worker/e2e/support.ts";
import { exportWebApp, openApp, serveWebApp } from "./web-app.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let app: Awaited<ReturnType<typeof serveWebApp>>;
let browser: Browser;
let context: BrowserContext;
let seeded: Awaited<ReturnType<typeof seed>>;

beforeAll(async () => {
  app = await serveWebApp();
  const exported = exportWebApp(app.origin);
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { BETTER_AUTH_URL: app.origin, AUTH_TRUSTED_ORIGINS: `${WEB_ORIGIN},${app.origin}` },
  });
  app.proxyTo(worker.url);
  seeded = await seed();
  await exported;
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  context = await openApp(browser, app, seeded.cookie, seeded.workspaceId);
}, 300_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await app?.close();
  await database?.teardown();
});

async function seed() {
  const { db } = database;
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const email = "ana@plan.test";
  const studio = await createOrgWithOwner(db, {
    name: "Studio",
    slug: "plan-studio",
    ownerEmail: email,
  });
  const cookie = await signIn(worker, db, email);
  const call = async <T>(method: string, path: string, body: unknown, as = cookie) => {
    const response = await fetch(new URL(`/api${path}`, worker.url), {
      method,
      headers: {
        cookie: as,
        origin: app.origin,
        ...(as === cookie ? { [WORKSPACE_HEADER]: studio.orgId } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const { deal } = await call<{ deal: { id: string } }>("POST", "/crm/deals", { name: "Website" });
  const { milestone } = await call<{ milestone: { id: string } }>(
    "POST",
    `/crm/deals/${deal.id}/milestones`,
    { title: "Design", targetOn: "2026-12-15" },
  );
  const { deliverable } = await call<{ deliverable: { id: string } }>(
    "POST",
    `/crm/deals/${deal.id}/deliverables`,
    { title: "Homepage", milestoneId: milestone.id, status: "in_review", clientVisible: true },
  );
  await call("POST", `/crm/deals/${deal.id}/deliverables`, { title: "Brand notes" });
  await call("PUT", `/crm/deals/${deal.id}/access/${encodeURIComponent("bea@client.test")}`, {
    scope: "client",
  });
  const bea = await signIn(worker, db, "bea@client.test");
  await call(
    "POST",
    `/portal/projects/${deal.id}/deliverables/${deliverable.id}/review`,
    { decision: "request_changes", note: "Bigger logo" },
    bea,
  );
  return { cookie, workspaceId: studio.orgId, dealId: deal.id };
}

test("a project's screen shows its plan and who outside the team is on it", async () => {
  const page = await context.newPage();
  await page.goto(new URL(`/crm/deal/${seeded.dealId}`, app.origin).toString());
  await page.getByText("Design", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByText("bea@client.test", { exact: true }).waitFor();
  const shown = async (text: string) => page.getByText(text, { exact: true }).count();
  for (const text of [
    "Homepage",
    "Bigger logo",
    "Changes requested",
    "Brand notes",
    "Draft",
    "Client",
  ]) {
    expect({ text, count: await shown(text) }).not.toMatchObject({ count: 0 });
  }
  const shots = process.env.OMNI_E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/ios-plan.png`, fullPage: true });
  await page.close();
});
