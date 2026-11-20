import { randomBytes } from "node:crypto";
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

const LARGE = 20 * 1024 * 1024;

test("a deal's Files tab uploads a large file into the deal's folder, previews it, links a Drive file in place and removes the link without touching the file", async () => {
  const org = await createOrg(db, "acme");
  await createMailbox(db, org.id, `hello-${Date.now()}@acme.test`);
  const member = await createMember(db, org.id, `owner-${Date.now()}@acme.test`);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
  const { page, api } = await signedIn(member.id, org.id, org.slug);

  const deal = await api("POST", "/api/crm/deals", { name: "Website rebuild" });
  const briefs = await api("POST", "/api/storage/folders", { space: "shared", name: "Briefs" });
  await page.goto(new URL(`/${org.slug}/files/shared/${briefs.node.id}`, worker.url).toString());
  await page.getByRole("button", { name: "Upload", exact: true }).first().waitFor();
  await page
    .locator("input[type=file]:not([webkitdirectory])")
    .first()
    .setInputFiles({
      name: "brief.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%%EOF\n"),
    });
  await page.getByRole("row", { name: /brief\.pdf/ }).waitFor({ timeout: 30_000 });

  await page.goto(new URL(`/${org.slug}/crm/deals/${deal.deal.id}`, worker.url).toString());
  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: "Add from Drive" }).waitFor();
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "footage.mp4", mimeType: "video/mp4", buffer: randomBytes(LARGE) });
  await page.getByRole("row", { name: /footage\.mp4/ }).waitFor({ timeout: 60_000 });
  const [folder] = await db
    .select({ id: schema.crmDeals.folderNodeId })
    .from(schema.crmDeals)
    .where(eq(schema.crmDeals.id, deal.deal.id));
  const [footage] = await db
    .select()
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.name, "footage.mp4"));
  expect([footage?.parentId, footage?.size]).toEqual([folder?.id, LARGE]);

  await page.getByRole("row", { name: /footage\.mp4/ }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe(footage?.id);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Add from Drive" }).click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("searchbox").fill("brief");
  await picker.getByRole("row", { name: /brief\.pdf/ }).click();
  await picker.getByRole("button", { name: "Add", exact: true }).click();
  await picker.waitFor({ state: "hidden" });
  const linked = page.getByRole("row", { name: /brief\.pdf/ });
  await linked.waitFor();

  const pdf = async () =>
    (await api("GET", `/api/storage/search?q=brief.pdf`)).nodes as {
      parentId: string;
      trashedAt: string | null;
    }[];
  expect((await pdf()).map((node) => node.parentId)).toEqual([briefs.node.id]);

  await linked.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Website rebuild" }).click();
  await linked.waitFor({ state: "hidden" });
  expect((await pdf()).map((node) => [node.parentId, node.trashedAt])).toEqual([
    [briefs.node.id, null],
  ]);
  const links = await api("GET", `/api/crm/deals/${deal.deal.id}/links`);
  expect(links.links).toEqual([]);
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
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page: Page = await context.newPage();
  await page.goto(new URL(`/${slug}/crm`, origin).toString());
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
