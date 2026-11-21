import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
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
  vars: {
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    RATE_LIMIT_MAGIC_LINK: "1000/60",
  },
});
const workerOrigin = String(worker.url).replace(/\/$/, "");
const cookie = await signIn({ url: new URL(workerOrigin) }, db, EMAIL);
const h2 = process.env.BENCH_H2 ? await startHttp2Proxy(new URL(workerOrigin)) : undefined;
const origin = h2?.origin ?? workerOrigin;
const browser = await chromium.launch();

async function newContext() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: !!h2,
  });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        url: origin,
      };
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

const FILES = [
  { name: "a-photo.jpg", kind: "image" },
  { name: "b-minutes.pdf", kind: "pdf" },
  { name: "c-module.ts", kind: "code" },
  { name: "d-table.csv", kind: "csv" },
] as const;
type Kind = (typeof FILES)[number]["kind"];

const FOLDER = `Bench previews ${Date.now()}`;

async function photo(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4000;
    canvas.height = 3000;
    const g = canvas.getContext("2d")!;
    const image = g.createImageData(canvas.width, canvas.height);
    let seed = 7;
    for (let i = 0; i < image.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const x = (i / 4) % canvas.width;
      image.data[i] = (x / 16 + (seed & 63)) & 255;
      image.data[i + 1] = ((seed >> 8) & 127) + 64;
      image.data[i + 2] = (i / 4 / canvas.width / 12 + (seed & 31)) & 255;
      image.data[i + 3] = 255;
    }
    g.putImageData(image, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.92).split(",")[1]!;
  });
  return Buffer.from(base64, "base64");
}

const code = () =>
  Array.from(
    { length: 6000 },
    (_, i) =>
      `export function step${i}(value: number): number {\n  return value * ${i} + ${i % 7}; // line ${i}\n}\n`,
  ).join("");

const csv = () =>
  [
    "id,name,email,amount,date",
    ...Array.from(
      { length: 5000 },
      (_, i) =>
        `${i},Person ${i},person${i}@example.com,${(i * 13.37).toFixed(2)},2026-01-${(i % 28) + 1}`,
    ),
  ].join("\n");

async function seedFolder() {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/files/my`);
  const made = await page.evaluate(async (name) => {
    const res = await fetch("/api/storage/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, space: "personal" }),
    });
    return ((await res.json()) as { node: { id: string } }).node.id;
  }, FOLDER);
  await page.goto(`${origin}/files/my/${made}`);
  await page.getByRole("button", { name: "Upload" }).first().waitFor();
  const files = [
    { name: FILES[0].name, mimeType: "image/jpeg", buffer: await photo(page) },
    {
      name: FILES[1].name,
      mimeType: "application/pdf",
      buffer: await readFile(join(import.meta.dirname, "../../../fixtures/drive/minutes-scan.pdf")),
    },
    {
      name: FILES[2].name,
      mimeType: "text/plain",
      buffer: Buffer.from(code()),
    },
    { name: FILES[3].name, mimeType: "text/csv", buffer: Buffer.from(csv()) },
  ];
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await page.waitForFunction(
    (n) => document.querySelectorAll(`[aria-label$=' files'] [role='row']`).length >= n,
    files.length,
    { timeout: 120_000, polling: 200 },
  );
  await page.waitForFunction(
    () => ![...document.querySelectorAll("[aria-label^='Cancel ']")].length,
    undefined,
    { timeout: 120_000, polling: 200 },
  );
  await context.close();
  return made;
}

const folderId = await seedFolder();

const WATCH = () => {
  const w = window as unknown as Record<string, unknown>;
  const stage = (name: string) =>
    [...document.querySelectorAll("section[aria-label]")].find(
      (s) => s.getAttribute("aria-label") === name,
    );
  const shown: Record<string, (s: Element) => { first: boolean; full: boolean }> = {
    image: (s) => {
      const imgs = [...s.querySelectorAll("img")].filter(
        (i) => i.complete && i.naturalWidth > 0 && getComputedStyle(i).opacity !== "0",
      );
      return {
        first: imgs.length > 0,
        full: imgs.some((i) => i.src.startsWith("blob:")),
      };
    },
    pdf: (s) => {
      const drawn = [...s.querySelectorAll("canvas, img")].some(
        (c) =>
          (c instanceof HTMLCanvasElement && c.width > 0) ||
          (c instanceof HTMLImageElement && c.complete && c.naturalWidth > 0),
      );
      const canvas = !!s.querySelector(".react-pdf__Page__canvas");
      return {
        first: drawn,
        full: canvas && !s.querySelector(".react-pdf__Page [aria-busy='true']"),
      };
    },
    code: (s) => {
      const has = !!s.querySelector("pre") && (s.textContent ?? "").includes("step1(");
      return { first: has, full: has };
    },
    csv: (s) => {
      const has = (s.textContent ?? "").includes("person1@example.com");
      return { first: has, full: has };
    },
  };
  for (const type of ["pointerdown", "keydown"]) {
    addEventListener(type, () => (w.benchPressedAt = performance.now()), true);
  }
  w.benchWatch = (name: string, kind: string) =>
    new Promise<Record<string, number>>((resolve) => {
      const out = { first: 0, full: 0, panel: 0 };
      const check = () => {
        const s = stage(name);
        if (!s) return false;
        out.panel ||= performance.now();
        const state = shown[kind]!(s);
        const now = performance.now();
        if (state.first && !out.first) out.first = now;
        if (state.full && !out.full) out.full = now;
        return !!out.first && !!out.full;
      };
      const until = performance.now() + 20_000;
      const tick = () => {
        if (check() || performance.now() > until) return resolve(out);
        requestAnimationFrame(tick);
      };
      tick();
    });
};

interface Watched {
  first: number;
  full: number;
  panel: number;
}

async function open(page: Page, name: string, kind: Kind, how: "click" | "next") {
  let reads = 0;
  const onRequest = (req: { url(): string }) => {
    if (new URL(req.url()).pathname.endsWith("/content")) reads += 1;
  };
  page.on("request", onRequest);
  await page.evaluate(
    ([name, kind]) => {
      const w = window as unknown as {
        benchWatch: (n: string, k: string) => Promise<Watched>;
        benchPending: Promise<Watched>;
      };
      w.benchPending = w.benchWatch(name!, kind!);
    },
    [name, kind],
  );
  if (how === "click") {
    const row = page.getByRole("row", { name, exact: false }).first();
    await row.hover();
    await page.waitForTimeout(150);
    await row.click();
  } else {
    await page.keyboard.press("ArrowRight");
  }
  const { at, pressed } = await page.evaluate(async () => {
    const w = window as unknown as {
      benchPending: Promise<Watched>;
      benchPressedAt: number;
    };
    return { at: await w.benchPending, pressed: w.benchPressedAt };
  });
  await page.waitForTimeout(500);
  page.off("request", onRequest);
  return {
    first: at.first - pressed,
    full: at.full - pressed,
    panel: at.panel - pressed,
    reads,
  };
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const results = new Map<string, number[]>();
const record = (name: string, value: number) => {
  if (process.env.BENCH_VERBOSE) console.warn(name, Math.round(value));
  results.set(name, [...(results.get(name) ?? []), value]);
};

for (let run = 0; run < RUNS; run++) {
  const context = await newContext();
  await context.addInitScript(WATCH);
  const page = await throttled(context);
  await page.goto(`${origin}/files/my/${folderId}`);
  await page.getByRole("row", { name: FILES[0].name }).first().waitFor({ timeout: 60_000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);

  for (const round of ["first", "again"] as const) {
    for (const file of FILES) {
      const ms = await open(page, file.name, file.kind, "click");
      record(`${round} open ${file.kind}: panel ms`, ms.panel);
      record(`${round} open ${file.kind}: shows ms`, ms.first);
      if (file.kind === "image" || file.kind === "pdf") {
        record(`${round} open ${file.kind}: full ms`, ms.full);
      }
      record(`${round} open ${file.kind}: byte reads`, ms.reads);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  }
  await context.close();

  const stepping = await newContext();
  await stepping.addInitScript(WATCH);
  const step = await throttled(stepping);
  await step.goto(`${origin}/files/my/${folderId}`);
  await step.getByRole("row", { name: FILES[0].name }).first().waitFor({ timeout: 60_000 });
  await step.waitForLoadState("networkidle");
  await step.waitForTimeout(1500);
  await open(step, FILES[0].name, FILES[0].kind, "click");
  let at: string = FILES[0].name;
  for (const file of FILES.slice(1)) {
    await step.waitForTimeout(400);
    await step.locator(`section[aria-label="${at}"] button[aria-label="Close"]`).focus();
    at = file.name;
    const ms = await open(step, file.name, file.kind, "next");
    record(`step → ${file.kind}: shows ms`, ms.first);
  }
  await stepping.close();
}

for (const [name, values] of results) {
  console.log(
    `${name.padEnd(30)} ${median(values).toFixed(0).padStart(8)}   [${values.map((v) => v.toFixed(0)).join(", ")}]`,
  );
}
await browser.close();
await h2?.close();
await worker.close();
await mailService.close();
await db.execute(sql`delete from storage_nodes where id = ${folderId} or parent_id = ${folderId}`);
await close();
