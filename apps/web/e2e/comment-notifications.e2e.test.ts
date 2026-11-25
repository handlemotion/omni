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

test("a comment on a file at a space's root opens that space with the file's comments showing", async () => {
  const { ben, ana, space } = await twoInASpace("comment-root");
  const file = await ben.upload({ teamspaceId: space }, "brief.txt");
  await ana.api("POST", `/api/storage/files/${file.id}/comments`, { body: "Root looks good" });

  const page = await openNotification(ben.page, "brief.txt");

  await page.waitForURL((url) => url.pathname.endsWith(`/files/t/${space}`));
  expect(new URL(page.url()).searchParams.get("comments")).toBe(file.id);
  const panel = page.getByRole("region", { name: "Comments on brief.txt" });
  await panel.getByText("Root looks good").waitFor({ timeout: 15_000 });
});

test("a comment on a file in a space's subfolder opens that folder with the file's comments showing", async () => {
  const { ben, ana, space } = await twoInASpace("comment-folder");
  const folder = await ben.api("POST", "/api/storage/folders", {
    name: "Contracts",
    teamspaceId: space,
  });
  const file = await ben.upload({ parentId: folder.node.id }, "msa.txt");
  await ana.api("POST", `/api/storage/files/${file.id}/comments`, { body: "Clause 4 is off" });

  const page = await openNotification(ben.page, "msa.txt");

  await page.waitForURL((url) => url.pathname.endsWith(`/files/t/${space}/${folder.node.id}`));
  expect(new URL(page.url()).searchParams.get("comments")).toBe(file.id);
  const panel = page.getByRole("region", { name: "Comments on msa.txt" });
  await panel.getByText("Clause 4 is off").waitFor({ timeout: 15_000 });
});

async function twoInASpace(name: string) {
  const org = await createOrg(db, name);
  await createMailbox(db, org.id, `hello-${Date.now()}@${name}.test`);
  const benMember = await createMember(db, org.id, `ben-${Date.now()}@${name}.test`);
  const anaMember = await createMember(db, org.id, `ana-${Date.now()}@${name}.test`);
  const ana = await asMember(anaMember.id, org.id);
  const ben = await asMember(benMember.id, org.id);
  const made = await ben.api("POST", "/api/storage/teamspaces", { name: "Legal" });
  const space = made.teamspace.id as string;
  await ana.api("POST", `/api/storage/teamspaces/${space}/join`);
  await context?.close();
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies(cookiesOf(ben.cookie));
  const page: Page = await context.newPage();
  await page.goto(new URL(`/${org.slug}/mail/inbox`, worker.url).toString());
  await page.getByRole("navigation", { name: "Modules" }).waitFor({ timeout: 30_000 });
  return { ben: { ...ben, page }, ana, space };
}

async function openNotification(page: Page, fileName: string) {
  await page.getByRole("button", { name: /^Notifications/ }).click();
  const list = page.getByRole("grid", { name: "Notifications", exact: true });
  const row = list.getByRole("row").filter({ hasText: `${fileName}:` });
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  return page;
}

async function asMember(memberId: string, orgId: string) {
  const origin = String(worker.url);
  const [user] = await db
    .select({ email: schema.users.email })
    .from(schema.users)
    .innerJoin(schema.members, eq(schema.members.userId, schema.users.id))
    .where(eq(schema.members.id, memberId));
  if (!user) throw new Error("no such member");
  const cookie = await signIn({ url: new URL(origin) }, db, user.email);
  const send = (method: string, path: string, body?: BodyInit, type?: string) =>
    fetch(new URL(path, origin), {
      method,
      headers: { cookie, "omni-workspace": orgId, ...(type ? { "content-type": type } : {}) },
      body,
    });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await send(
      method,
      path,
      body ? JSON.stringify(body) : undefined,
      body ? "application/json" : undefined,
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    // oxlint-disable-next-line typescript/no-explicit-any -- test reads of JSON answers
    return (text ? JSON.parse(text) : null) as any;
  };
  const upload = async (place: { teamspaceId: string } | { parentId: string }, name: string) => {
    const bytes = new TextEncoder().encode(`${name} body`);
    const opened = await api("POST", "/api/storage/uploads", {
      name,
      size: bytes.length,
      mimeType: "text/plain",
      ...place,
    });
    const { id, partSize, partCount } = opened.upload as {
      id: string;
      partSize: number;
      partCount: number;
    };
    for (let n = 1; n <= partCount; n++) {
      const part = bytes.subarray((n - 1) * partSize, n * partSize);
      const sent = await send(
        "PUT",
        `/api/storage/uploads/${id}/parts/${n}`,
        new Blob([part]),
        "application/octet-stream",
      );
      if (!sent.ok) throw new Error(`part ${n} of ${name}: ${sent.status}`);
      await sent.body?.cancel();
    }
    const done = await api("POST", `/api/storage/uploads/${id}/complete`);
    return done.node as { id: string };
  };
  return { cookie, api, upload };
}

function cookiesOf(cookie: string) {
  return cookie.split("; ").map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: String(worker.url) };
  });
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
