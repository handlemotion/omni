import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync } from "node:zlib";
import { schema } from "@omni/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
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

test("a folder of 200 photos draws from thumbnails alone, under 10 MB, and never downloads an original", async () => {
  const person = await account(`photos-${Date.now()}@gmail.test`);
  const folder = await person.folder("Shoot");
  let originals = 0;
  for (let i = 0; i < 200; i++) {
    const png = photoPng(900, i);
    originals += png.length;
    await person.upload({ parentId: folder }, `photo-${String(i).padStart(3, "0")}.png`, png);
  }
  expect(originals).toBeGreaterThan(10 * 1024 * 1024);

  const page = await person.page(`/files/my/${folder}`);
  const thumbnails = new Map<string, number>();
  const contents: string[] = [];
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (path.endsWith("/content")) contents.push(path);
    if (!path.endsWith("/thumbnail")) return;
    thumbnails.set(path, (await response.body().catch(() => Buffer.alloc(0))).length);
  });
  await page.getByRole("row", { name: /photo-000\.png/ }).waitFor({ timeout: 30_000 });
  await scrollToEnd(page, () => thumbnails.size >= 200);

  const bytes = [...thumbnails.values()].reduce((sum, n) => sum + n, 0);
  expect(thumbnails.size).toBe(200);
  expect(bytes).toBeLessThan(10 * 1024 * 1024);
  expect(contents).toEqual([]);
});

test("picking 50 items with the keyboard and trashing them sends one request each and empties the folder", async () => {
  const person = await account(`bulk-${Date.now()}@gmail.test`);
  const folder = await person.folder("Old");
  for (let i = 0; i < 50; i++) {
    await person.upload({ parentId: folder }, `note-${String(i).padStart(2, "0")}.txt`, "x");
  }
  const page = await person.page(`/files/my/${folder}`);
  const trashed: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE") trashed.push(request.url());
  });
  const first = page.getByRole("row", { name: /note-00\.txt/ });
  await first.waitFor({ timeout: 30_000 });
  await first.click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Move to trash", exact: true }).click();

  await page
    .getByRole("row", { name: /note-\d\d\.txt/ })
    .first()
    .waitFor({ state: "detached" });
  expect(trashed).toHaveLength(50);
  const gone = () =>
    db
      .select({ id: schema.storageNodes.id })
      .from(schema.storageNodes)
      .where(
        and(eq(schema.storageNodes.parentId, folder), isNotNull(schema.storageNodes.trashedAt)),
      );
  await expect.poll(async () => (await gone()).length, { timeout: 10_000 }).toBe(50);
});

test("a file added from elsewhere shows in an open folder within 2 s, refetching only that folder", async () => {
  const person = await account(`live-${Date.now()}@gmail.test`);
  const watched = await person.folder("Watched");
  const other = await person.folder("Other", await person.folder("Archive"));
  const page = await person.page(`/files/my/${watched}`);
  await page.getByText("This folder is empty").waitFor({ timeout: 30_000 });
  const listed: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/storage/nodes") listed.push(url.searchParams.get("parent") ?? "");
  });
  await page.waitForTimeout(500);

  await person.upload({ parentId: other }, "elsewhere.txt", "not here");
  await person.upload({ parentId: watched }, "arrived.txt", "here");
  await page.getByRole("row", { name: /arrived\.txt/ }).waitFor({ timeout: 2_000 });
  expect(listed).not.toContain(other);
  expect(listed).toContain(watched);
  const rows = await db
    .select({ name: schema.storageNodes.name })
    .from(schema.storageNodes)
    .where(inArray(schema.storageNodes.parentId, [watched]));
  expect(rows.map((r) => r.name)).toEqual(["arrived.txt"]);
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

async function scrollToEnd(page: Page, done: () => boolean) {
  for (let step = 0; step < 200 && !done(); step++) {
    await page.mouse.move(600, 400);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(500);
}

function photoPng(side: number, seed: number) {
  const row = 1 + side * 3;
  const raw = Buffer.alloc(row * side);
  let noise = seed + 1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      noise = (noise * 1103515245 + 12345) & 0x7fffffff;
      const at = y * row + 1 + x * 3;
      raw[at] = ((x * 255) / side + (noise & 15)) & 255;
      raw[at + 1] = ((y * 255) / side + ((noise >> 4) & 15)) & 255;
      raw[at + 2] = (seed * 7) & 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
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
