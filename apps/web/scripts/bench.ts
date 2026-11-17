import { createServer } from "node:net";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
} from "../../worker/e2e/support.ts";
import buildWorker from "../../worker/e2e/global-setup.ts";
import { startHttp2Proxy } from "./h2-proxy.ts";
import { createDb } from "@omni/db";
import { sql } from "drizzle-orm";

await buildWorker();

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const LATENCY = Number(process.env.BENCH_LATENCY ?? 0);
const EMAIL = "member-org1-1@seed.test";
const admin = process.env.DATABASE_URL;
if (!admin) throw new Error("DATABASE_URL is not set (the admin connection of `pnpm stack:up`)");
const url = new URL(admin);
url.pathname = `/${process.env.PERF_DATABASE ?? "omni_perf"}`;

const { db, close } = createDb(url.toString(), { onnotice: () => {} });
await db.execute(sql`
  insert into mailboxes (id, org_id, address, kind, credentials_enc, status)
  select 'bench-system', 'org3', ${SYSTEM_MAIL_FROM}, 'shared', 'seed', 'active'
  where not exists (select 1 from mailboxes where address = ${SYSTEM_MAIL_FROM})`);

const port = await new Promise<number>((resolve) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const { port: free } = s.address() as { port: number };
    s.close(() => resolve(free));
  });
});
const mailService = await startMailServiceEndpoint();
const worker = await startWorkerWithNetwork({
  databaseUrl: url.toString(),
  mailServiceUrl: mailService.url,
  port,
  vars: { BETTER_AUTH_URL: `http://127.0.0.1:${port}`, RATE_LIMIT_MAGIC_LINK: "1000/60" },
});
const workerOrigin = String(worker.url).replace(/\/$/, "");
const cookie = await signIn({ url: new URL(workerOrigin) }, db, EMAIL);
await close();
const h2 = process.env.BENCH_H2 ? await startHttp2Proxy(new URL(workerOrigin)) : undefined;
const origin = h2?.origin ?? workerOrigin;

const browser = await chromium.launch();

async function newContext() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: !!h2,
  });
  await context.addInitScript(IN_PAGE);
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  return context;
}

async function throttled(context: BrowserContext) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  if (LATENCY) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: LATENCY,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
  return page;
}

const rows = (page: Page) =>
  page.locator("[role='grid'] [role='row']:not([aria-busy='true'] [role='row'])");
const firstRowShown = (page: Page) => rows(page).first().waitFor({ state: "visible" });
const articleShown = (page: Page) =>
  page.locator("article:not([aria-busy='true'] article)").first().waitFor();

const IN_PAGE = () => {
  const w = window as unknown as Record<string, unknown>;
  const visible = (test: () => boolean) =>
    new Promise<number>((resolve) => {
      const check = () => {
        if (!test()) return false;
        requestAnimationFrame(() => resolve(performance.now()));
        return true;
      };
      if (check()) return;
      const observer = new MutationObserver(() => check() && observer.disconnect());
      observer.observe(document, { subtree: true, childList: true, attributes: true });
    });
  const real = (el: Element) => !el.closest("[aria-busy='true']");
  w.benchTests = {
    rows: (label?: string) => () =>
      [...document.querySelectorAll("[role='grid']")].some(
        (g) =>
          (!label || g.getAttribute("aria-label") === label) &&
          real(g) &&
          !!g.querySelector("[role='row']"),
      ),
    heading: (label: string) => () =>
      [...document.querySelectorAll("h1, h2, [role='heading']")].some((h) =>
        h.textContent?.trim().startsWith(label),
      ),
    conversation: () => () => !!document.querySelector("section[aria-label='Conversation']"),
    article: () => () => [...document.querySelectorAll("article")].some(real),
  };
  w.benchVisible = visible;
  addEventListener("pointerdown", () => (w.benchPressedAt = performance.now()), true);
  w.benchFirstRow = visible((w.benchTests as Record<string, () => () => boolean>).rows!());
};

type Wait = [test: "rows" | "heading" | "conversation" | "article", arg?: string];
async function timed(page: Page, waits: Wait[], act: () => Promise<void>) {
  await page.evaluate((waits) => {
    const w = window as unknown as {
      benchTests: Record<string, (arg?: string) => () => boolean>;
      benchVisible: (test: () => boolean) => Promise<number>;
      benchPending: Promise<number[]>;
      benchPressedAt: number;
    };
    w.benchPressedAt = 0;
    w.benchPending = Promise.all(
      waits.map(([test, arg]) => w.benchVisible(w.benchTests[test]!(arg))),
    );
  }, waits);
  await act();
  return page.evaluate(async () => {
    const w = window as unknown as { benchPending: Promise<number[]>; benchPressedAt: number };
    const at = await w.benchPending;
    return at.map((t) => t - w.benchPressedAt);
  });
}

let protocolChecked = false;
async function startup(context: BrowserContext) {
  const page = await throttled(context);
  await page.goto(`${origin}/inbox`);
  await firstRowShown(page);
  if (h2 && !protocolChecked) {
    protocolChecked = true;
    const protocols = await page.evaluate(() => [
      ...new Set(
        performance
          .getEntriesByType("resource")
          .map((e) => (e as PerformanceResourceTiming).nextHopProtocol),
      ),
    ]);
    console.warn(`protocols seen: ${protocols.join(", ")}`);
  }
  const ms = await page.evaluate(
    () => (window as unknown as { benchFirstRow: Promise<number> }).benchFirstRow,
  );
  const bytes = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => /\.(js|css)$/.test(new URL(e.name).pathname))
      .reduce((sum, e) => sum + (e as PerformanceResourceTiming).decodedBodySize, 0),
  );
  await page.close();
  return { ms, bytes };
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const results = new Map<string, number[]>();
const record = (name: string, value: number) =>
  results.set(name, [...(results.get(name) ?? []), value]);

for (let run = 0; run < RUNS; run++) {
  const context = await newContext();
  const cold = await startup(context);
  record("startup ms", cold.ms);
  record("startup JS+CSS kB", cold.bytes / 1024);
  record("startup cached ms", (await startup(context)).ms);

  const page = await throttled(context);
  await page.goto(`${origin}/inbox`);
  await firstRowShown(page);
  await page.waitForLoadState("networkidle");

  for (const [label, path] of [
    ["Later", "/later"],
    ["All mail", "/all"],
    ["Needs reply", "/inbox?lane=needs_reply"],
    ["Inbox", "/inbox"],
  ] as const) {
    const [screen, shown] = await timed(
      page,
      [
        ["heading", label],
        ["rows", label],
      ],
      () => page.getByRole("link", { name: label, exact: true }).first().click(),
    );
    record(`switch → ${label} screen ms`, screen!);
    record(`switch → ${label} ms`, shown!);
    await page.waitForURL((u) => u.pathname + u.search === path);
  }
  await page.waitForLoadState("networkidle");

  for (const n of [0, 3, 6]) {
    const row = rows(page).nth(n);
    const [screen, shown] = await timed(page, [["conversation"], ["article"]], () => row.click());
    record("open thread screen ms", screen!);
    record("open thread ms", shown!);
    await articleShown(page);
    await page.goBack();
    await page.getByRole("region", { name: "Conversation" }).waitFor({ state: "detached" });
  }

  const grid = page.getByRole("grid");
  const fetched = { threads: 0, at500: 0, at1000: 0 };
  const onResponse = (res: { url(): string }) => {
    const u = new URL(res.url());
    if (u.pathname === "/api/threads" && u.searchParams.has("cursor")) {
      fetched.threads += Number(u.searchParams.get("limit"));
      if (fetched.threads >= 500 && !fetched.at500) fetched.at500 = performance.now();
      if (fetched.threads >= 1000 && !fetched.at1000) fetched.at1000 = performance.now();
    }
  };
  page.on("response", onResponse);
  const started = performance.now();
  while (fetched.threads < 1000) {
    await grid.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(16);
  }
  record("older: first 500 threads ms", fetched.at500 - started);
  record("older: next 500 threads ms", fetched.at1000 - fetched.at500);
  await page.waitForLoadState("networkidle");
  page.off("response", onResponse);

  await grid.evaluate((el) => el.scrollTo({ top: 0 }));
  await grid.hover();
  await page.evaluate(() => {
    const w = window as unknown as { benchFrames: number[] };
    w.benchFrames = [];
    let last = performance.now();
    const tick = (now: number) => {
      w.benchFrames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.waitForTimeout(3000);
  const idle = await page.evaluate(() => {
    const w = window as unknown as { benchFrames: number[] };
    return w.benchFrames.splice(0).length;
  });
  record("idle: frames in 3 s", idle);
  const until = performance.now() + 3000;
  while (performance.now() < until) await page.mouse.wheel(0, 400);
  const frames = await page.evaluate(
    () => (window as unknown as { benchFrames: number[] }).benchFrames,
  );
  record("scroll: frames > 50 ms", frames.filter((f) => f > 50).length);
  record("scroll: worst frame ms", Math.max(...frames));
  record("scroll: frames in 3 s", frames.length);
  const api = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => new URL(e.name).pathname.startsWith("/api/"))
      .map((e) => {
        const u = new URL(e.name);
        const route = u.pathname
          .replace(/\/threads\/[^/]+$/, "/threads/:id")
          .concat(
            u.pathname === "/api/threads"
              ? u.searchParams.has("cursor")
                ? " (older page)"
                : " (first page)"
              : "",
          );
        return [route, e.responseStart - e.requestStart] as const;
      }),
  );
  for (const [route, ms] of api) record(`api ${route} ms`, ms);
  for (let i = 0; i < 3; i++) {
    record(
      "api done view (first page) ms",
      await page.evaluate(async () => {
        const sent = performance.now();
        const res = await fetch("/api/threads?scope=all&view=done&limit=50");
        await res.json();
        return performance.now() - sent;
      }),
    );
  }
  await context.close();
}

for (const [name, values] of results) {
  const shown = name.startsWith("api ")
    ? `n=${values.length}`
    : `[${values.map((v) => v.toFixed(0)).join(", ")}]`;
  console.log(`${name.padEnd(34)} ${median(values).toFixed(0).padStart(8)}   ${shown}`);
}
await browser.close();
await h2?.close();
await worker.close();
await mailService.close();
