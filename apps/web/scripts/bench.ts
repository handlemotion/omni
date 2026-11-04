// Measures what a person feels in the web app, in a real Chromium, on the web build served by the
// real Worker under `wrangler dev`, reading the `perf:seed` database (60k threads, 200k messages).
// The CPU is slowed 4x, like a mid-range laptop on battery; BENCH_LATENCY adds round-trip time
// to every request (none by default). Each number is the median of BENCH_RUNS (5).
//
//   pnpm stack:up && pnpm --filter @omni/db perf:seed      # once
//   DATABASE_URL=postgres://postgres:postgres@localhost:54329/omni pnpm --filter @omni/web bench
//
// The Worker builds the web app as it starts (`wrangler.jsonc`), so a run measures the code as it
// is on disk. Run it before and after a change and compare the medians.
//
// - startup: a new browser profile opens /inbox until the first row shows; JS and CSS bytes.
// - startup (cached): the same, with the HTTP cache from the first load.
// - switch: sidebar link to the next list's first row (Queue, All mail, Needs reply, Inbox).
// - open: a click on a row to its thread on screen.
// - older: scrolling to the end of the list until 10 more pages (500 threads) have loaded, and
//   the time per page early and late (a cost that grows with the loaded list shows here).
// - scroll: 3 s of steady wheel scrolling: frames over 50 ms, the slowest frame, and frames drawn
//   (against the same 3 s idle, 180 at 60 Hz).
// - api: each route's time to first byte as the page saw it, and the Done view's first page.
import { createServer } from "node:net";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
} from "../../worker/e2e/support.ts";
import { createDb } from "@omni/db";
import { sql } from "drizzle-orm";

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
/** Added round-trip time per request, in ms: what a real connection to the edge costs. */
const LATENCY = Number(process.env.BENCH_LATENCY ?? 0);
const EMAIL = "member-org1-1@seed.test"; // sees all 12 org1 mailboxes
const admin = process.env.DATABASE_URL;
if (!admin) throw new Error("DATABASE_URL is not set (the admin connection of `pnpm stack:up`)");
const url = new URL(admin);
url.pathname = `/${process.env.PERF_DATABASE ?? "omni_perf"}`;

// signIn reads the magic link from the outbox, which needs the system mailbox to send from.
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
const origin = String(worker.url).replace(/\/$/, "");
const cookie = await signIn({ url: new URL(origin) }, db, EMAIL);
await close();

const browser = await chromium.launch();

async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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

const rows = (page: Page) => page.locator("[role='grid'] [role='row']");
const firstRowShown = (page: Page) => rows(page).first().waitFor({ state: "visible" });

async function startup(context: BrowserContext) {
  const page = await throttled(context);
  const started = performance.now();
  await page.goto(`${origin}/inbox`);
  await firstRowShown(page);
  const ms = performance.now() - started;
  // Uncompressed bytes of the JS and CSS the page had loaded when its first row showed.
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
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
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

  // Screens: each sidebar link until its list's first row (a new list, not the old one).
  for (const [label, path] of [
    ["Queue", "/queue"],
    ["All mail", "/all"],
    ["Needs reply", "/inbox?lane=needs_reply"],
    ["Inbox", "/inbox"],
  ] as const) {
    const started = performance.now();
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await page.waitForURL((u) => u.pathname + u.search === path);
    await page.getByRole("grid").waitFor();
    await firstRowShown(page);
    record(`switch → ${label} ms`, performance.now() - started);
  }
  await page.waitForLoadState("networkidle");

  // Open three threads in turn, as a person reading down the list would.
  for (const n of [0, 3, 6]) {
    const row = rows(page).nth(n);
    const started = performance.now();
    await row.click();
    await page.locator("article").waitFor();
    record("open thread ms", performance.now() - started);
    await page.goBack();
    await page.locator("article").waitFor({ state: "detached" });
  }

  // Older mail: scroll to the end until 10 more pages have loaded.
  const grid = page.getByRole("grid");
  const fetched = { pages: 0, at: [] as number[] };
  const onResponse = (res: { url(): string }) => {
    if (/\/api\/threads\?/.test(res.url()) && res.url().includes("cursor=")) {
      fetched.pages++;
      fetched.at.push(performance.now());
    }
  };
  page.on("response", onResponse);
  const started = performance.now();
  while (fetched.pages < 10) {
    await grid.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(16);
  }
  await page.waitForLoadState("networkidle");
  record("older: 10 pages ms", performance.now() - started);
  // Page to page: the first pages against the last, so cost that grows with the list shows.
  const gaps = fetched.at.map((t, i) => t - (fetched.at[i - 1] ?? started));
  record("older: pages 1-3 each ms", mean(gaps.slice(0, 3)));
  record("older: pages 8-10 each ms", mean(gaps.slice(7, 10)));
  page.off("response", onResponse);

  // Steady scrolling through what is loaded: frame times while the wheel turns.
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
  // Control: the same 3 s idle, so a slow frame clock is not mistaken for scroll jank.
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
  // How long the API took to answer, as the page saw it, per route.
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
  // The Done view has no sidebar link: its first page straight from the API, as its loader asks.
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
await worker.close();
await mailService.close();
