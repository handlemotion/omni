import { randomBytes } from "node:crypto";
import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const UPLOAD_MB = Number(process.env.BENCH_UPLOAD_MB ?? 256);
const SMALL_FILES = Number(process.env.BENCH_SMALL_FILES ?? 200);
const UPLOADS_ONLY = process.env.BENCH_ONLY === "uploads";
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
const ids = (await db.execute(sql`
  select (select id from storage_nodes where name = 'Folder 02' and owner_member_id = 'member-org1-1') as big,
         (select id from storage_nodes where name = 'Level 12' and owner_member_id = 'member-org1-1') as deep
`)) as unknown as { big: string; deep: string }[];
const { big, deep } = ids[0]!;
if (!big || !deep) throw new Error("no Drive seed: run `pnpm --filter @omni/db perf:seed` again");

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
const scratch = await mkdtemp(join(tmpdir(), "bench-drive-"));
const bigSource = join(scratch, "source.bin");
await writeFile(bigSource, randomBytes(UPLOAD_MB * 1024 * 1024));

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
  const rows = (label?: string) => () =>
    [...document.querySelectorAll("[role='grid'], [role='treegrid']")].some(
      (g) =>
        (!label || (g.getAttribute("aria-label") ?? "").startsWith(label)) &&
        real(g) &&
        !!g.querySelector("[role='row'] [role='gridcell'], [role='row'][data-key]"),
    );
  w.benchTests = { rows };
  w.benchVisible = visible;
  addEventListener("pointerdown", () => (w.benchPressedAt = performance.now()), true);
  w.benchFirstRow = visible(rows());
};

async function timed(page: Page, label: string, act: () => Promise<void>, fromNav = false) {
  await page.evaluate((label) => {
    const w = window as unknown as {
      benchTests: Record<string, (arg?: string) => () => boolean>;
      benchVisible: (test: () => boolean) => Promise<number>;
      benchPending: Promise<number>;
      benchPressedAt: number;
    };
    w.benchPressedAt = performance.now();
    w.benchPending = w.benchVisible(w.benchTests.rows!(label));
  }, label);
  await act();
  return page.evaluate(async (fromNav) => {
    const w = window as unknown as { benchPending: Promise<number>; benchPressedAt: number };
    const at = await w.benchPending;
    return at - (fromNav ? 0 : w.benchPressedAt);
  }, fromNav);
}

async function startup(context: BrowserContext) {
  const page = await throttled(context);
  await page.goto(`${origin}/files/my`);
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

const uploadInput = (page: Page) => page.locator("input[type=file]:not([webkitdirectory])").first();

const uploadsDone = (page: Page, prefix: string) =>
  page.waitForFunction(
    (prefix) =>
      ![...document.querySelectorAll("[aria-label]")].some((el) =>
        (el.getAttribute("aria-label") ?? "").startsWith(`Cancel ${prefix}`),
      ),
    prefix,
    { timeout: 600_000, polling: 100 },
  );

async function uploads(context: BrowserContext, run: number) {
  const page = await context.newPage();
  await page.goto(`${origin}/files/my`);
  await page.evaluate(
    () => (window as unknown as { benchFirstRow: Promise<number> }).benchFirstRow,
  );
  await page.waitForLoadState("networkidle");

  const big = join(scratch, `bench-big-${run}-${Date.now()}.bin`);
  await link(bigSource, big);
  let started = performance.now();
  await uploadInput(page).setInputFiles(big);
  await page.waitForFunction(
    () => !!document.querySelector("[aria-label^='Cancel bench-big']"),
    undefined,
    { timeout: 60_000, polling: 50 },
  );
  await uploadsDone(page, "bench-big");
  record("upload: one large file MiB/s", UPLOAD_MB / ((performance.now() - started) / 1000));

  const tag = `bench-small-${run}-${Date.now()}`;
  let lists = 0;
  const onRequest = (req: { url(): string; method(): string }) => {
    const u = new URL(req.url());
    if (u.pathname === "/api/storage/nodes" && req.method() === "GET") lists += 1;
  };
  page.on("request", onRequest);
  started = performance.now();
  await uploadInput(page).setInputFiles(
    Array.from({ length: SMALL_FILES }, (_, i) => ({
      name: `${tag}-${i}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`${tag}-${i}`),
    })),
  );
  await uploadsDone(page, tag);
  record(`upload: ${SMALL_FILES} small files ms`, performance.now() - started);
  await page.waitForLoadState("networkidle");
  page.off("request", onRequest);
  record(`upload: listing GETs for ${SMALL_FILES} files`, lists);
  await page.close();
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const results = new Map<string, number[]>();
const record = (name: string, value: number) => {
  if (process.env.BENCH_VERBOSE) console.warn(name, Math.round(value));
  results.set(name, [...(results.get(name) ?? []), value]);
};

const scroller = (page: Page) => page.locator(".overflow-y-auto:has([role='grid'])").first();

for (let run = 0; run < RUNS; run++) {
  const context = await newContext();
  if (UPLOADS_ONLY) {
    await uploads(context, run);
    await context.close();
    continue;
  }
  const cold = await startup(context);
  record("startup ms", cold.ms);
  record("startup JS+CSS kB", cold.bytes / 1024);
  record("startup cached ms", (await startup(context)).ms);

  const page = await throttled(context);
  await page.goto(`${origin}/files/my`);
  await page.evaluate(
    () => (window as unknown as { benchFirstRow: Promise<number> }).benchFirstRow,
  );
  await page.waitForLoadState("networkidle");

  for (const [link, grid] of [
    ["Team", "Team"],
    ["Trash", "Trash"],
    ["Personal", "Personal"],
  ] as const) {
    const ms = await timed(page, grid, () =>
      page.getByRole("link", { name: link, exact: true }).first().click(),
    );
    record(`switch → ${link} ms`, ms);
    await page.waitForLoadState("networkidle");
  }

  const open = await timed(page, "Folder 02 files", () =>
    page.getByRole("row", { name: "Folder 02" }).first().click(),
  );
  record("open folder ms", open);
  await page.waitForLoadState("networkidle");

  const box = scroller(page);
  const count = () =>
    page.evaluate(
      () =>
        document.querySelectorAll("[aria-label='Folder 02 files'] [role='row']").length ||
        document.querySelectorAll("[aria-label='Folder 02 files'] [data-key]").length,
    );
  const loaded = { files: 0 };
  const onResponse = (res: { url(): string }) => {
    const u = new URL(res.url());
    if (u.pathname === "/api/storage/nodes" && u.searchParams.has("cursor")) {
      loaded.files += Number(u.searchParams.get("limit"));
    }
  };
  page.on("response", onResponse);
  loaded.files = 100;
  const marks: number[] = [];
  let stalls = 0;
  let started = performance.now();
  for (const target of [1000, 2000, 3000]) {
    let seen = loaded.files;
    let since = performance.now();
    while (loaded.files < target) {
      await box.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
      await page.waitForTimeout(16);
      if (loaded.files !== seen) {
        seen = loaded.files;
        since = performance.now();
      } else if (performance.now() - since > 2000) {
        stalls += 1;
        await box.evaluate((el) => el.scrollBy({ top: -3000 }));
        await page.waitForTimeout(100);
        since = performance.now();
      }
    }
    marks.push(performance.now() - started);
    started = performance.now();
  }
  page.off("response", onResponse);
  record("older: stalls (2 s at the end, nothing loading)", stalls);
  record("older: files 100→1000 ms", marks[0]!);
  record("older: files 1000→2000 ms", marks[1]!);
  record("older: files 2000→3000 ms", marks[2]!);
  await page.waitForLoadState("networkidle");
  record("rows in DOM (3000 loaded)", await count());

  await box.evaluate((el) => el.scrollTo({ top: 0 }));
  await box.hover();
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
  const idle = await page.evaluate(
    () => (window as unknown as { benchFrames: number[] }).benchFrames.splice(0).length,
  );
  record("idle: frames in 3 s", idle);
  const until = performance.now() + 3000;
  while (performance.now() < until) await page.mouse.wheel(0, 400);
  const frames = await page.evaluate(
    () => (window as unknown as { benchFrames: number[] }).benchFrames,
  );
  record("scroll: frames > 50 ms", frames.filter((f) => f > 50).length);
  record("scroll: worst frame ms", Math.max(...frames));
  record("scroll: frames in 3 s", frames.length);

  await box.evaluate((el) => el.scrollTo({ top: 0 }));
  await page.evaluate(() => {
    const w = window as unknown as {
      benchVisible: (t: () => boolean) => Promise<number>;
      benchSelect: Promise<number>;
    };
    w.benchSelect = w.benchVisible(
      () =>
        !!document.querySelector(
          "[aria-label='Folder 02 files'] [role='row'][aria-selected='true']",
        ),
    );
  });
  await page.locator("[aria-label='Folder 02 files'] [role='row']").nth(2).click();
  record(
    "select file (3000 loaded) ms",
    await page.evaluate(async () => {
      const w = window as unknown as { benchSelect: Promise<number>; benchPressedAt: number };
      return (await w.benchSelect) - w.benchPressedAt;
    }),
  );
  await page.goBack();

  const deepMs = await timed(page, "Level 12", async () => {
    await page.evaluate((path) => {
      (window as unknown as { benchPressedAt: number }).benchPressedAt = performance.now();
      history.pushState({}, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/files/my/${deep}`);
  });
  record("open deep folder ms", deepMs);
  await page.waitForLoadState("networkidle");

  await page.getByRole("link", { name: "Trash", exact: true }).first().click();
  const trashBox = page.locator(".overflow-y-auto:has([aria-label='Trash'])").first();
  await trashBox.waitFor();
  const trash = { items: 100 };
  const onTrash = (res: { url(): string }) => {
    const u = new URL(res.url());
    if (u.pathname === "/api/storage/trash" && u.searchParams.has("cursor")) {
      trash.items += Number(u.searchParams.get("limit"));
    }
  };
  page.on("response", onTrash);
  const trashStarted = performance.now();
  while (trash.items < 1000) {
    await trashBox.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(16);
    if (performance.now() - trashStarted > 120_000) throw new Error("Trash stopped loading");
  }
  record("trash: items 100→1000 ms", performance.now() - trashStarted);
  page.off("response", onTrash);
  await page.waitForLoadState("networkidle");
  record(
    "trash: rows in DOM (1000 loaded)",
    await page.locator("[aria-label='Trash'] [role='row']").count(),
  );
  await trashBox.evaluate((el) => el.scrollTo({ top: 0 }));
  await trashBox.hover();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as unknown as { benchFrames: number[] }).benchFrames.splice(0);
  });
  const trashUntil = performance.now() + 3000;
  while (performance.now() < trashUntil) await page.mouse.wheel(0, 400);
  const trashFrames = await page.evaluate(
    () => (window as unknown as { benchFrames: number[] }).benchFrames,
  );
  record("trash scroll: frames > 50 ms", trashFrames.filter((f) => f > 50).length);
  record("trash scroll: frames in 3 s", trashFrames.length);

  const api = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => new URL(e.name).pathname.startsWith("/api/storage"))
      .map((e) => {
        const u = new URL(e.name);
        const route = u.pathname.concat(
          u.pathname === "/api/storage/nodes"
            ? u.searchParams.has("cursor")
              ? " (older page)"
              : u.searchParams.has("parent")
                ? " (folder)"
                : " (root)"
            : "",
        );
        return [route, e.responseStart - e.requestStart] as const;
      }),
  );
  for (const [route, ms] of api) record(`api ${route} ms`, ms);
  await uploads(context, run);
  await context.close();
}

for (const [name, values] of results) {
  const shown = name.startsWith("api ")
    ? `n=${values.length}`
    : `[${values.map((v) => v.toFixed(0)).join(", ")}]`;
  console.log(`${name.padEnd(34)} ${median(values).toFixed(0).padStart(8)}   ${shown}`);
}
await browser.close();
await rm(scratch, { recursive: true, force: true });
await h2?.close();
await worker.close();
await mailService.close();
