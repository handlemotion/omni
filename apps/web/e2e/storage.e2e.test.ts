// Storage in the web app (ADR 0034 step 6), in a real Chromium, on the web app built and served by
// the real Worker under `wrangler dev` (its local R2), on a real Postgres: a file larger than one
// part goes up through the page's own file input and comes back byte for byte, and a link open to
// anyone downloads it for someone signed out.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOrgWithOwner, schema } from "@omni/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
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

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Catches: the browser's upload client cutting parts wrong (an off-by-one slice, a last part of
// the wrong length, a part skipped when several go at once), so a file over one part never
// completes or downloads corrupted.
test("a file larger than one part uploads from the page and downloads byte for byte", async () => {
  const page = await signedIn(`files-${Date.now()}@gmail.test`, "/files/my");

  // Two full parts and a short third: 16 MiB, 16 MiB, 1234 bytes.
  const bytes = randomBytes(2 * 16 * 1024 * 1024 + 1234);
  const parts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT") parts.push(request.url().split("/parts/")[1] ?? "");
  });
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "footage.bin", mimeType: "application/octet-stream", buffer: bytes });
  await page.getByRole("row", { name: /footage\.bin/ }).waitFor({ timeout: 60_000 });
  expect(parts.toSorted()).toEqual(["1", "2", "3"]);

  await page.getByRole("button", { name: "Actions for footage.bin" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("footage.bin");
  const saved = await readFile(await download.path());
  expect(saved.byteLength).toBe(bytes.byteLength);
  expect(sha256(saved)).toBe(sha256(bytes));
}, 120_000);

// Catches: the link page reaching for a session (the member routes, a sign-in redirect) or
// downloading through the member's door, so a link open to anyone fails for the people it is for.
test("a link open to anyone downloads its file, byte for byte, for someone signed out", async () => {
  const page = await signedIn(`link-${Date.now()}@gmail.test`, "/files/my");
  const bytes = randomBytes(300_000);
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: bytes });
  await page.getByRole("row", { name: /brief\.pdf/ }).waitFor({ timeout: 30_000 });

  await page.getByRole("button", { name: "Actions for brief.pdf" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "General access" }).click();
  await page.getByRole("option", { name: "Anyone with the link" }).click();
  const link = await dialog.getByRole("textbox", { name: "Link" }).inputValue();
  expect(new URL(link).pathname).toMatch(/^\/s\/[\w-]{22}$/);

  const signedOut = await browser.newContext({ acceptDownloads: true });
  try {
    const anonymous = await signedOut.newPage();
    await anonymous.goto(link);
    const [download] = await Promise.all([
      anonymous.waitForEvent("download"),
      anonymous.getByRole("button", { name: "Download" }).click(),
    ]);
    expect(download.suggestedFilename()).toBe("brief.pdf");
    const saved = await readFile(await download.path());
    expect(sha256(saved)).toBe(sha256(bytes));
  } finally {
    await signedOut.close();
  }
}, 120_000);

// Catches: files queued in one workspace going up into another after a workspace switch (the
// queue lives outside React and outlived the session's reset), or an opened upload left holding
// room in the workspace that was left.
test("switching workspace mid-upload stops the queue and leaves nothing in either workspace", async () => {
  const email = `switch-${Date.now()}@acme-files.test`;
  const acme = await createOrgWithOwner(db, {
    name: "Acme Files",
    slug: `acme-files-${Date.now()}`,
    ownerEmail: email,
  });
  await db.insert(schema.orgSetup).values({ orgId: acme.orgId, step: "complete" });
  const page = await signedIn(email, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });

  // The first file's first part waits until the switch has begun, so the queue is mid-flight.
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/storage/uploads/*/parts/1", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  const names = ["one.bin", "two.bin", "three.bin"];
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(
      names.map((name) => ({
        name,
        mimeType: "application/octet-stream",
        buffer: randomBytes(4096),
      })),
    );
  await page.waitForRequest("**/api/storage/uploads/*/parts/1");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /^Workspace: Acme Files/ }).click();
  await page.getByRole("menuitem", { name: "Personal" }).click();
  await page.getByRole("button", { name: /^Workspace: Personal/ }).waitFor({ timeout: 15_000 });
  release();
  // Anything still going would have reached the server by now.
  await page.waitForTimeout(1500);

  const files = await db
    .select({ name: schema.storageNodes.name, orgId: schema.storageNodes.orgId })
    .from(schema.storageNodes)
    .where(inArray(schema.storageNodes.name, names));
  expect(files).toEqual([]);
  const open = await db
    .select({ name: schema.storageUploads.name })
    .from(schema.storageUploads)
    .where(and(eq(schema.storageUploads.orgId, acme.orgId), isNull(schema.storageUploads.nodeId)));
  expect(open).toEqual([]);
}, 120_000);

/** Signed in as `email` (a magic link, so a new address signs up), on `path`. */
async function signedIn(email: string, path: string) {
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, db, email);
  await context?.close();
  context = await browser.newContext({ acceptDownloads: true });
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
