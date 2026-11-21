import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schema } from "@omni/db";
import { and, eq, inArray } from "drizzle-orm";
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

const PART = 16 * 1024 * 1024;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;
let context: BrowserContext | undefined;
let scratch: string;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
  });
  const system = await createOrg(db, "system");
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  scratch = await mkdtemp(join(tmpdir(), "omni-uploads-"));
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

const UPLOAD_REQUEST = String.raw`/api/storage/(uploads|folders|files/[^/]+/versions)`;

function watch(page: Page) {
  const seen = { me: 0, lists: 0, parts: [] as string[] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/me") seen.me += 1;
    if (url.pathname === "/api/storage/nodes" && request.method() === "GET") seen.lists += 1;
    if (request.method() === "PUT") seen.parts.push(url.pathname.split("/parts/")[1] ?? "");
  });
  const reset = () => {
    seen.me = 0;
    seen.lists = 0;
    seen.parts = [];
  };
  return { seen, reset };
}

const MOST_IN_FLIGHT = (pattern: string) => {
  const uploads = new RegExp(pattern);
  const edges = performance
    .getEntriesByType("resource")
    .filter((entry) => uploads.test(entry.name))
    .flatMap((entry) => {
      const { startTime, responseEnd } = entry as PerformanceResourceTiming;
      return [
        { at: startTime, step: 1 },
        { at: responseEnd, step: -1 },
      ];
    })
    .toSorted((x, y) => x.at - y.at || x.step - y.step);
  let open = 0;
  let most = 0;
  for (const edge of edges) {
    open += edge.step;
    most = Math.max(most, open);
  }
  return { most, requests: edges.length / 2 };
};

const fileRows = (names: string[]) =>
  db
    .select({ name: schema.storageNodes.name, size: schema.storageNodes.size })
    .from(schema.storageNodes)
    .where(and(inArray(schema.storageNodes.name, names), eq(schema.storageNodes.kind, "file")));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const uploadReady = (page: Page) =>
  page.getByRole("button", { name: "Upload", exact: true }).first().waitFor({ timeout: 15_000 });

test("500 small files upload with at most 6 requests open at once and one listing refetch", async () => {
  const page = await signedIn(`many-${Date.now()}@gmail.test`, "/files/my");
  await uploadReady(page);
  await page.waitForLoadState("networkidle");
  const { seen, reset } = watch(page);
  reset();
  const tag = `many${Date.now()}`;
  const names = Array.from({ length: 500 }, (_, i) => `${tag}-${String(i).padStart(3, "0")}.txt`);
  await page
    .locator("input[type=file]:not([webkitdirectory])")
    .first()
    .setInputFiles(
      names.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from(name) })),
    );

  const rows = await until(
    () => fileRows(names),
    (found) => found.length === 500,
    240_000,
  );
  expect(rows).toHaveLength(500);
  await page
    .getByRole("row", { name: new RegExp(`${tag}-499\\.txt`) })
    .waitFor({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");

  const { most, requests } = await page.evaluate(MOST_IN_FLIGHT, UPLOAD_REQUEST);
  expect(requests).toBeGreaterThanOrEqual(1500);
  expect(most).toBeGreaterThan(1);
  expect(most).toBeLessThanOrEqual(6);
  expect(seen.me).toBe(1);
  expect(seen.lists).toBeLessThanOrEqual(2);
});

test("a folder tree picked or dropped is made again, empty folders too, files in place", async () => {
  const page = await signedIn(`tree-${Date.now()}@gmail.test`, "/files/my");
  await uploadReady(page);
  const tag = `tree${Date.now()}`;
  const root = join(scratch, tag);
  await mkdir(join(root, "photos", "2026"), { recursive: true });
  await mkdir(join(root, "empty"), { recursive: true });
  await writeFile(join(root, "readme.txt"), "top");
  await writeFile(join(root, "photos", "a.txt"), "a");
  await writeFile(join(root, "photos", "2026", "b.txt"), "bb");

  const box = await page.locator("main").first().boundingBox();
  if (!box) throw new Error("no drop target");
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [root], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await cdp.send("Input.dispatchDragEvent", { type, ...at, data });
  }

  const tree = await until(
    () => treeUnder(tag),
    (found) => found.length === 7,
    60_000,
  );
  expect(tree.toSorted()).toEqual(
    [
      `${tag}/`,
      `${tag}/empty/`,
      `${tag}/photos/`,
      `${tag}/photos/2026/`,
      `${tag}/photos/2026/b.txt:2`,
      `${tag}/photos/a.txt:1`,
      `${tag}/readme.txt:3`,
    ].toSorted(),
  );

  await page.locator("input[type=file][webkitdirectory]").first().setInputFiles(root);
  const picked = await until(
    () => treeUnder(`${tag} (1)`),
    (found) => found.length === 6,
    60_000,
  );
  expect(picked.toSorted()).toEqual(
    [
      `${tag} (1)/`,
      `${tag} (1)/photos/`,
      `${tag} (1)/photos/2026/`,
      `${tag} (1)/photos/2026/b.txt:2`,
      `${tag} (1)/photos/a.txt:1`,
      `${tag} (1)/readme.txt:3`,
    ].toSorted(),
  );
});

test("after a reload, picking the same file again sends only the parts the server lacks", async () => {
  const page = await signedIn(`resume-${Date.now()}@gmail.test`, "/files/my");
  await uploadReady(page);
  const name = `resume${Date.now()}.bin`;
  const path = join(scratch, name);
  await writeFile(path, randomBytes(2 * PART + 1234));
  await utimes(path, new Date("2026-01-01"), new Date("2026-01-01"));

  const { seen } = watch(page);
  const sentTwo = new Promise<void>((resolve) => {
    let done = 0;
    page.on("requestfinished", (request) => {
      if (request.method() === "PUT" && /\/parts\/[12]$/.test(request.url()) && ++done === 2)
        resolve();
    });
  });
  await page.route("**/parts/3", () => {});
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(path);
  await sentTwo;

  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await uploadReady(page);
  seen.parts = [];
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(path);
  await page.getByRole("row", { name: new RegExp(name.replace(".", "\\.")) }).waitFor({
    timeout: 60_000,
  });
  expect(seen.parts).toEqual(["3"]);
  expect(await fileRows([name])).toEqual([{ name, size: 2 * PART + 1234 }]);
});

test("an upload that loses the network for 30 s finishes on its own once it is back", async () => {
  const page = await signedIn(`offline-${Date.now()}@gmail.test`, "/files/my");
  await uploadReady(page);
  const name = `offline${Date.now()}.bin`;
  const size = 3 * PART;
  let held = false;
  const firstDone = new Promise<void>((resolve) => {
    page.on("requestfinished", (request) => {
      if (request.method() === "PUT" && request.url().endsWith("/parts/1")) resolve();
    });
  });
  await page.route(/\/parts\/[23]$/, async (route) => {
    if (!held) await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue().catch(() => route.abort("internetdisconnected"));
  });
  await page
    .locator("input[type=file]:not([webkitdirectory])")
    .first()
    .setInputFiles({ name, mimeType: "application/octet-stream", buffer: randomBytes(size) });
  await firstDone;
  await page.context().setOffline(true);
  await page.waitForTimeout(30_000);
  held = true;
  expect(await fileRows([name])).toEqual([]);
  await page.context().setOffline(false);

  await page.getByRole("row", { name: new RegExp(name.replace(".", "\\.")) }).waitFor({
    timeout: 90_000,
  });
  expect(await fileRows([name])).toEqual([{ name, size }]);
});

async function treeUnder(top: string) {
  const [root] = await db
    .select()
    .from(schema.storageNodes)
    .where(and(eq(schema.storageNodes.name, top), eq(schema.storageNodes.kind, "folder")));
  if (!root) return [];
  const out = [`${top}/`];
  const walk = async (id: string, path: string) => {
    const children = await db
      .select()
      .from(schema.storageNodes)
      .where(eq(schema.storageNodes.parentId, id));
    for (const child of children) {
      const at = `${path}/${child.name}`;
      if (child.kind === "folder") {
        out.push(`${at}/`);
        await walk(child.id, at);
      } else out.push(`${at}:${child.size}`);
    }
  };
  await walk(root.id, top);
  return out;
}

async function signedIn(email: string, path: string) {
  const origin = String(worker.url);
  const cookie = await signInWithPersonalSpace({ url: new URL(origin) }, db, email);
  await context?.close();
  context = await browser.newContext();
  await context.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL(path, origin).toString());
  return page;
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
