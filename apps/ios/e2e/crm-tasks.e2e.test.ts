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
  const email = "ana@tasks.test";
  const studio = await createOrgWithOwner(db, {
    name: "Studio",
    slug: "tasks-studio",
    ownerEmail: email,
  });
  const cookie = await signIn(worker, db, email);
  const call = async <T>(path: string, body: unknown) => {
    const response = await fetch(new URL(`/api${path}`, worker.url), {
      method: "POST",
      headers: {
        cookie,
        origin: app.origin,
        [WORKSPACE_HEADER]: studio.orgId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${path}: ${response.status}`);
    return (await response.json()) as T;
  };
  const { deal } = await call<{ deal: { id: string } }>("/crm/deals", { name: "Renewal" });
  const { task: loose } = await call<{ task: { id: string } }>("/crm/tasks", {
    title: "Send the proposal",
  });
  const { task: onDeal } = await call<{ task: { id: string } }>("/crm/tasks", {
    title: "Book the kickoff",
    dealId: deal.id,
  });
  return {
    cookie,
    workspaceId: studio.orgId,
    dealId: deal.id,
    looseId: loose.id,
    onDealId: onDeal.id,
  };
}

async function task(id: string) {
  const response = await fetch(new URL(`/api/crm/tasks/${id}`, worker.url), {
    headers: { cookie: seeded.cookie, origin: app.origin, [WORKSPACE_HEADER]: seeded.workspaceId },
  });
  const { task: found } = (await response.json()) as {
    task: { completedAt: string | null; body: string | null };
  };
  return found;
}

async function open(path: string, shows: string) {
  const page = await context.newPage();
  await page.goto(new URL(path, app.origin).toString());
  await page.getByText(shows, { exact: true }).first().waitFor({ timeout: 30_000 });
  return page;
}

test("checking a task off on the Tasks page completes it", async () => {
  const page = await open("/crm?page=tasks", "Send the proposal");
  await page.getByRole("checkbox", { name: "Complete Send the proposal" }).click();
  await expect
    .poll(async () => (await task(seeded.looseId))?.completedAt ?? null, { timeout: 10_000 })
    .not.toBeNull();
  await page.close();
});

test("a deal's screen lists the tasks on it, and notes typed on a task's screen are saved", async () => {
  const deal = await open(`/crm/deal/${seeded.dealId}`, "Book the kickoff");
  await deal.getByText("Book the kickoff", { exact: true }).click();
  await deal.waitForURL(`**/crm/task/${seeded.onDealId}`);
  await deal.getByLabel("Notes").fill("Ask for the Q1 budget.");
  await deal.getByLabel("Title").focus();
  await expect
    .poll(async () => (await task(seeded.onDealId))?.body ?? null, { timeout: 10_000 })
    .toBe("Ask for the Q1 budget.");
  await deal.close();
});
