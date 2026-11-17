import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
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
let context: BrowserContext | undefined;

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
      S2_BASIN_URL: "http://127.0.0.1:8090/v1",
      S2_BASIN: "omni-docs-dev",
    },
  });
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("two editors on one Markdown file see each other's typing, and the page is saved", async () => {
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, `live-${Date.now()}@gmail.test`);
  context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await context.newPage();
  await ana.goto(new URL("/files/my", origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes\n\nStart\n"),
    });
  await ana.getByRole("row", { name: /notes\.md/ }).click();
  const bo = await context.newPage();
  await bo.goto(ana.url());

  await Promise.all([edit(ana), edit(bo)]);
  for (const page of [ana, bo]) {
    await page.locator("[contenteditable=true]").getByText("Start").waitFor({ timeout: 15_000 });
  }

  await typeAtEnd(ana, "From Ana");
  await expect.poll(() => pageText(bo), { timeout: 15_000 }).toContain("From Ana");
  await typeAtEnd(bo, "From Bo");
  await expect.poll(() => pageText(ana), { timeout: 15_000 }).toContain("From Bo");
  for (const page of [ana, bo]) {
    expect((await pageText(page)).match(/Start/g)).toHaveLength(1);
  }

  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  await expect
    .poll(
      () =>
        ana.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`),
      { timeout: 20_000 },
    )
    .toMatch(/^# Notes\n\nStart\n\nFrom Ana\n\nFrom Bo\n*$/);
});

async function edit(page: Page) {
  await page.getByRole("button", { name: "Edit" }).click();
}

const pageText = (page: Page) => page.locator("[contenteditable=true]").innerText();

async function typeAtEnd(page: Page, text: string) {
  await page.locator("[contenteditable=true]").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dom = document.querySelector(".ProseMirror") as
          | (Element & {
              editor?: {
                state: { selection: { from: number }; doc: { content: { size: number } } };
              };
            })
          | null;
        const state = dom?.editor?.state;
        return state ? state.doc.content.size - state.selection.from : -1;
      }),
    )
    .toBe(1);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  }) satisfies Promise<number>;
}
