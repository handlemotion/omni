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

test("checking a task off in the list completes it, and notes typed on its page are saved", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "studio");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `tasks-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const headers = { cookie, origin, "content-type": "application/json", "omni-workspace": org.id };
  const made = await fetch(new URL("/api/crm/tasks", origin), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Send the proposal" }),
  });
  expect(made.status).toBe(201);
  const { task } = (await made.json()) as { task: { id: string } };

  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/crm/tasks`, origin).toString());
  await page.getByRole("checkbox", { name: "Complete Send the proposal" }).click({ force: true });
  await expect
    .poll(async () => (await row(task.id))?.completedAt ?? null, { timeout: 10_000 })
    .not.toBeNull();

  await page.goto(new URL(`/${org.slug}/crm/tasks/${task.id}`, origin).toString());
  await page.getByRole("textbox", { name: "Notes" }).fill("Ask for the Q1 budget.");
  await page.getByRole("textbox", { name: "Title" }).click();
  await expect
    .poll(async () => (await row(task.id))?.body ?? null, { timeout: 10_000 })
    .toBe("Ask for the Q1 budget.");
  await context.close();
});

test("a task opens beside the list, edits save to that task, and Escape closes it", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "panel");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `panel-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const headers = { cookie, origin, "content-type": "application/json", "omni-workspace": org.id };
  const make = async (title: string) => {
    const made = await fetch(new URL("/api/crm/tasks", origin), {
      method: "POST",
      headers,
      body: JSON.stringify({ title }),
    });
    return ((await made.json()) as { task: { id: string } }).task.id;
  };
  const first = await make("Call the venue");
  const second = await make("Book the crew");

  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/crm/tasks`, origin).toString());
  await page.getByRole("link", { name: "Call the venue" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(first);
  expect(new URL(page.url()).pathname).toBe(`/${org.slug}/crm/tasks`);
  const panel = page.getByRole("region", { name: "Task" });
  await panel.getByRole("textbox", { name: "Notes" }).fill("Ask about parking.");
  await page.getByRole("link", { name: "Book the crew" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(second);
  await expect
    .poll(() => panel.getByRole("textbox", { name: "Title" }).inputValue())
    .toBe("Book the crew");
  await expect.poll(async () => (await row(first))?.body ?? null).toBe("Ask about parking.");
  expect((await row(second))?.body ?? null).toBeNull();

  await page.getByRole("heading", { name: "Tasks" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBeNull();
  await expect.poll(() => panel.count()).toBe(0);
  await context.close();
});

test("an open task is found from the command menu and opens beside the task list", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "find-task");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `find-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const made = await fetch(new URL("/api/crm/tasks", origin), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json", "omni-workspace": org.id },
    body: JSON.stringify({ title: "Scout the rooftop location" }),
  });
  const { task } = (await made.json()) as { task: { id: string } };

  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/crm/companies`, origin).toString());
  await page.getByRole("main").waitFor();
  const menu = page.getByRole("dialog", { name: "Search and commands" });
  await page.keyboard.press("Control+k");
  await menu.waitFor();
  await page.keyboard.type("rooftop");
  await menu.getByRole("option", { name: /Scout the rooftop location/ }).click();
  await page.waitForURL(new RegExp(`/${org.slug}/crm/tasks\\?`));
  expect(new URL(page.url()).searchParams.get("task")).toBe(task.id);
  await page
    .getByRole("region", { name: "Task" })
    .getByRole("textbox", { name: "Title" })
    .waitFor();
  await context.close();
});

test("a task dragged onto Today is due today, and onto No due date has no due date", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "planner");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `planner-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const headers = { cookie, origin, "content-type": "application/json", "omni-workspace": org.id };
  const made = await fetch(new URL("/api/crm/tasks", origin), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Call the client" }),
  });
  const { task } = (await made.json()) as { task: { id: string } };

  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/crm/tasks?view=all`, origin).toString());
  const drag = async (to: string) => {
    const from = (await page
      .getByRole("listitem")
      .filter({ hasText: "Call the client" })
      .boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 3 });
    const target = (await page.getByRole("region", { name: to, exact: true }).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height - 8, { steps: 8 });
    await page.mouse.up();
  };

  await page.getByRole("region", { name: "No due date" }).getByText("Call the client").waitFor();
  await drag("Today");
  await page.getByRole("region", { name: "Today" }).getByText("Call the client").waitFor();
  const endOfToday = await page.evaluate(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
  });
  await expect
    .poll(async () => (await row(task.id))?.dueAt?.getTime() ?? null, { timeout: 10_000 })
    .toBe(endOfToday);

  await drag("No due date");
  await expect.poll(async () => (await row(task.id))?.dueAt, { timeout: 10_000 }).toBeNull();
  await context.close();
});

test("New › Task starts on the record whose page it is, and from the task list asks for the record first", async () => {
  const origin = String(worker.url);
  const org = await createOrg(db, "create-task");
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `create-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  const made = await fetch(new URL("/api/crm/deals", origin), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json", "omni-workspace": org.id },
    body: JSON.stringify({ name: "Rooftop shoot" }),
  });
  const { deal } = (await made.json()) as { deal: { id: string } };

  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  const create = async (title: string) => {
    const dialog = page.getByRole("dialog", { name: "New task" });
    await dialog.getByRole("textbox", { name: "Title" }).fill(title);
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect.poll(async () => (await taskTitled(title))?.dealId ?? null).toBe(deal.id);
  };

  await page.goto(new URL(`/${org.slug}/crm/deals/${deal.id}`, origin).toString());
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Task" }).click();
  await page.getByRole("dialog", { name: "New task" }).getByText("Rooftop shoot").waitFor();
  await create("Scout the roof");

  await page.goto(new URL(`/${org.slug}/crm/tasks`, origin).toString());
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "Task" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a record" });
  await picker.getByRole("option", { name: "Rooftop shoot" }).click();
  await create("Book the drone");
  await context.close();
});

async function taskTitled(title: string) {
  const [found] = await db.select().from(schema.crmTasks).where(eq(schema.crmTasks.title, title));
  return found;
}

async function row(id: string) {
  const [found] = await db.select().from(schema.crmTasks).where(eq(schema.crmTasks.id, id));
  return found;
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
