import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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

async function rightClick(page: Page, x: number, y: number) {
  const claimed = await page.evaluate(
    ([px, py]) =>
      new Promise<boolean>((resolve) => {
        const target = document.elementFromPoint(px!, py!);
        window.addEventListener("contextmenu", (event) => resolve(event.defaultPrevented), {
          once: true,
        });
        target?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: px,
            clientY: py,
            button: 2,
          }),
        );
      }),
    [x, y],
  );
  return claimed;
}

async function beside(page: Page, name: RegExp) {
  const box = await page.getByRole("row", { name }).boundingBox();
  if (!box) throw new Error(`no row ${name}`);
  return { x: box.x + box.width + 120, y: box.y + 20 };
}

test("a right-click between a folder's items offers New folder, and it starts one there", async () => {
  const person = await account(`ctx-bg-${Date.now()}@gmail.test`);
  const folder = await person.folder("Pitch");
  await person.upload({ parentId: folder }, "notes.txt", "hello");
  const page = await person.page(`/files/my/${folder}`);
  await page.getByRole("row", { name: /notes\.txt/ }).waitFor({ timeout: 30_000 });

  const at = await beside(page, /notes\.txt/);
  expect(await rightClick(page, at.x, at.y)).toBe(true);
  const menu = page.getByRole("menu", { name: "Actions" });
  await menu.waitFor();
  await expect
    .poll(() => menu.getByRole("menuitem").allInnerTexts())
    .toEqual([
      "New folder",
      "New doc",
      "Upload files",
      "Upload folder",
      "Show as rows",
      "Select all",
    ]);
  await page.getByRole("menuitem", { name: "New folder" }).click();
  await page.getByRole("textbox", { name: "Folder name" }).waitFor();
  await page.keyboard.type("Drafts");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      (
        await db
          .select({ name: schema.storageNodes.name })
          .from(schema.storageNodes)
          .where(eq(schema.storageNodes.parentId, folder))
      )
        .map((n) => n.name)
        .toSorted(),
    )
    .toEqual(["Drafts", "notes.txt"]);
});

test("a right-click on a file opens its own actions, and Move to trash from it trashes it", async () => {
  const person = await account(`ctx-file-${Date.now()}@gmail.test`);
  const folder = await person.folder("Docs");
  const file = await person.upload({ parentId: folder }, "brief.txt", "brief");
  const page = await person.page(`/files/my/${folder}`);
  const row = page.getByRole("row", { name: /brief\.txt/ });
  await row.waitFor({ timeout: 30_000 });

  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for brief.txt" });
  await menu.getByRole("menuitem", { name: "Rename" }).waitFor();
  await menu.getByRole("menuitem", { name: "Move to trash" }).click();
  await row.waitFor({ state: "hidden" });
  await expect
    .poll(async () => {
      const [node] = await db
        .select({ trashedAt: schema.storageNodes.trashedAt })
        .from(schema.storageNodes)
        .where(eq(schema.storageNodes.id, file));
      return node?.trashedAt ?? null;
    })
    .not.toBeNull();
});

test("a sidebar folder's right-click offers its actions; a place with none shows no system menu", async () => {
  const person = await account(`ctx-side-${Date.now()}@gmail.test`);
  await person.folder("Clients");
  const page = await person.page("/files/my");
  const link = page.getByRole("link", { name: "Clients" }).first();
  await link.waitFor({ timeout: 30_000 });

  await link.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Clients" });
  await menu.waitFor();
  expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(
    expect.arrayContaining([
      "Open",
      "New folder",
      "New doc",
      "Upload files",
      "Share",
      "Move to trash",
    ]),
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });

  const header = await page.locator("header").last().boundingBox();
  if (!header) throw new Error("no header");
  expect(await rightClick(page, header.x + header.width / 2, header.y + header.height / 2)).toBe(
    true,
  );
  expect(await page.getByRole("menu").count()).toBe(0);
});

test("the sidebar's New folder on the space already open starts the folder there", async () => {
  const person = await account(`ctx-here-${Date.now()}@gmail.test`);
  await person.folder("Archive");
  const page = await person.page("/files/my");
  await page.getByRole("row", { name: /Archive/ }).waitFor({ timeout: 30_000 });

  await page.getByRole("link", { name: "Personal" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "New folder" }).click();
  const field = page.getByRole("textbox", { name: "Folder name" });
  await field.waitFor();
  expect(await field.evaluate((input) => input === document.activeElement)).toBe(true);
});

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
  return {
    async folder(name: string, parentId?: string) {
      const place = parentId ? { parentId } : { space: "personal" };
      return (await api("POST", "/folders", { name, ...place })).node.id as string;
    },
    async upload(place: { parentId: string }, name: string, content: string | Uint8Array) {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const mimeType = name.endsWith(".png") ? "image/png" : "text/plain";
      const { upload } = await api("POST", "/uploads", {
        name,
        size: bytes.length,
        mimeType,
        ...place,
      });
      for (let n = 1; n <= upload.partCount; n++) {
        const part = bytes.subarray((n - 1) * upload.partSize, n * upload.partSize);
        await api("PUT", `/uploads/${upload.id}/parts/${n}`, undefined, part);
      }
      return (await api("POST", `/uploads/${upload.id}/complete`)).node.id as string;
    },
    async page(path: string) {
      const context = await browser.newContext();
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
