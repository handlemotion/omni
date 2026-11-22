import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createOrgWithOwner, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
  WEB_ORIGIN,
  type TestDb,
} from "../../worker/e2e/support.ts";

const SHOTS = process.env.TALK_SHOTS;

const PICTURE = (() => {
  const [w, h] = [480, 320];
  const rows = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const at = y * (w * 3 + 1) + 1 + x * 3;
      const t = (x / w + y / h) / 2;
      rows[at] = Math.round(244 - 60 * t);
      rows[at + 1] = Math.round(140 + 60 * t);
      rows[at + 2] = Math.round(90 + 150 * t);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
})();

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: TestDb;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorkerWithNetwork>>;
let browser: Browser;
const contexts: BrowserContext[] = [];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
  mailService = await startMailServiceEndpoint();
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  worker = await startWorkerWithNetwork({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    port,
    vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}` },
  });
  browser = await chromium.launch().catch(() => chromium.launch({ channel: "chrome" }));
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  for (const socket of sockets) socket.close();
  for (const context of contexts) await context.close();
  await browser?.close();
  await worker?.close();
  await mailService?.close();
  await database?.teardown();
});

async function team(slug: string) {
  const system = await createOrg(db, `${slug}-system`);
  await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
  const owner = await createOrgWithOwner(db, {
    name: "Acme",
    slug: `${slug}-acme`,
    ownerEmail: `ana@${slug}.test`,
  });
  const names = {
    ana: "Ana Lima",
    ben: "Kofi Mensah",
    cy: "Cyra Holt",
    dee: "Dee Park",
    eli: "Eli Stone",
  };
  await db.update(schema.users).set({ name: names.ana }).where(eq(schema.users.id, owner.userId));
  const people = { ana: { email: `ana@${slug}.test`, memberId: owner.memberId } } as Record<
    keyof typeof names,
    { email: string; memberId: string }
  >;
  for (const key of ["ben", "cy", "dee", "eli"] as const) {
    const email = `${key}@${slug}.test`;
    const member = await createMember(db, owner.orgId, email);
    await db
      .update(schema.users)
      .set({ name: names[key] })
      .where(eq(schema.users.id, member.userId));
    people[key] = { email, memberId: member.id };
  }
  for (const key of ["ana", "ben"] as const) {
    const box = await createMailbox(db, owner.orgId, people[key].email, "personal");
    await grant(db, owner.orgId, box.id, people[key].memberId);
  }
  return people;
}

const origin = () => String(worker.url);

async function open(email: string) {
  const cookie = await signIn({ url: new URL(origin()) }, db, email);
  const context = await browser.newContext({
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 800 },
  });
  contexts.push(context);
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin() };
    }),
  );
  const page = await context.newPage();
  await page.goto(new URL("/inbox", origin()).toString());
  return page satisfies Page;
}

async function online(email: string) {
  const cookie = await signIn({ url: new URL(origin()) }, db, email);
  const url = new URL("/api/realtime?talk=1", origin());
  url.protocol = "ws:";
  const socket = new WebSocket(url, {
    headers: { cookie, origin: WEB_ORIGIN },
  } as unknown as string[]);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error(`no Talk socket for ${email}`)));
  });
  sockets.push(socket);
}

const shoot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test("the stack shows who is online, and a note and a file reach the teammate's window", async () => {
  const people = await team("talk-web");
  const ana = await open(people.ana.email);
  const stack = ana.getByRole("group", { name: "Online now" });
  await expect.poll(() => stack.count()).toBe(0);

  const kofi = await open(people.ben.email);
  await online(people.cy.email);
  await online(people.dee.email);
  await online(people.eli.email);
  await expect.poll(() => stack.getByRole("button").count()).toBe(4);
  expect(await stack.getByRole("button").allInnerTexts()).toContain("+1");
  await shoot(ana, "1-stack");

  const made: string[] = [];
  const onRequest = (request: { method(): string; url(): string }) => {
    if (request.method() === "POST" && request.url().endsWith("/api/talk/threads")) {
      made.push(request.url());
    }
  };
  ana.on("request", onRequest);
  const peek = ana.getByRole("region", { name: /^Conversation with / });
  const faces = stack.locator("[data-talk-face]");
  await faces.nth(0).hover();
  await peek.waitFor();
  const first = await peek.getAttribute("aria-label");
  await peek.evaluate((el) => el.setAttribute("data-same", ""));
  const leftOf = () => peek.evaluate((el) => el.getBoundingClientRect().left);
  const before = await leftOf();
  await faces.nth(1).hover();
  await expect.poll(() => peek.getAttribute("aria-label")).not.toBe(first);
  expect(await peek.getAttribute("data-same")).toBe("");
  await expect.poll(leftOf).toBeGreaterThan(before);
  await shoot(ana, "1a-peek");
  await ana.mouse.move(4, 400);
  await expect.poll(() => peek.count()).toBe(0);
  ana.off("request", onRequest);
  expect(made).toEqual([]);

  await stack.getByRole("button", { name: "Everyone, 1 more online" }).click();
  await ana.getByRole("menuitem", { name: "Kofi Mensah" }).waitFor();
  await ana.waitForTimeout(300);
  await shoot(ana, "1b-everyone");
  await ana.getByRole("menuitem", { name: "Kofi Mensah" }).click();
  const window = ana.getByRole("region", { name: "Conversation with Kofi Mensah" });
  await window.getByLabel("Active now").waitFor();
  const composer = window.getByRole("textbox", { name: "Note to Kofi Mensah" });
  expect(await composer.getAttribute("placeholder")).toBe("Note to Kofi…");
  await composer.fill("Dropping the brand board now");
  await composer.press("Enter");
  await window.getByText("Dropping the brand board now").waitFor();
  const bubble = (text: string) => window.locator("p", { hasText: text });
  const held = Promise.withResolvers<void>();
  await ana.route("**/api/talk/threads/*/messages", async (route) => {
    if (route.request().method() === "POST") await held.promise;
    await route.fallback();
  });
  await composer.fill("Second one");
  await composer.press("Enter");
  expect(await composer.inputValue()).toBe("");
  await composer.fill("Third, right away");
  await composer.press("Enter");
  await composer.fill("Still typing this");
  held.resolve();
  await bubble("Third, right away").waitFor();
  await bubble("Second one").waitFor();
  expect(await composer.inputValue()).toBe("Still typing this");
  const shown = await window.locator("p").allInnerTexts();
  expect(shown.indexOf("Second one")).toBeLessThan(shown.indexOf("Third, right away"));
  await ana.unroute("**/api/talk/threads/*/messages");
  const failing = Promise.withResolvers<void>();
  let holding = true;
  await ana.route("**/api/talk/threads/*/messages", async (route) => {
    if (route.request().method() === "POST" && holding) {
      holding = false;
      await failing.promise;
    }
    await route.fallback();
  });
  const tooLong = `Lost on the way ${"x".repeat(4_000)}`;
  await composer.fill(tooLong);
  await composer.press("Enter");
  await composer.fill("Kept one");
  await composer.press("Enter");
  failing.resolve();
  await bubble("Kept one").waitFor();
  await expect.poll(() => composer.inputValue()).toBe(tooLong);
  expect(await bubble("Lost on the way").count()).toBe(0);
  await ana.unroute("**/api/talk/threads/*/messages");
  await composer.fill("");
  await window.locator('input[type="file"]').setInputFiles({
    name: "board.png",
    mimeType: "image/png",
    buffer: PICTURE,
  });
  const image = window.getByRole("img", { name: "board.png" });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
  await bubble("Dropping the brand board now").hover();
  await window.getByRole("button", { name: "React 🎉" }).first().click();
  await window.getByRole("button", { name: "🎉 1" }).waitFor();
  await composer.focus();
  await shoot(ana, "2-window");

  const kofiStack = kofi.getByRole("group", { name: "Online now" });
  const fromAna = kofiStack.getByRole("button", { name: "Ana Lima, 5 unread" });
  await fromAna.waitFor();
  await shoot(kofi, "3-unread");
  await fromAna.click();
  const kofiWindow = kofi.getByRole("region", { name: "Conversation with Ana Lima" });
  await kofiWindow.getByText("Dropping the brand board now").waitFor();
  const received = kofiWindow.getByRole("img", { name: "board.png" });
  await expect.poll(() => received.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
  await kofiStack.getByRole("button", { name: "Ana Lima", exact: true }).waitFor();
  await shoot(kofi, "4-kofi-window");
});
