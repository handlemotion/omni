import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createOrg,
  createTestDatabase,
  signInWithPersonalSpace,
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

test("a Drive tab is named after its space, then the folder, then the file open in it, and keeps the name behind another tab across a reload", async () => {
  const person = await account(`tab-names-${Date.now()}@gmail.test`);
  const folder = await person.folder("Episodes");
  await person.upload(folder, "notes.txt", "hello");
  const page = await person.page(await person.space());
  const tabs = page.getByRole("tablist", { name: "Open pages" }).getByRole("tab");
  await expect
    .poll(() => tabs.first().getAttribute("aria-label"), { timeout: 30_000 })
    .toBe("Studio");

  await page.getByRole("row", { name: /Episodes/ }).click();
  await expect
    .poll(() => tabs.first().getAttribute("aria-label"), { timeout: 10_000 })
    .toBe("Episodes");

  await page.getByRole("row", { name: /notes\.txt/ }).click();
  await expect
    .poll(() => tabs.first().getAttribute("aria-label"), { timeout: 10_000 })
    .toBe("notes.txt");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect
    .poll(() => tabs.first().getAttribute("aria-label"), { timeout: 10_000 })
    .toBe("Episodes");

  await page.getByRole("button", { name: "New tab" }).click();
  await expect
    .poll(() => tabs.last().getAttribute("aria-label"), { timeout: 10_000 })
    .toBe("Inbox");
  await page.reload();
  await tabs.last().waitFor({ timeout: 30_000 });
  expect(await tabs.first().getAttribute("aria-label")).toBe("Episodes");
});

const SPACE = "Studio";

async function account(email: string) {
  const origin = String(worker.url);
  const cookie = await signInWithPersonalSpace({ url: new URL(origin) }, db, email);
  const api = async (method: string, path: string, body?: unknown, raw?: Uint8Array) => {
    const response = await fetch(new URL(`/api/storage${path}`, origin), {
      method,
      headers: {
        cookie,
        origin,
        "content-type": raw ? "application/octet-stream" : "application/json",
      },
      body: raw ? new Blob([new Uint8Array(raw)]) : body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return (text ? JSON.parse(text) : null) as any;
  };
  let made: Promise<string> | undefined;
  const teamspace = () =>
    (made ??= api("POST", "/teamspaces", { name: SPACE, private: true }).then(
      (answer: { teamspace: { id: string } }) => answer.teamspace.id,
    ));
  return {
    async space() {
      return `/files/t/${encodeURIComponent(await teamspace())}`;
    },
    async folder(name: string) {
      return (await api("POST", "/folders", { name, teamspaceId: await teamspace() })).node
        .id as string;
    },
    async upload(parentId: string, name: string, content: string) {
      const bytes = new TextEncoder().encode(content);
      const { upload } = await api("POST", "/uploads", {
        name,
        size: bytes.length,
        mimeType: "text/plain",
        parentId,
      });
      for (let n = 1; n <= upload.partCount; n++) {
        const part = bytes.subarray((n - 1) * upload.partSize, n * upload.partSize);
        await api("PUT", `/uploads/${upload.id}/parts/${n}`, undefined, part);
      }
      return (await api("POST", `/uploads/${upload.id}/complete`)).node.id as string;
    },
    async page(path: string) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      contexts.push(context);
      await context.addCookies(
        cookie.split("; ").map((pair) => {
          const at = pair.indexOf("=");
          return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
        }),
      );
      const page = await context.newPage();
      await page.goto(new URL(path, origin).toString());
      return page;
    },
  };
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
