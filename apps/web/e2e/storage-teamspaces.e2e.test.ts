import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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
let context: BrowserContext | undefined;
const SHOTS = process.env.TEAMSPACE_SHOTS;

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

test("a member makes a private teamspace from the sidebar, files land in it, and a colleague outside it never sees it", async () => {
  const org = await createOrg(db, "teamspaces");
  await createMailbox(db, org.id, `hello-${Date.now()}@teamspaces.test`);
  const ana = await createMember(db, org.id, `ana-${Date.now()}@teamspaces.test`);
  const ben = await createMember(db, org.id, `ben-${Date.now()}@teamspaces.test`);
  const { page, api } = await signedIn(ana.id, org.id, org.slug);

  await page.getByText("No spaces yet", { exact: true }).waitFor({ timeout: 30_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/empty.png` });
  await page.getByRole("button", { name: "New space" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Legal");
  await dialog.getByRole("switch", { name: "Private" }).check({ force: true });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/new.png` });
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/files\/t\/[^/?]+/);
  const teamspaceId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1)!);

  await page.getByText("No files yet", { exact: true }).waitFor();
  await page
    .locator("input[type=file]:not([webkitdirectory])")
    .first()
    .setInputFiles({ name: "nda.txt", mimeType: "text/plain", buffer: Buffer.from("secret") });
  await page.getByRole("row", { name: /nda\.txt/ }).waitFor({ timeout: 30_000 });
  const [nda] = await db
    .select()
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.name, "nda.txt"));
  expect([nda?.space, nda?.teamspaceId]).toEqual(["teamspace", teamspaceId]);
  await expect.poll(() => page.getByRole("link", { name: "Legal" }).count()).toBeGreaterThan(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/teamspace.png` });

  await page.getByRole("link", { name: "Recents" }).click();
  await page
    .getByRole("row", { name: /nda\.txt/ })
    .getByText("Legal")
    .waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/recents.png` });
  await page.goBack();
  await page.getByRole("button", { name: "Space settings" }).click();
  await page.getByRole("dialog").getByText("Owner").waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings.png` });
  await page.keyboard.press("Escape");

  const other = await signedIn(ben.id, org.id, org.slug);
  await other.page.getByText("No spaces yet", { exact: true }).waitFor({ timeout: 30_000 });
  expect(await other.page.getByText("Legal").count()).toBe(0);
  const inside = await other.api("GET", `/api/storage/teamspaces`);
  expect(inside.teamspaces).toEqual([]);

  const design = await api("POST", "/api/storage/teamspaces", { name: "Design" });
  await other.page.reload();
  await other.page.getByText("Browse spaces", { exact: true }).click();
  if (SHOTS) await other.page.screenshot({ path: `${SHOTS}/browse.png` });
  await other.page.getByRole("dialog").getByRole("button", { name: "Join" }).click();
  await other.page.waitForURL(new RegExp(`/files/t/${design.teamspace.id}`));
  await expect
    .poll(() => other.page.getByRole("link", { name: "Design" }).count())
    .toBeGreaterThan(0);
  await expect.poll(() => other.page.getByText("Browse spaces", { exact: true }).count()).toBe(0);
});

test("a folder shared out of a private space shows in the recipient's Recents", async () => {
  const org = await createOrg(db, "shared-folders");
  await createMailbox(db, org.id, `hello-${Date.now()}@shared-folders.test`);
  const ana = await createMember(db, org.id, `ana-${Date.now()}@shared-folders.test`);
  const ben = await createMember(db, org.id, `ben-${Date.now()}@shared-folders.test`);
  const owner = await signedIn(ana.id, org.id, org.slug);
  const legal = await owner.api("POST", "/api/storage/teamspaces", {
    name: "Legal",
    private: true,
  });
  const folder = await owner.api("POST", "/api/storage/folders", {
    name: "Board pack",
    teamspaceId: legal.teamspace.id,
  });
  const [benUser] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .innerJoin(schema.members, eq(schema.members.userId, schema.users.id))
    .where(eq(schema.members.id, ben.id));
  await db
    .update(schema.users)
    .set({ emailVerified: true })
    .where(eq(schema.users.email, benUser?.email ?? ""));
  const email = encodeURIComponent(benUser?.email ?? "");
  await owner.api("PUT", `/api/storage/nodes/${folder.node.id}/sharing/people/${email}`, {
    role: "viewer",
  });

  const { page } = await signedIn(ben.id, org.id, org.slug);
  await page.getByRole("link", { name: "Recents" }).click();
  await page
    .getByRole("row", { name: /Board pack/ })
    .getByText("Shared with you")
    .waitFor({ timeout: 30_000 });
  expect(await page.getByRole("row", { name: /Board pack/ }).count()).toBe(1);
});

test("a deal made elsewhere shows its space in the open Drive sidebar", async () => {
  const org = await createOrg(db, "deal-spaces");
  await createMailbox(db, org.id, `hello-${Date.now()}@deal-spaces.test`);
  const ana = await createMember(db, org.id, `ana-${Date.now()}@deal-spaces.test`);
  const { page, api } = await signedIn(ana.id, org.id, org.slug);

  await page.getByText("No spaces yet", { exact: true }).waitFor({ timeout: 30_000 });
  await api("POST", "/api/crm/deals", { name: "Website rebuild" });
  await expect
    .poll(() => page.getByRole("link", { name: "Website rebuild" }).count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
});

async function signedIn(memberId: string, orgId: string, slug: string) {
  const origin = String(worker.url);
  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .innerJoin(schema.members, eq(schema.members.userId, schema.users.id))
    .where(eq(schema.members.id, memberId));
  if (!user) throw new Error("no such member");
  const cookie = await signIn({ url: new URL(origin) }, db, user.email);
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page: Page = await context.newPage();
  await page.goto(new URL(`/${slug}/files`, origin).toString());
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(new URL(path, origin), {
      method,
      headers: {
        cookie,
        "omni-workspace": orgId,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return (text ? JSON.parse(text) : null) as any;
  };
  return { page, api };
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
