import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { rewriteLive } from "@omni/docs";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as Y from "yjs";

type LiveRecord = { t: string; u?: string; n?: number };

const PART = 800_000;

function split(e: number, u: string) {
  const chunks = Array.from({ length: Math.ceil(u.length / PART) }, (_, k) =>
    u.slice(k * PART, (k + 1) * PART),
  );
  return {
    head: { t: "update", e, u: chunks[0]!, n: chunks.length },
    rest: (h: number) => chunks.slice(1).map((part, k) => ({ t: "more", h, i: k + 1, u: part })),
  };
}
import { connectAgent } from "../../worker/e2e/mcp-support.ts";
import {
  CookieJar,
  createMailbox,
  createMember,
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
    vars: {
      BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
      S2_BASIN_URL: "http://127.0.0.1:54380/v1",
      S2_BASIN: "omni-docs-dev",
      STORAGE_PERSONAL_GB: "1",
    },
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

test("two editors on one Markdown file see each other's typing, and the page is saved", async () => {
  const origin = String(worker.url);
  const cookie = await signInWithPersonalSpace(
    { url: new URL(origin) },
    db,
    `live-${Date.now()}@gmail.test`,
  );
  context = await browser.newContext();
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await context.newPage();
  await ana.goto(new URL("/files/my", origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes\n\nStart\n"),
    });
  await ana.getByRole("row", { name: /notes\.md/ }).click();
  const bo = await context.newPage();
  await bo.goto(ana.url());

  for (const page of [ana, bo]) {
    await page.locator("[contenteditable=true]").getByText("Start").waitFor({ timeout: 15_000 });
  }

  await typeAtEnd(ana, "From Ana");
  await expect.poll(() => pageText(bo), { timeout: 15_000 }).toContain("From Ana");
  await typeAtEnd(bo, "From Bo");
  await expect.poll(() => pageText(ana), { timeout: 15_000 }).toContain("From Bo");
  for (const page of [ana, bo]) {
    expect((await pageText(page)).match(/Start/g)).toHaveLength(1);
  }
  for (const page of [ana, bo]) {
    await page.locator(".collaboration-carets__caret").first().waitFor({ timeout: 15_000 });
  }

  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  await expect
    .poll(
      () =>
        ana.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`),
      { timeout: 20_000 },
    )
    .toMatch(/^# Notes\n\nStart\n\nFrom Ana\n\nFrom Bo\n*$/);

  await bo.getByRole("list", { name: "Folder" }).locator("a[href]").last().click();
  await expect
    .poll(() => ana.locator(".collaboration-carets__caret").count(), { timeout: 15_000 })
    .toBe(0);
});

const pageText = (page: Page) => page.locator("[contenteditable=true]").innerText();

test("New doc opens an empty page, and blocks picked from / are saved as Markdown", async () => {
  const origin = String(worker.url);
  const cookie = await signInWithPersonalSpace(
    { url: new URL(origin) },
    db,
    `doc-${Date.now()}@gmail.test`,
  );
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await own.newPage();
  await page.goto(new URL("/files/my", origin).toString());
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("menuitem", { name: "New doc" }).click();
  const body = page.locator("[contenteditable=true]");
  await body.waitFor({ timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBeTruthy();

  await body.focus();
  await page.keyboard.type("/head");
  await page.getByRole("option", { name: "Heading 1" }).waitFor();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/todo");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ship it");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/table");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Who");

  const id = new URL(page.url()).searchParams.get("file") ?? "";
  await expect
    .poll(
      () =>
        page.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`),
      { timeout: 20_000 },
    )
    .toMatch(/^# Plan\n\n- \[ \] Ship it\n+\| Who\s*\|/);

  await page.keyboard.press("Tab");
  await page.keyboard.type("Last words");
  await page.getByRole("list", { name: "Folder" }).locator("a[href]").last().click();
  await expect.poll(() => body.count()).toBe(0);
  expect(await page.getByRole("alertdialog").count()).toBe(0);
  await expect
    .poll(
      () =>
        page.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`),
      { timeout: 20_000 },
    )
    .toContain("Last words");
  await own.close();
});

const DOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("an image picked from / goes into the doc, and @ links another file", async () => {
  const origin = String(worker.url);
  const cookie = await signInWithPersonalSpace(
    { url: new URL(origin) },
    db,
    `pics-${Date.now()}@gmail.test`,
  );
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const page = await own.newPage();
  await page.goto(new URL("/files/my", origin).toString());
  await page
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([
      { name: "budget.md", mimeType: "text/markdown", buffer: Buffer.from("# Budget\n") },
      { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n\nStart\n") },
    ]);
  await page.getByRole("row", { name: /budget\.md/ }).waitFor({ timeout: 30_000 });
  await page.getByRole("row", { name: /notes\.md/ }).click();
  const body = page.locator("[contenteditable=true]");
  await body.getByText("Start").waitFor({ timeout: 15_000 });
  const notesId = new URL(page.url()).searchParams.get("file") ?? "";

  await typeAtEnd(page, "/image");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("option", { name: "Image" }).click(),
  ]);
  await chooser.setFiles({ name: "dot.png", mimeType: "image/png", buffer: DOT_PNG });
  const image = body.locator("img");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 20_000 })
    .toBe(1);

  await body.getByText("Start").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" see @budg");
  await page.getByRole("option", { name: "budget.md" }).click();

  const [budget] = await db
    .select({ id: schema.storageNodes.id })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.name, "budget.md"));
  const [dot] = await db
    .select({ id: schema.storageNodes.id, parentId: schema.storageNodes.parentId })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.name, "dot.png"));
  expect(dot?.parentId).toBe(notesId);
  await expect
    .poll(
      () =>
        page.evaluate(
          async (at) => (await fetch(at)).text(),
          `/api/storage/files/${notesId}/content`,
        ),
      { timeout: 20_000 },
    )
    .toMatch(
      new RegExp(
        `Start see \\[budget\\.md\\]\\([^)]*file=${budget?.id}\\)[\\s\\S]*!\\[dot\\.png\\]\\(/api/storage/files/${dot?.id}/content\\)`,
      ),
    );

  await body.getByText("budget.md").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("file")).toBe(budget?.id);
  await own.close();
});

async function toEnd(page: Page) {
  await page.locator("[contenteditable=true]").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dom = document.querySelector(".ProseMirror") as
          | (Element & {
              editor?: {
                state: { selection: { from: number }; doc: { content: { size: number } } };
              };
            })
          | null;
        const state = dom?.editor?.state;
        return state ? state.doc.content.size - state.selection.from : -1;
      }),
    )
    .toBe(1);
}

async function typeAtEnd(page: Page, text: string) {
  await toEnd(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type(text);
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

test("a comment on selected text is marked for every editor, follows its words, and clears when resolved", async () => {
  const origin = String(worker.url);
  const cookie = await signInWithPersonalSpace(
    { url: new URL(origin) },
    db,
    `remark-${Date.now()}@gmail.test`,
  );
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await own.newPage();
  await ana.goto(new URL("/files/my", origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "remarks.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Remarks\n\nShip the plan on Monday\n"),
    });
  await ana.getByRole("row", { name: /remarks\.md/ }).click();
  const bo = await own.newPage();
  await bo.goto(ana.url());
  for (const page of [ana, bo]) {
    await page
      .locator("[contenteditable=true]")
      .getByText("Ship the plan")
      .waitFor({ timeout: 15_000 });
  }

  await toEnd(ana);
  await ana.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await ana.keyboard.press("ArrowRight");
  for (let i = 0; i < 8; i++) await ana.keyboard.press("Shift+ArrowRight");
  await ana.getByRole("button", { name: "Comment", exact: true }).click();
  await ana.getByRole("textbox", { name: "Comment" }).fill("Why Monday?");
  await ana.getByRole("button", { name: "Send", exact: true }).click();

  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  await expect
    .poll(
      async () =>
        (
          await db
            .select({ anchor: schema.storageComments.anchor })
            .from(schema.storageComments)
            .where(eq(schema.storageComments.nodeId, id))
        ).map((row) => row.anchor),
      { timeout: 15_000 },
    )
    .toEqual([{ kind: "text", quote: "the plan", prefix: "Remarks\nShip ", suffix: " on Monday" }]);
  const marked = bo.locator(".doc-comment");
  await expect.poll(() => marked.allInnerTexts(), { timeout: 15_000 }).toEqual(["the plan"]);

  await ana.locator("[contenteditable=true]").getByText("Ship the plan").click();
  await ana.keyboard.press("Home");
  await ana.keyboard.type("First, ");
  await expect.poll(() => pageText(bo), { timeout: 15_000 }).toContain("First, ");
  expect(await marked.allInnerTexts()).toEqual(["the plan"]);

  for (let i = 0; i < 5; i++) await ana.keyboard.press("ArrowRight");
  for (let i = 0; i < 3; i++) await ana.keyboard.press("Shift+ArrowRight");
  await ana.keyboard.type("our");
  await expect
    .poll(async () => (await marked.allInnerTexts()).join(""), { timeout: 15_000 })
    .toBe("our plan");

  await ana.getByRole("button", { name: "Resolve" }).click();
  await expect.poll(() => marked.count(), { timeout: 15_000 }).toBe(0);
  await own.close();
});

test("an assistant's edit lands live in an open doc, merged with what the person types", async () => {
  const origin = String(worker.url);
  const jar = new CookieJar();
  const cookie = await signInWithPersonalSpace(
    { url: new URL(origin) },
    db,
    `agent-${Date.now()}@gmail.test`,
    jar,
  );
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await own.newPage();
  await ana.goto(new URL("/files/my", origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "agenda.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Agenda\n\nOpen the meeting\n"),
    });
  await ana.getByRole("row", { name: /agenda\.md/ }).click();
  await ana
    .locator("[contenteditable=true]")
    .getByText("Open the meeting")
    .waitFor({ timeout: 15_000 });
  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  const saved = () =>
    ana.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`);

  await typeAtEnd(ana, "Review the budget");
  await expect.poll(saved, { timeout: 20_000 }).toContain("Review the budget");
  await typeAtEnd(ana, "Then lunch");

  const agent = await connectAgent(origin, jar, {
    scope: "openid mail:read drive:read drive:write",
    authURL: origin.replace(/\/$/, ""),
  });
  const edited = await agent.callTool({
    name: "drive_edit_doc",
    arguments: { id, edits: [{ find: "Open the meeting", replace: "Open the meeting at nine" }] },
  });
  expect(edited.isError).toBeFalsy();

  await expect.poll(() => pageText(ana), { timeout: 15_000 }).toContain("Open the meeting at nine");
  await expect
    .poll(saved, { timeout: 20_000 })
    .toMatch(/^# Agenda\n\nOpen the meeting at nine\n\nReview the budget\n\nThen lunch\n*$/);
  expect(await ana.getByRole("alertdialog").count()).toBe(0);
  await own.close();
});

test("an assistant's edit too large for one live record reaches an open doc whole", async () => {
  const origin = String(worker.url);
  const jar = new CookieJar();
  const cookie = await signInWithPersonalSpace(
    { url: new URL(origin) },
    db,
    `large-${Date.now()}@gmail.test`,
    jar,
  );
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await own.newPage();
  await ana.goto(new URL("/files/my", origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "long.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Long\n\nPlaceholder\n"),
    });
  await ana.getByRole("row", { name: /long\.md/ }).click();
  await ana.locator("[contenteditable=true]").getByText("Placeholder").waitFor({ timeout: 15_000 });
  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  await typeAtEnd(ana, "Typed by Ana");

  const agent = await connectAgent(origin, jar, {
    scope: "openid mail:read drive:read drive:write",
    authURL: origin.replace(/\/$/, ""),
  });
  const words = Array.from({ length: 900 }, (_, i) => `${i} ${"dolor sitam ".repeat(85)}`);
  const edited = await agent.callTool({
    name: "drive_edit_doc",
    arguments: { id, edits: [{ find: "Placeholder", replace: words.join("\n\n") }] },
  });
  expect(edited.isError).toBeFalsy();

  await expect.poll(() => pageText(ana), { timeout: 30_000 }).toContain("899 dolor sitam");
  expect(await pageText(ana)).toContain("Typed by Ana");
  expect(await ana.getByRole("alertdialog").count()).toBe(0);
  await own.close();
});

test("a large paste whose author leaves is saved by the open page, even when the page typed while its parts arrived", async () => {
  const origin = String(worker.url);
  const jar = new CookieJar();
  const cookie = await signInWithPersonalSpace(
    { url: new URL(origin) },
    db,
    `orphan-${Date.now()}@gmail.test`,
    jar,
  );
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await own.newPage();
  await ana.goto(new URL("/files/my", origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "paste.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Paste\n\nStart\n"),
    });
  await ana.getByRole("row", { name: /paste\.md/ }).click();
  await ana.locator("[contenteditable=true]").getByText("Start").waitFor({ timeout: 15_000 });
  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  const saved = () =>
    ana.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`);

  const read = await fetch(new URL(`/api/storage/files/${id}/live?from=latest`, origin), {
    headers: { cookie },
  });
  const { entries } = (await read.json()) as {
    entries: { seqNum: number; record: LiveRecord }[];
  };
  const mirror = new Y.Doc();
  let epoch = 0;
  for (const { seqNum, record } of entries) {
    if (record.t === "seed") epoch = seqNum;
    if (record.u && record.n === undefined) Y.applyUpdate(mirror, Buffer.from(record.u, "base64"));
  }

  const url = new URL("/api/realtime", origin);
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie, origin: new URL(origin).origin },
  } as unknown as string[]);
  const answers: Record<string, unknown>[] = [];
  socket.addEventListener("message", (e) => answers.push(JSON.parse(String(e.data))));
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  socket.send(JSON.stringify({ type: "file.presence", nodeId: id, state: "editing" }));
  let ref = 0;
  const append = async (record: unknown) => {
    for (;;) {
      const sent = ++ref;
      socket.send(JSON.stringify({ type: "doc.append", nodeId: id, ref: sent, record }));
      await expect.poll(() => answers.some((a) => a.ref === sent), { timeout: 10_000 }).toBe(true);
      const answer = answers.find((a) => a.ref === sent)!;
      if (answer.type === "doc.appended") return answer.seqNum as number;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const words = Array.from({ length: 700 }, (_, i) => `${i} ${"dolor sitam ".repeat(85)}`);
  const pasted = `# Paste\n\nStart\n\n${words.join("\n\n")}`;
  const paste = split(epoch, Buffer.from(rewriteLive(mirror, pasted)).toString("base64"));
  expect(paste.head.n).toBeGreaterThan(1);
  const head = await append(paste.head);
  await typeAtEnd(ana, "Typed meanwhile");
  await expect.poll(saved, { timeout: 20_000 }).toContain("Typed meanwhile");
  for (const part of paste.rest(head)) await append(part);
  socket.close();

  await expect.poll(saved, { timeout: 30_000 }).toContain("699 dolor sitam");
  expect(await saved()).toContain("Typed meanwhile");
  await own.close();
});

test("an assistant whose person may only view a doc changes nothing in it, even while it is open", async () => {
  const origin = String(worker.url);
  const acme = await createOrg(db, "acme");
  const anaEmail = `owner-${Date.now()}@acme.test`;
  const fredEmail = `fred-${Date.now()}@acme.test`;
  await createMember(db, acme.id, anaEmail);
  const fred = await createMember(db, acme.id, fredEmail);
  await db.update(schema.members).set({ role: "freelancer" }).where(eq(schema.members.id, fred.id));
  const cookie = await signInWithPersonalSpace({ url: new URL(origin) }, db, anaEmail);
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await own.newPage();
  await ana.goto(new URL(`/${acme.slug}/files/shared`, origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "terms.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Terms\n\nPay in 30 days\n"),
    });
  await ana.getByRole("row", { name: /terms\.md/ }).click();
  await ana
    .locator("[contenteditable=true]")
    .getByText("Pay in 30 days")
    .waitFor({ timeout: 15_000 });
  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  const shared = await ana.evaluate(
    async ([at, body]) =>
      (
        await fetch(at, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
    [
      `/api/storage/nodes/${id}/sharing/people/${encodeURIComponent(fredEmail)}`,
      JSON.stringify({ role: "viewer" }),
    ] as const,
  );
  expect(shared).toBe(200);

  const jar = new CookieJar();
  await signInWithPersonalSpace({ url: new URL(origin) }, db, fredEmail, jar);
  const agent = await connectAgent(origin, jar, {
    scope: "openid mail:read drive:read drive:write",
    authURL: origin.replace(/\/$/, ""),
  });
  const edited = await agent.callTool({
    name: "drive_edit_doc",
    arguments: { id, edits: [{ find: "Pay in 30 days", replace: "Pay in 900 days" }] },
  });
  expect(edited.isError).toBe(true);

  await typeAtEnd(ana, "Signed by Ana");
  const saved = () =>
    ana.evaluate(async (at) => (await fetch(at)).text(), `/api/storage/files/${id}/content`);
  await expect.poll(saved, { timeout: 20_000 }).toContain("Signed by Ana");
  expect(await saved()).toContain("Pay in 30 days");
  expect(await pageText(ana)).not.toContain("900");
  await own.close();
});

test("an assistant's edit to an open doc in a full workspace changes nothing", async () => {
  const origin = String(worker.url);
  const jar = new CookieJar();
  const email = `full-${Date.now()}@gmail.test`;
  const cookie = await signInWithPersonalSpace({ url: new URL(origin) }, db, email, jar);
  const own = await browser.newContext();
  await own.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  const ana = await own.newPage();
  await ana.goto(new URL("/files/my", origin).toString());
  await ana
    .getByRole("button", { name: "Upload", exact: true })
    .first()
    .waitFor({ timeout: 15_000 });
  await ana
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "budget.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Budget\n\nSpend 100\n"),
    });
  await ana.getByRole("row", { name: /budget\.md/ }).click();
  await ana.locator("[contenteditable=true]").getByText("Spend 100").waitFor({ timeout: 15_000 });
  const id = new URL(ana.url()).searchParams.get("file") ?? "";
  const [file] = await db
    .select({ orgId: schema.storageNodes.orgId })
    .from(schema.storageNodes)
    .where(eq(schema.storageNodes.id, id));
  await db
    .update(schema.storageUsage)
    .set({ bytes: 10 ** 15 })
    .where(eq(schema.storageUsage.orgId, file?.orgId ?? ""));

  const agent = await connectAgent(origin, jar, {
    scope: "openid mail:read drive:read drive:write",
    authURL: origin.replace(/\/$/, ""),
  });
  const edited = await agent.callTool({
    name: "drive_edit_doc",
    arguments: { id, edits: [{ find: "Spend 100", replace: "Spend 900" }] },
  });
  expect(edited.isError).toBe(true);

  await typeAtEnd(ana, "Checked");
  await expect.poll(() => pageText(ana), { timeout: 15_000 }).toContain("Checked");
  expect(await pageText(ana)).not.toContain("900");
  await own.close();
});
