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

test("checking a task off in the list completes it, and an old link to its page opens it beside the list", async () => {
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
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(task.id);
  expect(new URL(page.url()).pathname).toBe(`/${org.slug}/crm/tasks`);
  await page.getByRole("textbox", { name: "Description" }).fill("Ask for the Q1 budget.");
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
  await panel.getByRole("textbox", { name: "Description" }).fill("Ask about parking.");
  await page.getByRole("link", { name: "Book the crew" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBe(second);
  await expect
    .poll(() => panel.getByRole("textbox", { name: "Title" }).inputValue())
    .toBe("Book the crew");
  await expect.poll(async () => (await row(first))?.body ?? null).toBe("Ask about parking.");
  expect((await row(second))?.body ?? null).toBeNull();

  await page.getByRole("heading", { name: "Tasks", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => new URL(page.url()).searchParams.get("task")).toBeNull();
  await expect.poll(() => panel.count()).toBe(0);
  await context.close();
});

test("subtasks added quickly in the panel all save in order, check off, and a cleared one is removed", async () => {
  const { page, org, context, headers } = await signedIn("subtasks");
  const made = await fetch(new URL("/api/crm/tasks", origin()), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Plan the shoot" }),
  });
  const { task } = (await made.json()) as { task: { id: string } };
  await page.goto(new URL(`/${org.slug}/crm/tasks?task=${task.id}`, origin()).toString());
  const panel = page.getByRole("region", { name: "Task" });
  const add = panel.getByRole("textbox", { name: "New subtask" });
  for (const title of ["Scout", "Permits", "Crew", "Drone"]) {
    await add.fill(title);
    await add.press("Enter");
  }
  await expect
    .poll(async () => (await row(task.id))?.subtasks.map((s) => s.title))
    .toEqual(["Scout", "Permits", "Crew", "Drone"]);
  const fromElsewhere = (await row(task.id))!.subtasks.map((s) =>
    s.title === "Drone" ? { ...s, title: "Drone shots" } : s,
  );
  await fetch(new URL(`/api/crm/tasks/${task.id}`, origin()), {
    method: "PATCH",
    headers,
    body: JSON.stringify({ subtasks: fromElsewhere }),
  });
  await panel.getByRole("checkbox", { name: "Complete Drone shots" }).waitFor();

  await panel.getByRole("checkbox", { name: "Complete Scout" }).click({ force: true });
  await expect
    .poll(async () => (await row(task.id))?.subtasks.map((s) => s.done))
    .toEqual([true, false, false, false]);
  expect((await row(task.id))?.completedAt).toBeNull();

  await panel.getByRole("textbox", { name: "Subtask" }).nth(1).fill("");
  await panel.getByRole("checkbox", { name: "Complete" }).first().focus();
  await expect
    .poll(async () => (await row(task.id))?.subtasks.map((s) => s.title))
    .toEqual(["Scout", "Crew", "Drone shots"]);

  await page.reload();
  await panel.getByRole("checkbox", { name: "Complete Scout" }).waitFor();
  expect(await panel.getByRole("checkbox", { name: "Complete Scout" }).isChecked()).toBe(true);
  await context.close();
});

test("a subtask added just before switching tasks is kept when the next one is added", async () => {
  const { page, org, context, headers } = await signedIn("subtask-switch");
  const make = async (title: string) => {
    const made = await fetch(new URL("/api/crm/tasks", origin()), {
      method: "POST",
      headers,
      body: JSON.stringify({ title }),
    });
    return ((await made.json()) as { task: { id: string } }).task.id;
  };
  const first = await make("Light the set");
  await make("Book the van");
  await page.route(`**/api/crm/tasks/${first}`, async (route) => {
    if (route.request().method() === "PATCH") await new Promise((done) => setTimeout(done, 1500));
    await route.continue();
  });
  await page.goto(new URL(`/${org.slug}/crm/tasks?task=${first}`, origin()).toString());
  const panel = page.getByRole("region", { name: "Task" });
  const add = panel.getByRole("textbox", { name: "New subtask" });
  await add.fill("Key light");
  await add.press("Enter");
  await page.getByRole("link", { name: "Book the van" }).click();
  await expect
    .poll(() => panel.getByRole("textbox", { name: "Title" }).inputValue())
    .toBe("Book the van");
  await page.getByRole("link", { name: "Light the set" }).click();
  await expect
    .poll(() => panel.getByRole("textbox", { name: "Title" }).inputValue())
    .toBe("Light the set");
  await add.fill("Fill light");
  await add.press("Enter");
  await expect
    .poll(async () => (await row(first))?.subtasks.map((s) => s.title), { timeout: 10_000 })
    .toEqual(["Key light", "Fill light"]);
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

test("an old ?view=done link becomes filters that Status › Open can change", async () => {
  const { page, org, context } = await signedIn("legacy-view");
  await page.goto(new URL(`/${org.slug}/crm/tasks?view=done`, origin()).toString());
  await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe("done");
  expect(new URL(page.url()).searchParams.get("view")).toBeNull();
  expect(new URL(page.url()).searchParams.get("assignee")).toBe("anyone");

  await page.getByRole("button", { name: "Filter", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Status/ }).click();
  await page.getByRole("menuitemradio", { name: "Open" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBeNull();
  expect(new URL(page.url()).searchParams.get("assignee")).toBe("anyone");
  await context.close();
});

test("opening a task far down the list keeps the list where it was scrolled", async () => {
  const { page, org, context, headers } = await signedIn("scroll");
  for (let i = 1; i <= 40; i++) {
    await fetch(new URL("/api/crm/tasks", origin()), {
      method: "POST",
      headers,
      body: JSON.stringify({ title: `Shot ${String(i).padStart(2, "0")}` }),
    });
  }
  await page.goto(new URL(`/${org.slug}/crm/tasks`, origin()).toString());
  const last = page.getByRole("link", { name: "Shot 40" });
  await last.scrollIntoViewIfNeeded();
  const scrolled = () =>
    last.evaluate((el) => {
      let node: Element | null = el;
      while (node && node.scrollHeight <= node.clientHeight) node = node.parentElement;
      return node?.scrollTop ?? 0;
    });
  const before = await scrolled();
  expect(before).toBeGreaterThan(0);
  await last.click();
  await page
    .getByRole("region", { name: "Task" })
    .getByRole("textbox", { name: "Title" })
    .waitFor();
  expect(await scrolled()).toBe(before);
  await context.close();
});

test("in a window too narrow for both, the task takes the whole screen, and sits beside the list when wide", async () => {
  const { page, org, context, headers } = await signedIn("narrow");
  const made = await fetch(new URL("/api/crm/tasks", origin()), {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Pack the lenses" }),
  });
  const { task } = (await made.json()) as { task: { id: string } };
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto(
    new URL(`/${org.slug}/crm/tasks?assignee=anyone&task=${task.id}`, origin()).toString(),
  );
  const panel = page.getByRole("region", { name: "Task", exact: true });
  const list = page.getByRole("heading", { name: "Tasks", exact: true });
  await expect
    .poll(() => panel.getByRole("textbox", { name: "Title" }).inputValue(), { timeout: 10_000 })
    .toBe("Pack the lenses");
  await expect.poll(() => list.isVisible()).toBe(false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => list.isVisible()).toBe(true);
  expect(await panel.isVisible()).toBe(true);
  await context.close();
});

async function signedIn(slug: string) {
  const org = await createOrg(db, slug);
  await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
  const email = `${slug}-${Date.now()}@studio.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const cookie = await signIn({ url: new URL(origin()) }, db, email);
  const headers = {
    cookie,
    origin: origin(),
    "content-type": "application/json",
    "omni-workspace": org.id,
  };
  const context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin() };
    }),
  );
  return { org, headers, context, page: await context.newPage() };
}

function origin() {
  return String(worker.url);
}

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
