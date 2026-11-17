// Drag and drop in Drive (`components/storage/node-drag.tsx`), in a real Chromium, on the web app
// built and served by the real Worker under `wrangler dev`, on a real Postgres: files and folders
// move by dragging them onto a folder, on the page and across to the sidebar.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
} from "../../worker/e2e/support.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;
let context: BrowserContext | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  const port = await freePort();
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
  });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

// Catches: a drop that does not move what was dragged, or moves it to the wrong place: a folder
// card's drop going to the page's own folder, a sidebar row not taking drags from the page (the
// two are separate drop targets), or a sidebar row dragging its link's address instead of its
// folder; and a folder offered a drop into a folder inside it.
test("files and folders move by dragging them onto folders on the page and in the sidebar", async () => {
  const page = await signedIn(`drag-${Date.now()}@gmail.test`, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  const photos = await folder(page, { name: "Photos", space: "personal" });
  const projects = await folder(page, { name: "Projects", space: "personal" });
  const drafts = await folder(page, { name: "Drafts", parentId: projects });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([
      { name: "sunset.png", mimeType: "image/png", buffer: Buffer.from("sunset") },
      { name: "forest.png", mimeType: "image/png", buffer: Buffer.from("forest") },
    ]);
  await page.getByRole("row", { name: /forest\.png/ }).waitFor({ timeout: 30_000 });
  const sidebar = (name: string) => page.getByRole("link", { name, exact: true });

  // A file's row onto a folder's card, both on the page.
  await drag(
    page,
    page.getByRole("row", { name: /sunset\.png/ }),
    page.getByRole("row", { name: /Photos/ }),
  );
  await expect.poll(() => names(page, { parent: photos })).toEqual(["sunset.png"]);

  // A file's row onto a folder in the sidebar.
  await drag(page, page.getByRole("row", { name: /forest\.png/ }), sidebar("Projects"));
  await expect.poll(() => names(page, { parent: projects })).toEqual(["Drafts", "forest.png"]);

  // A folder into a folder inside it is no drop: nothing moves.
  await page.getByRole("button", { name: "Expand Projects" }).click();
  await drag(page, page.getByRole("row", { name: /Projects/ }).first(), sidebar("Drafts"));
  expect(await names(page, { parent: drafts })).toEqual([]);

  // A sidebar folder onto another: Photos, with what is in it, into Projects.
  await drag(page, sidebar("Photos"), sidebar("Projects"));
  await expect
    .poll(() => names(page, { parent: projects }))
    .toEqual(["Drafts", "Photos", "forest.png"]);
  expect(await names(page, { space: "personal" })).toEqual(["Projects"]);
  expect(await names(page, { parent: photos })).toEqual(["sunset.png"]);
}, 120_000);

// Catches: the sidebar's folders not taking a keyboard drag (React Aria moves focus between drop
// targets, so a target that cannot take focus is skipped), leaving the page-to-sidebar move to
// the mouse alone.
test("a file moves to a sidebar folder with the keyboard", async () => {
  const page = await signedIn(`keys-${Date.now()}@gmail.test`, "/files/my");
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  const archive = await folder(page, { name: "Archive", space: "personal" });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await page.getByRole("row", { name: /notes\.txt/ }).waitFor({ timeout: 30_000 });
  await page.reload();
  const sidebar = page.getByRole("link", { name: "Archive", exact: true });
  await sidebar.waitFor();

  // The row's drag handle starts the drag; Tab walks the drop targets until the sidebar's folder.
  await page
    .getByRole("row", { name: /notes\.txt/ })
    .getByRole("button", { name: /drag/i })
    .focus();
  await page.keyboard.press("Enter");
  for (let i = 0; i < 20; i++) {
    if (await sidebar.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  expect(await sidebar.evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.press("Enter");
  await expect.poll(() => names(page, { parent: archive })).toEqual(["notes.txt"]);
}, 120_000);

/** Drags with the mouse, as a person does: pressed, moved past the threshold, held, let go. */
async function drag(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("nothing to drag, or nowhere to drop");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 });
  await page.mouse.up();
}

async function folder(
  page: Page,
  json: { name: string } & ({ space: string } | { parentId: string }),
) {
  const response = await page.request.post("/api/storage/folders", {
    data: json,
    headers: { origin: new URL(page.url()).origin },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { node: { id: string } }).node.id;
}

async function names(page: Page, where: { space: string } | { parent: string }) {
  const response = await page.request.get("/api/storage/nodes", {
    params: { ...where, limit: "100" },
  });
  return ((await response.json()) as { nodes: { name: string }[] }).nodes.map((n) => n.name);
}

async function signedIn(email: string, path: string) {
  const origin = String(worker.url);
  const cookie = await signIn({ url: new URL(origin) }, database.db, email);
  await context?.close();
  context = await browser.newContext({ baseURL: origin, viewport: { width: 1400, height: 900 } });
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
