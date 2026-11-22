import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq, inArray } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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
const contexts: BrowserContext[] = [];

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
  for (const context of contexts) await context.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("right-clicking a company row archives that company, and only it", async () => {
  const team = await workspace("menu-row");
  const { company: acme } = await team.api("POST", "/companies", { name: "Acme" });
  const { company: globex } = await team.api("POST", "/companies", { name: "Globex" });
  const page = await team.page("/crm/companies");

  const shown = await rightClick(page, page.getByRole("row", { name: /Acme/ }));
  expect(shown.prevented).toBe(true);
  await page.mouse.move(1, 1);
  const focused = () =>
    page.evaluate(() =>
      document.activeElement?.getAttribute("role") === "menuitem"
        ? (document.activeElement.textContent ?? "")
        : "",
    );
  for (let step = 0; step < 10 && !(await focused()).includes("Set owner"); step++) {
    await page.keyboard.press("ArrowDown");
  }
  await page.keyboard.press("ArrowRight");
  await expect.poll(focused).toContain("No owner");
  await page.keyboard.press("Escape");
  await page.getByRole("menuitem", { name: "No owner" }).waitFor({ state: "hidden" });
  await expect.poll(() => page.getByRole("menu").count()).toBe(1);
  await menuItem(page, "Archive").click();

  await expect
    .poll(() => archived([acme.id, globex.id]), { timeout: 10_000 })
    .toEqual({ [acme.id]: true, [globex.id]: false });
});

test("right-clicking a picked row acts on every picked row", async () => {
  const team = await workspace("menu-bulk");
  const ids: string[] = [];
  for (const name of ["Initech", "Umbrella", "Hooli"]) {
    ids.push((await team.api("POST", "/companies", { name })).company.id);
  }
  const page = await team.page("/crm/companies");
  for (const name of ["Initech", "Umbrella"]) {
    await page
      .getByRole("row", { name: new RegExp(name) })
      .getByRole("checkbox")
      .click({ force: true });
  }

  await rightClick(page, page.getByRole("row", { name: /Umbrella/ }));
  await menuItem(page, "Archive 2 companies").click();

  await expect
    .poll(() => archived(ids), { timeout: 10_000 })
    .toEqual(Object.fromEntries(ids.map((id, i) => [id, i < 2])));
});

test("right-clicking under a list's rows offers New, which opens its dialog", async () => {
  const team = await workspace("menu-empty");
  await team.api("POST", "/companies", { name: "Acme" });
  const page = await team.page("/crm/companies");
  await page.getByRole("row", { name: /Acme/ }).waitFor();

  const box = await page.getByRole("grid").boundingBox();
  if (!box) throw new Error("no table");
  const height = page.viewportSize()?.height ?? 720;
  await page.mouse.click(box.x + box.width / 2, height - 40, { button: "right" });
  await menuItem(page, "New company").click();
  await expect.poll(() => page.getByRole("dialog").count()).toBe(1);
});

test("a deal card's right-click moves it to another stage", async () => {
  const team = await workspace("menu-board");
  const { deal } = await team.api("POST", "/deals", { name: "Rebrand" });
  const { stages } = (await team.api("GET", "/stages")) as {
    stages: { id: string; name: string }[];
  };
  const target = stages.find((stage) => stage.id !== deal.stageId);
  if (!target) throw new Error("one stage only");
  const page = await team.page("/crm/deals");

  await rightClick(
    page,
    page
      .getByRole("list", { name: /^Deals in / })
      .getByRole("listitem")
      .filter({ has: page.getByText("Rebrand", { exact: true }) }),
  );
  await menuItem(page, "Move to stage").hover();
  await menuItem(page, target.name).click();

  await expect
    .poll(
      async () =>
        (
          await db
            .select({ stageId: schema.crmDeals.stageId })
            .from(schema.crmDeals)
            .where(eq(schema.crmDeals.id, deal.id))
        )[0]?.stageId,
      { timeout: 10_000 },
    )
    .toBe(target.id);
});

test("a task's right-click completes it", async () => {
  const team = await workspace("menu-task");
  const { task } = await team.api("POST", "/tasks", { title: "Call the venue" });
  const page = await team.page("/crm/tasks");

  await rightClick(page, page.getByRole("listitem").filter({ hasText: "Call the venue" }));
  await menuItem(page, "Complete").click();

  await expect
    .poll(
      async () =>
        (
          await db
            .select({ completedAt: schema.crmTasks.completedAt })
            .from(schema.crmTasks)
            .where(eq(schema.crmTasks.id, task.id))
        )[0]?.completedAt ?? null,
      { timeout: 10_000 },
    )
    .not.toBeNull();
});

async function rightClick(page: Page, target: ReturnType<Page["locator"]>) {
  await target.waitFor();
  await page.evaluate(() => {
    const w = window as unknown as { lastContextMenu?: boolean };
    window.addEventListener("contextmenu", (event) => (w.lastContextMenu = event.defaultPrevented));
  });
  await target.click({ button: "right" });
  await page.getByRole("menu").first().waitFor();
  return {
    prevented: await page.evaluate(
      () => (window as unknown as { lastContextMenu?: boolean }).lastContextMenu,
    ),
  };
}

function menuItem(page: Page, name: string) {
  return page.getByRole("menuitem", { name, exact: true });
}

async function archived(ids: string[]) {
  const rows = await db
    .select({ id: schema.crmCompanies.id, archivedAt: schema.crmCompanies.archivedAt })
    .from(schema.crmCompanies)
    .where(inArray(schema.crmCompanies.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.archivedAt !== null]));
}

async function workspace(slug: string) {
  const org = await createOrg(db, slug);
  const email = `owner-${slug}-${Date.now()}@crm.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(`/api/crm${path}`, origin), {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return (text ? JSON.parse(text) : null) as any;
  };
  return {
    api,
    async page(path: string) {
      const context = await browser.newContext({ locale: "en-US" });
      contexts.push(context);
      await context.addCookies(
        cookie.split("; ").map((pair) => {
          const at = pair.indexOf("=");
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
        }),
      );
      const page = await context.newPage();
      await page.goto(new URL(`/${org.slug}${path}`, origin).toString());
      return page;
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
