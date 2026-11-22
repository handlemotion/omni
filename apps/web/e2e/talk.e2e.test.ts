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
  const stack = ana.getByRole("group", { name: "Teammates" });
  await stack.getByRole("button", { name: "Cyra Holt, offline" }).waitFor();
  expect(await stack.getByRole("button").count()).toBe(4);
  await shoot(ana, "0-offline");
  await stack.getByRole("button", { name: "Cyra Holt, offline" }).click();
  const toCyra = ana.getByRole("region", { name: "Conversation with Cyra Holt" });
  await toCyra.getByRole("textbox", { name: "Note to Cyra Holt" }).fill("For when you're back");
  await toCyra.getByRole("textbox", { name: "Note to Cyra Holt" }).press("Enter");
  await toCyra.locator("p", { hasText: "For when you're back" }).waitFor();
  expect(await toCyra.getByRole("textbox").inputValue()).toBe("");
  await ana.keyboard.press("Escape");
  await toCyra.waitFor({ state: "detached" });
  await ana.mouse.move(4, 400);

  const kofi = await open(people.ben.email);
  await online(people.cy.email);
  await online(people.dee.email);
  await online(people.eli.email);
  await stack.getByRole("button", { name: "Cyra Holt", exact: true }).waitFor();
  expect(await stack.getByRole("button").count()).toBe(4);
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
  const chooser = ana.getByRole("region", { name: "Everyone" });
  await stack.getByRole("button", { name: "Everyone, 1 more" }).hover();
  await chooser.getByRole("button", { name: "Kofi Mensah" }).waitFor();
  expect(await chooser.getAttribute("data-same")).toBe("");
  expect(await peek.count()).toBe(0);
  await ana.mouse.move(4, 400);
  await expect.poll(() => chooser.count()).toBe(0);
  ana.off("request", onRequest);
  expect(made).toEqual([]);

  await stack.getByRole("button", { name: "Everyone, 1 more" }).click();
  await chooser.getByRole("button", { name: "Kofi Mensah" }).waitFor();
  await ana.waitForTimeout(300);
  await shoot(ana, "1b-everyone");
  await chooser.getByRole("button", { name: "Kofi Mensah" }).click();
  const window = ana.getByRole("region", { name: "Conversation with Kofi Mensah" });
  await window.getByLabel("Active now").waitFor();
  const composer = window.getByRole("textbox", { name: "Note to Kofi Mensah" });
  expect(await composer.getAttribute("placeholder")).toBe("Note to Kofi…");
  await composer.fill("Dropping the brand board now");
  await composer.press("Enter");
  await window.locator("p", { hasText: "Dropping the brand board now" }).waitFor();
  const arrival = kofi.getByRole("button", { name: "New note: Dropping the brand board now" });
  await arrival.waitFor();
  const anaFace = kofi
    .getByRole("group", { name: "Teammates" })
    .locator("[data-talk-face]")
    .first();
  const [bubbleBox, faceBox] = [await arrival.boundingBox(), await anaFace.boundingBox()];
  expect(bubbleBox!.y).toBeGreaterThan(faceBox!.y + faceBox!.height);
  const tailX = bubbleBox!.x + bubbleBox!.width - 20;
  expect(Math.abs(tailX - (faceBox!.x + faceBox!.width / 2))).toBeLessThan(4);
  await shoot(kofi, "2b-arrival");
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
  const ratio = await image.evaluate((img: HTMLImageElement) => [
    img.naturalWidth / img.naturalHeight,
    img.getBoundingClientRect().width / img.getBoundingClientRect().height,
  ]);
  expect(Math.abs(ratio[0]! - ratio[1]!)).toBeLessThan(0.05);
  await bubble("Dropping the brand board now").hover();
  await window.getByRole("button", { name: "React 🎉" }).first().click();
  await window.getByRole("button", { name: "🎉 1" }).waitFor();
  await composer.focus();
  await shoot(ana, "2-window");

  const kofiStack = kofi.getByRole("group", { name: "Teammates" });
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

  await kofi.keyboard.press("Escape");
  await kofiWindow.waitFor({ state: "detached" });
  const wide = kofi.viewportSize()!;
  await kofi.setViewportSize({ width: 600, height: wide.height });
  await kofiStack.waitFor({ state: "detached" });
  await composer.fill("While you were narrow");
  const stored = ana.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/messages"),
  );
  await composer.press("Enter");
  await stored;
  await bubble("While you were narrow").waitFor();
  await kofi.setViewportSize(wide);
  await kofiStack.getByRole("button", { name: "Ana Lima, 1 unread" }).waitFor();
});

test("a note reaches an open window with older notes loaded without refetching it, and shows once to its sender", async () => {
  const people = await team("talk-arrive");
  const cookie = await signIn({ url: new URL(origin()) }, db, people.ana.email);
  const post = (path: string, body?: unknown) =>
    fetch(new URL(`/api/talk${path}`, origin()), {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const { thread } = await post("/threads", { memberId: people.ben.memberId });
  for (let i = 0; i < 70; i++) await post(`/threads/${thread.id}/messages`, { body: `Old ${i}` });

  const ana = await open(people.ana.email);
  const kofi = await open(people.ben.email);
  await kofi.getByRole("button", { name: /^Ana Lima/ }).click();
  const kofiWindow = kofi.getByRole("region", { name: "Conversation with Ana Lima" });
  await kofiWindow.getByText("Old 69", { exact: true }).waitFor();
  const loading = Promise.withResolvers<void>();
  await kofi.route("**/api/talk/threads/*/messages?before=*", async (route) => {
    await loading.promise;
    await route.fallback();
  });
  await kofiWindow.getByRole("button", { name: "Earlier" }).click();
  await post(`/threads/${thread.id}/messages`, { body: "While older ones load" });
  await kofiWindow.getByText("While older ones load", { exact: true }).waitFor();
  loading.resolve();
  await kofiWindow.getByText("Old 0", { exact: true }).waitFor();
  await kofi.unroute("**/api/talk/threads/*/messages?before=*");
  expect(await kofiWindow.getByText("While older ones load", { exact: true }).count()).toBe(1);
  const fetched: string[] = [];
  kofi.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /\/api\/talk\/(people|threads\/[^/]+\/messages)/.test(request.url())
    ) {
      fetched.push(request.url());
    }
  });

  await ana.getByRole("button", { name: /^Kofi Mensah/ }).click();
  const anaWindow = ana.getByRole("region", { name: "Conversation with Kofi Mensah" });
  const composer = anaWindow.getByRole("textbox", { name: "Note to Kofi Mensah" });
  await composer.fill("Fresh one");
  await composer.press("Enter");
  await kofiWindow.getByText("Fresh one", { exact: true }).waitFor();
  await anaWindow.getByText("Fresh one", { exact: true }).waitFor();
  await kofi.waitForTimeout(1_000);
  expect(fetched).toEqual([]);
  expect(await anaWindow.getByText("Fresh one", { exact: true }).count()).toBe(1);
  expect(await kofiWindow.getByText("Old 0", { exact: true }).count()).toBe(1);

  const fresh = kofiWindow.getByText("Fresh one", { exact: true });
  await fresh.hover();
  await fresh.locator("..").getByRole("button", { name: "React 👍" }).click();
  await anaWindow.getByRole("button", { name: "👍 1" }).waitFor();
  expect(fetched).toEqual([]);

  await anaWindow.getByRole("button", { name: "Close" }).click();
  await anaWindow.waitFor({ state: "detached" });
  const answered = Promise.withResolvers<void>();
  const stored = ana.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/messages"),
  );
  await ana.route("**/api/talk/threads/*/messages", async (route) => {
    if (route.request().method() === "POST") {
      await answered.promise;
      return route.fallback();
    }
    const empty = await route.fetch();
    answered.resolve();
    await stored;
    await ana.waitForTimeout(300);
    await route.fulfill({ response: empty });
  });
  await ana
    .getByRole("group", { name: "Teammates" })
    .getByRole("button", { name: /^Cyra Holt/ })
    .click();
  const toCyra = ana.getByRole("region", { name: "Conversation with Cyra Holt" });
  await toCyra.getByRole("textbox").fill("First to Cyra");
  await toCyra.getByRole("textbox").press("Enter");
  await toCyra.getByText("First to Cyra", { exact: true }).waitFor();
  await ana.unroute("**/api/talk/threads/*/messages");
});

test("realtime that comes late or out of order never misorders notes or hides a newer unread one", async () => {
  const people = await team("talk-late");
  const cookie = await signIn({ url: new URL(origin()) }, db, people.ana.email);
  const post = (path: string, body?: unknown) =>
    fetch(new URL(`/api/talk${path}`, origin()), {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const { thread } = await post("/threads", { memberId: people.ben.memberId });
  await post(`/threads/${thread.id}/messages`, { body: "Hello" });

  const kofiCookie = await signIn({ url: new URL(origin()) }, db, people.ben.email);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  await context.addCookies(
    kofiCookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin() };
    }),
  );
  let swap: string | null = null;
  let holdReads = false;
  const heldReads: string[] = [];
  const readHeld = Promise.withResolvers<void>();
  const readSeen: Array<PromiseWithResolvers<void>> = [];
  const holding = (preview: string) => ({
    preview,
    frames: [] as string[],
    held: Promise.withResolvers<void>(),
  });
  const fourth = holding("Fourth");
  const late = holding("Reacted first");
  const sixthNote = holding("Sixth");
  const mine = holding("Mine, earlier");
  const holds = [fourth, late, sixthNote, mine];
  const deliver: Array<(frame: string) => void> = [];
  const watched = {
    messageId: "",
    frames: [] as string[],
    added: Promise.withResolvers<void>(),
    removed: Promise.withResolvers<void>(),
  };
  const watchedReaction = (
    event: { reactions?: { messageId: string; reactions: unknown[] } },
    text: string,
  ) => {
    if (!watched.messageId || event.reactions?.messageId !== watched.messageId) return null;
    if (event.reactions.reactions.length === 0) return (watched.removed.resolve(), "dropped");
    watched.frames.push(text);
    watched.added.resolve();
    return "held";
  };
  const dropReactions = { of: "" };
  const routed = (text: string) => {
    const event = JSON.parse(text) as {
      type?: string;
      preview?: string;
      read?: boolean;
      reactions?: { messageId: string; reactions: unknown[] };
    };
    if (dropReactions.of && event.reactions?.messageId === dropReactions.of) return "dropped";
    const reaction = event.type === "talk.changed" ? watchedReaction(event, text) : null;
    if (reaction) return reaction;
    if (event.type === "talk.changed" && event.read) {
      readSeen.at(-1)?.resolve();
      if (!holdReads) return "send";
      heldReads.push(text);
      readHeld.resolve();
      return "held";
    }
    if (event.type !== "talk.message") return "send";
    if (event.preview === "First") return (void (swap = text), "held");
    if (event.preview === "Missed") return "dropped";
    const hold = holds.find((h) => h.preview === event.preview && h.frames.length === 0);
    if (!hold) return event.preview === "Second" ? "then-swap" : "send";
    hold.frames.push(text);
    hold.held.resolve();
    return "held";
  };
  await context.routeWebSocket(/\/api\/realtime/, (ws) => {
    const server = ws.connectToServer();
    deliver.push((frame) => ws.send(frame));
    ws.onMessage((frame) => server.send(frame));
    server.onMessage((frame) => {
      const way = routed(String(frame));
      if (way === "held" || way === "dropped") return;
      ws.send(frame);
      if (way === "then-swap" && swap) ws.send(swap);
    });
  });
  const kofi = await context.newPage();
  await kofi.goto(new URL("/inbox", origin()).toString());
  const stack = kofi.getByRole("group", { name: "Teammates" });
  await stack.getByRole("button", { name: /^Ana Lima/ }).click();
  const window = kofi.getByRole("region", { name: "Conversation with Ana Lima" });
  await window.getByText("Hello", { exact: true }).waitFor();

  await post(`/threads/${thread.id}/messages`, { body: "First" });
  await post(`/threads/${thread.id}/messages`, { body: "Second" });
  await window.getByText("First", { exact: true }).waitFor();
  const shown = await window.locator("p").allInnerTexts();
  expect(shown.indexOf("First")).toBeLessThan(shown.indexOf("Second"));

  await kofi.keyboard.press("Escape");
  await window.waitFor({ state: "detached" });
  await kofi.mouse.move(4, 400);
  holdReads = true;
  const read = await fetch(new URL(`/api/talk/threads/${thread.id}/read`, origin()), {
    method: "PUT",
    headers: { cookie: kofiCookie, origin: WEB_ORIGIN },
  });
  expect(read.status).toBe(204);
  await readHeld.promise;
  await post(`/threads/${thread.id}/messages`, { body: "Third" });
  await stack.getByRole("button", { name: "Ana Lima, 1 unread" }).waitFor();
  for (const frame of heldReads) for (const send of deliver) send(frame);
  await kofi.waitForTimeout(1_000);
  await stack.getByRole("button", { name: "Ana Lima, 1 unread" }).waitFor();

  await post(`/threads/${thread.id}/messages`, { body: "Fourth" });
  await fourth.held.promise;
  const wide = kofi.viewportSize()!;
  await kofi.setViewportSize({ width: 600, height: wide.height });
  await stack.waitFor({ state: "detached" });
  await kofi.setViewportSize(wide);
  await stack.getByRole("button", { name: "Ana Lima, 2 unread" }).waitFor();
  deliver.at(-1)!(fourth.frames[0]!);
  await kofi.waitForTimeout(1_000);
  await stack.getByRole("button", { name: "Ana Lima, 2 unread" }).waitFor();

  await stack.getByRole("button", { name: /^Ana Lima/ }).click();
  await window.getByText("Hello", { exact: true }).waitFor();
  const removed = Promise.withResolvers<void>();
  const answered: Promise<unknown>[] = [];
  const bothSent = Promise.withResolvers<void>();
  await kofi.route("**/api/talk/messages/*/reactions/*", async (route) => {
    const method = route.request().method();
    if (method === "DELETE") removed.resolve();
    if (method === "PUT") await Promise.race([removed.promise, kofi.waitForTimeout(1_500)]);
    await route.fallback();
  });
  kofi.on("request", (request) => {
    if (!request.url().includes("/reactions/")) return;
    answered.push(request.response());
    if (answered.length === 2) bothSent.resolve();
  });
  const hello = window.getByText("Hello", { exact: true });
  await hello.hover();
  await hello.locator("..").getByRole("button", { name: "React 👍" }).click();
  await window.getByRole("button", { name: "👍 1" }).click();
  await bothSent.promise;
  await Promise.all(answered);
  const page = (await fetch(new URL(`/api/talk/threads/${thread.id}/messages`, origin()), {
    headers: { cookie },
  }).then((r) => r.json())) as { messages: { body: string; reactions: unknown[] }[] };
  expect(page.messages.find((m) => m.body === "Hello")!.reactions).toEqual([]);

  await kofi.keyboard.press("Escape");
  await window.waitFor({ state: "detached" });
  await kofi.mouse.move(4, 400);
  await post(`/threads/${thread.id}/messages`, { body: "Missed" });
  await kofi.setViewportSize({ width: 600, height: wide.height });
  await stack.waitFor({ state: "detached" });
  await kofi.setViewportSize(wide);
  await stack.waitFor();
  await post(`/threads/${thread.id}/messages`, { body: "After" });
  await stack.getByRole("button", { name: /^Ana Lima, \d unread/ }).waitFor();
  await stack.getByRole("button", { name: /^Ana Lima/ }).click();
  await window.getByText("After", { exact: true }).waitFor();
  await window.getByText("Missed", { exact: true }).waitFor();

  const { message } = await post(`/threads/${thread.id}/messages`, { body: "Reacted first" });
  await late.held.promise;
  const reacted = await fetch(
    new URL(`/api/talk/messages/${message.id}/reactions/${encodeURIComponent("👍")}`, origin()),
    { method: "PUT", headers: { cookie, origin: WEB_ORIGIN } },
  );
  expect(reacted.status).toBe(204);
  const early = window.getByText("Reacted first", { exact: true }).locator("..");
  await early.getByRole("button", { name: "👍 1" }).waitFor();
  deliver.at(-1)!(late.frames[0]!);
  await kofi.waitForTimeout(1_000);
  await early.getByRole("button", { name: "👍 1" }).waitFor();

  await kofi.keyboard.press("Escape");
  await window.waitFor({ state: "detached" });
  await kofi.mouse.move(4, 400);
  const peopleHeld = Promise.withResolvers<void>();
  const peopleRelease = Promise.withResolvers<void>();
  let holdPeople = true;
  await kofi.route("**/api/talk/people", async (route) => {
    if (!holdPeople) return route.fallback();
    holdPeople = false;
    const before = await route.fetch();
    peopleHeld.resolve();
    await peopleRelease.promise;
    await route.fulfill({ response: before }).catch(() => {});
  });
  await post(`/threads/${thread.id}/messages`, { body: "Fifth" });
  await peopleHeld.promise;
  const seen = Promise.withResolvers<void>();
  readSeen.push(seen);
  holdReads = false;
  const readAll = await fetch(new URL(`/api/talk/threads/${thread.id}/read`, origin()), {
    method: "PUT",
    headers: { cookie: kofiCookie, origin: WEB_ORIGIN },
  });
  expect(readAll.status).toBe(204);
  await seen.promise;
  await kofi.waitForTimeout(300);
  peopleRelease.resolve();
  await kofi.waitForTimeout(1_000);
  await stack.getByRole("button", { name: "Ana Lima, offline", exact: true }).waitFor();

  await stack.getByRole("button", { name: /^Ana Lima/ }).click();
  await window.getByText("Fifth", { exact: true }).waitFor();
  const pageHeld = Promise.withResolvers<void>();
  const pageRelease = Promise.withResolvers<void>();
  let holdPage = true;
  await kofi.route(`**/api/talk/threads/${thread.id}/messages`, async (route) => {
    if (!holdPage || route.request().method() !== "GET") return route.fallback();
    holdPage = false;
    const older = await route.fetch();
    pageHeld.resolve();
    await pageRelease.promise;
    await route.fulfill({ response: older });
  });
  const sixth = (await post(`/threads/${thread.id}/messages`, { body: "Sixth" })).message;
  await sixthNote.held.promise;
  const reactTo = (emoji: string) =>
    fetch(
      new URL(`/api/talk/messages/${sixth.id}/reactions/${encodeURIComponent(emoji)}`, origin()),
      { method: "PUT", headers: { cookie, origin: WEB_ORIGIN } },
    );
  expect((await reactTo("👍")).status).toBe(204);
  await pageHeld.promise;
  deliver.at(-1)!(sixthNote.frames[0]!);
  const bubble = window.getByText("Sixth", { exact: true }).locator("..");
  await bubble.waitFor();
  expect((await reactTo("🎉")).status).toBe(204);
  await bubble.getByRole("button", { name: "🎉 1" }).waitFor();
  pageRelease.resolve();
  await kofi.waitForTimeout(1_000);
  await bubble.getByRole("button", { name: "🎉 1" }).waitFor();
  await bubble.getByRole("button", { name: "👍 1" }).waitFor();

  await kofi.keyboard.press("Escape");
  await window.waitFor({ state: "detached" });
  await kofi.mouse.move(4, 400);
  const kofiPost = await fetch(new URL(`/api/talk/threads/${thread.id}/messages`, origin()), {
    method: "POST",
    headers: { cookie: kofiCookie, "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ body: "Mine, earlier" }),
  });
  expect(kofiPost.status).toBe(201);
  await mine.held.promise;
  heldReads.length = 0;
  const readLater = Promise.withResolvers<void>();
  readSeen.push(readLater);
  holdReads = true;
  const readMine = await fetch(new URL(`/api/talk/threads/${thread.id}/read`, origin()), {
    method: "PUT",
    headers: { cookie: kofiCookie, origin: WEB_ORIGIN },
  });
  expect(readMine.status).toBe(204);
  await readLater.promise;
  holdReads = false;
  await post(`/threads/${thread.id}/messages`, { body: "Seventh" });
  await stack.getByRole("button", { name: "Ana Lima, 1 unread" }).waitFor();
  deliver.at(-1)!(mine.frames[0]!);
  deliver.at(-1)!(heldReads[0]!);
  await kofi.waitForTimeout(1_000);
  await stack.getByRole("button", { name: "Ana Lima, 1 unread" }).waitFor();

  await stack.getByRole("button", { name: /^Ana Lima/ }).click();
  const eighth = (await post(`/threads/${thread.id}/messages`, { body: "Eighth" })).message;
  const fire = window.getByText("Eighth", { exact: true }).locator("..");
  await fire.waitFor();
  watched.messageId = eighth.id;
  const fireOn = (method: string) =>
    fetch(
      new URL(`/api/talk/messages/${eighth.id}/reactions/${encodeURIComponent("🔥")}`, origin()),
      { method, headers: { cookie, origin: WEB_ORIGIN } },
    );
  expect((await fireOn("PUT")).status).toBe(204);
  await watched.added.promise;
  expect((await fireOn("DELETE")).status).toBe(204);
  await watched.removed.promise;
  await kofi.setViewportSize({ width: 600, height: wide.height });
  await stack.waitFor({ state: "detached" });
  const refetched = kofi.waitForResponse(
    (r) => r.request().method() === "GET" && r.url().includes(`/threads/${thread.id}/messages`),
  );
  await kofi.setViewportSize(wide);
  await stack.waitFor();
  if (!(await window.isVisible())) await stack.getByRole("button", { name: /^Ana Lima/ }).click();
  await refetched;
  await fire.waitFor();
  deliver.at(-1)!(watched.frames[0]!);
  await kofi.waitForTimeout(1_000);
  expect(await fire.getByRole("button", { name: /^🔥/ }).count()).toBe(0);

  watched.messageId = "";
  dropReactions.of = eighth.id;
  const pageAnswered = Promise.withResolvers<void>();
  const pageGo = Promise.withResolvers<void>();
  let holdNextPage = false;
  await kofi.route(`**/api/talk/threads/${thread.id}/messages`, async (route) => {
    if (!holdNextPage || route.request().method() !== "GET") return route.fallback();
    holdNextPage = false;
    const answer = await route.fetch();
    pageAnswered.resolve();
    await pageGo.promise;
    await route.fulfill({ response: answer });
  });
  const thumbs = await fetch(
    new URL(`/api/talk/messages/${eighth.id}/reactions/${encodeURIComponent("👍")}`, origin()),
    { method: "PUT", headers: { cookie, origin: WEB_ORIGIN } },
  );
  expect(thumbs.status).toBe(204);
  holdNextPage = true;
  await kofi.setViewportSize({ width: 600, height: wide.height });
  await stack.waitFor({ state: "detached" });
  await kofi.setViewportSize(wide);
  await stack.waitFor();
  if (!(await window.isVisible())) await stack.getByRole("button", { name: /^Ana Lima/ }).click();
  await pageAnswered.promise;
  await fire.hover();
  await fire.getByRole("button", { name: "React 🎉" }).click();
  await fire.getByRole("button", { name: "🎉 1" }).waitFor();
  pageGo.resolve();
  await kofi.waitForTimeout(1_000);
  await fire.getByRole("button", { name: "🎉 1" }).waitFor();
  await fire.getByRole("button", { name: "👍 1" }).waitFor();
});
