import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
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
const SHOTS = process.env.OMNI_E2E_SHOTS;
const contexts: BrowserContext[] = [];
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

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

test("a new contract takes its title from the uploaded PDF and its dates from the calendar", async () => {
  const team = await workspace("contract-new");
  const { deal } = await team.api("POST", "/deals", { name: "Website rebuild" });
  const page = await team.page(`/crm/deals/${deal.id}`);
  await page.getByRole("tab", { name: "Contracts" }).click();
  await page.getByText("No contracts yet").waitFor();
  await page.mouse.move(0, 0);
  if (SHOTS) await page.waitForTimeout(600);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/contracts-empty.png` });

  await page.getByRole("button", { name: "New contract" }).click();
  const dialog = page.getByRole("dialog", { name: "New contract" });
  await dialog.getByRole("button", { name: "Upload PDF" }).waitFor();
  expect(await dialog.getByRole("combobox").count()).toBe(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-contract-empty.png` });

  const chooser = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Upload PDF" }).click();
  await (
    await chooser
  ).setFiles({
    name: "Master services agreement.pdf",
    mimeType: "application/pdf",
    buffer: PDF,
  });
  const title = dialog.getByRole("textbox", { name: "Title" });
  await expect
    .poll(() => title.inputValue(), { timeout: 15_000 })
    .toBe("Master services agreement");

  await pickDay(page, "Starts", []);
  await pickDay(page, "Ends", ["ArrowLeft"]);
  const create = dialog.getByRole("button", { name: "Create draft" });
  expect(await create.isDisabled()).toBe(true);
  await pickDay(page, "Ends", ["ArrowRight", "ArrowRight"]);
  expect(await create.isDisabled()).toBe(false);
  await title.fill("MSA 2027");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-contract-filled.png` });
  await create.click();
  await page.getByText("MSA 2027").waitFor();

  const { contracts } = await team.api("GET", `/contracts?deal=${deal.id}`);
  expect(contracts).toHaveLength(1);
  expect(contracts[0]).toMatchObject({
    title: "MSA 2027",
    effectiveOn: day(0),
    expiresOn: day(1),
  });
  expect(contracts[0].documentNodeId).toBeTruthy();
});

test("a deal's People + opens a search of the workspace's people and adds the one chosen", async () => {
  const team = await workspace("deal-people");
  await team.api("POST", "/people", { name: "Paola Pacheco", address: "paola@up.test" });
  await team.api("POST", "/people", { name: "Rita Ramos", address: "rita@up.test" });
  const { deal } = await team.api("POST", "/deals", { name: "Supplier registration" });
  const page = await team.page(`/crm/deals/${deal.id}`);

  await page.getByRole("button", { name: "Add person" }).click();
  const options = page.getByRole("option");
  await expect.poll(() => names(options)).toEqual(["Paola Pacheco", "Rita Ramos"]);
  await page.getByRole("combobox", { name: "Search people" }).fill("rit");
  await expect.poll(() => names(options)).toEqual(["Rita Ramos"]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/add-person-picker.png` });
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      (await team.api("GET", `/deals/${deal.id}`)).people.map((p: { name: string }) => p.name),
    )
    .toEqual(["Rita Ramos"]);
  await page.getByRole("complementary", { name: "Details" }).getByText("Rita Ramos").waitFor();

  await page.getByRole("button", { name: "Add person" }).click();
  await expect.poll(() => names(options)).toEqual(["Paola Pacheco"]);
});

async function names(options: Locator) {
  return (await options.allInnerTexts()).map((text) => text.split("\n").at(-1));
}

async function pickDay(page: Page, label: string, keys: string[]) {
  await page.getByRole("group", { name: label }).getByRole("button").first().click();
  const grid = page.getByRole("grid");
  await grid.waitFor();
  for (const key of keys) await page.keyboard.press(key);
  await page.keyboard.press("Enter");
  await grid.waitFor({ state: "detached" });
}

function day(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
      const context = await browser.newContext({
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: SHOTS ? 2 : 1,
      });
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
