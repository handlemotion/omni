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
const contexts: BrowserContext[] = [];
const LIVE = { timeout: 10_000 };

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
  for (const context of contexts) await context.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

test("what a colleague does to a space shows in an open Drive sidebar without a reload", async () => {
  const org = await createOrg(db, "live-drive");
  await createMailbox(db, org.id, `hello-${Date.now()}@live-drive.test`);
  const ana = await createMember(db, org.id, `ana-${Date.now()}@live-drive.test`);
  const ben = await createMember(db, org.id, `ben-${Date.now()}@live-drive.test`);
  const anaSide = await signedIn(ana.id, org.id, org.slug);
  const studio = await anaSide.api("POST", "/api/storage/teamspaces", {
    name: "Studio",
    memberIds: [ben.id],
  });
  const ts = studio.teamspace.id;
  const { page } = await signedIn(ben.id, org.id, org.slug);
  const row = (name: string) =>
    page.locator('a[data-slot="sidebar-item"]', { hasText: new RegExp(`^${name}$`) });
  await row("Studio").waitFor({ timeout: 30_000 });

  const brief = await anaSide.api("POST", "/api/storage/folders", {
    name: "Brief",
    teamspaceId: ts,
  });
  await row("Brief").waitFor(LIVE);

  const wrap = await anaSide.api("POST", "/api/storage/folders", { name: "Wrap", teamspaceId: ts });
  await anaSide.api("PATCH", `/api/storage/nodes/${brief.node.id}`, { parentId: wrap.node.id });
  await row("Wrap").click();
  await row("Brief").waitFor(LIVE);
  await anaSide.api("PATCH", `/api/storage/nodes/${brief.node.id}`, { teamspaceId: ts });
  await anaSide.api("PATCH", `/api/storage/nodes/${wrap.node.id}`, { name: "Wrapped" });
  await row("Wrapped").waitFor(LIVE);
  await anaSide.api("DELETE", `/api/storage/nodes/${wrap.node.id}`);
  await expect.poll(() => row("Wrapped").count(), LIVE).toBe(0);
  expect(await row("Brief").count()).toBe(1);

  await anaSide.api("PATCH", `/api/storage/teamspaces/${ts}`, { name: "Atelier" });
  await row("Atelier").waitFor(LIVE);

  const launch = await anaSide.api("POST", "/api/storage/teamspaces", { name: "Launch" });
  await anaSide.api("PUT", `/api/storage/teamspaces/${launch.teamspace.id}/members/${ben.id}`, {
    role: "member",
  });
  await row("Launch").waitFor(LIVE);
  await anaSide.api("DELETE", `/api/storage/teamspaces/${launch.teamspace.id}/members/${ben.id}`);
  await expect.poll(() => row("Launch").count(), LIVE).toBe(0);

  await anaSide.api("DELETE", `/api/storage/nodes/${brief.node.id}`);
  await anaSide.api("DELETE", `/api/storage/teamspaces/${ts}`);
  await expect.poll(() => row("Atelier").count(), LIVE).toBe(0);
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
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
