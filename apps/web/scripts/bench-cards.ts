import { mkdtempSync, writeFileSync } from "node:fs";
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
import { createDb } from "@omni/db";
import { sql } from "drizzle-orm";

await buildWorker();

const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const PDFS = Number(process.env.BENCH_PDFS ?? 14);
const PAGES = Number(process.env.BENCH_PDF_PAGES ?? 4);
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
const origin = String(worker.url).replace(/\/$/, "");
const cookie = await signIn({ url: new URL(origin) }, db, EMAIL);
const browser = await chromium.launch(
  process.env.BENCH_CHROMIUM ? { executablePath: process.env.BENCH_CHROMIUM } : {},
);

async function newContext() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=");
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    }),
  );
  await context.addInitScript(() => {
    localStorage.setItem("omni:storage-view", "cards");
    const w = window as unknown as { benchBlocked: number };
    w.benchBlocked = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.benchBlocked += Math.max(0, entry.duration - 50);
    }).observe({ type: "longtask", buffered: true });
  });
  return context;
}

async function throttled(context: BrowserContext) {
  const page = await context.newPage();
  page.on(
    "console",
    (m) => ["error", "warning"].includes(m.type()) && console.warn("console:", m.text()),
  );
  page.on("pageerror", (e) => console.warn("pageerror:", e.message));
  page.on("response", (r) => r.status() >= 400 && console.warn("http:", r.status(), r.url()));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  return page;
}

async function scans(page: Page) {
  const pages = await page.evaluate((count) => {
    const out: string[] = [];
    for (let p = 0; p < count; p++) {
      const canvas = document.createElement("canvas");
      canvas.width = 2550;
      canvas.height = 3300;
      const g = canvas.getContext("2d")!;
      const image = g.createImageData(canvas.width, canvas.height);
      let seed = 11 + p;
      for (let i = 0; i < image.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const x = (i / 4) % canvas.width;
        const y = Math.floor(i / 4 / canvas.width);
        const ink = y % 60 < 22 && x > 200 && x < 2350 && (seed & 7) < 3;
        const v = (ink ? 40 : 232) + ((seed >> 8) & 31) - 16;
        image.data[i] = v;
        image.data[i + 1] = v - 2;
        image.data[i + 2] = v - 6;
        image.data[i + 3] = 255;
      }
      g.putImageData(image, 0, 0);
      out.push(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!);
    }
    return out;
  }, PAGES);
  return pages.map((b) => Buffer.from(b, "base64"));
}

function scannedPdf(jpegs: Buffer[]) {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Buffer) => {
    const b = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(b);
    length += b.length;
  };
  const object = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  object(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  object(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${jpegs.length} >>`));
  jpegs.forEach((jpeg, i) => {
    const pageN = 3 + i * 3;
    const draw = "q 612 0 0 792 0 0 cm /Im0 Do Q";
    object(pageN, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${pageN + 2} 0 R >> >> /Contents ${pageN + 1} 0 R >>`,
      ),
    );
    object(pageN + 1, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    object(pageN + 2, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width 2550 /Height 3300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
      );
      push(jpeg);
      push("\nendstream");
    });
  });
  const xref = length;
  const count = 3 + jpegs.length * 3;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const FOLDER = `Bench cards ${Date.now()}`;

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
  const pdf = scannedPdf(await scans(page));
  console.log(
    `seeding ${PDFS} PDFs of ${PAGES} pages, ${(pdf.length / 2 ** 20).toFixed(1)} MiB each`,
  );
  await page.goto(`${origin}/files/my/${made}`);
  await page
    .locator("input[type=file]:not([webkitdirectory])")
    .first()
    .waitFor({ state: "attached" });
  const dir = mkdtempSync(join(tmpdir(), "bench-cards-"));
  const files = Array.from({ length: PDFS }, (_, i) => {
    const path = join(dir, `scan-${String(i).padStart(2, "0")}.pdf`);
    writeFileSync(path, pdf);
    return path;
  });
  await page.locator("input[type=file]:not([webkitdirectory])").first().setInputFiles(files);
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll("[role='row']")].filter((r) =>
        /scan-\d+\.pdf/.test(r.textContent ?? ""),
      ).length >= n,
    PDFS,
    { timeout: 300_000, polling: 250 },
  );
  await page.waitForFunction(
    () => ![...document.querySelectorAll("[aria-label^='Cancel ']")].length,
    undefined,
    { timeout: 300_000, polling: 250 },
  );
  await context.close();
  return made;
}

const folderId = await seedFolder();

const ALL_SHOWN = () => {
  const cards = [...document.querySelectorAll("[role='row']")].filter((r) => {
    if (!/scan-\d+\.pdf/.test(r.textContent ?? "")) return false;
    const box = r.getBoundingClientRect();
    return box.bottom > 0 && box.top < innerHeight && box.width > 0;
  });
  if (cards.length === 0) return false;
  return cards.every((card) =>
    [...card.querySelectorAll("img")].some(
      (img) => img.complete && img.naturalWidth > 0 && img.className.includes("opacity-100"),
    ),
  );
};

async function load(page: Page, go: () => Promise<unknown>) {
  let bytes = 0;
  let reads = 0;
  let inflight = 0;
  let lastDone = 0;
  const isFile = (req: import("playwright-core").Request) =>
    new URL(req.url()).pathname.endsWith("/content");
  const started = (req: import("playwright-core").Request) => {
    if (isFile(req)) inflight += 1;
  };
  const failed = (req: import("playwright-core").Request) => {
    if (isFile(req)) inflight -= 1;
  };
  const finished = async (req: import("playwright-core").Request) => {
    if (!isFile(req)) return;
    reads += 1;
    bytes += (await req.sizes()).responseBodySize;
    inflight -= 1;
    lastDone = Date.now();
  };
  page.on("request", started);
  page.on("requestfailed", failed);
  page.on("requestfinished", finished);
  await go();
  try {
    await page.waitForFunction(ALL_SHOWN, undefined, { timeout: 120_000, polling: "raf" });
  } catch (error) {
    await page.screenshot({ path: join(tmpdir(), "bench-cards-timeout.png") });
    throw error;
  }
  const at = await page.evaluate(() => ({
    ms: performance.now(),
    blocked: (window as unknown as { benchBlocked: number }).benchBlocked,
    visible: [...document.querySelectorAll("[role='row']")].filter((r) => {
      const box = r.getBoundingClientRect();
      return /\.pdf/.test(r.textContent ?? "") && box.bottom > 0 && box.top < innerHeight;
    }).length,
  }));
  const shownMib = bytes / 2 ** 20;
  const shownReads = reads;
  lastDone = Date.now();
  while (inflight > 0 || Date.now() - lastDone < 2000) await page.waitForTimeout(100);
  page.off("request", started);
  page.off("requestfailed", failed);
  page.off("requestfinished", finished);
  return { ...at, mib: shownMib, reads: shownReads, totalMib: bytes / 2 ** 20 };
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const results = new Map<string, number[]>();
const record = (name: string, value: number) => {
  results.set(name, [...(results.get(name) ?? []), value]);
};

for (let run = 0; run < RUNS; run++) {
  const context = await newContext();
  const page = await throttled(context);
  const target = `${origin}/files/my/${folderId}`;
  const cdp = process.env.BENCH_PROFILE ? await context.newCDPSession(page) : undefined;
  if (cdp) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  const cold = await load(page, () => page.goto(target));
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map<string, number>();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const counts = new Map<number, number>();
    for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, n] of counts) {
      const f = byId.get(id)!.callFrame;
      const name = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
      self.set(name, (self.get(name) ?? 0) + n);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    for (const [name, n] of [...self].toSorted((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`profile ${((100 * n) / total).toFixed(1).padStart(5)}% ${name}`);
    }
  }
  if (process.env.BENCH_SHOT) await page.screenshot({ path: process.env.BENCH_SHOT });
  record("first visit: PDF cards shown ms", cold.ms);
  record("first visit: main thread blocked ms", cold.blocked);
  record("first visit: file MiB read", cold.mib);
  record("first visit: file requests", cold.reads);
  record("first visit: file MiB once settled", cold.totalMib);
  record("PDF cards on screen", cold.visible);
  const warm = await load(page, () => page.reload());
  record("reload: PDF cards shown ms", warm.ms);
  record("reload: main thread blocked ms", warm.blocked);
  record("reload: file MiB read", warm.mib);
  record("reload: file requests", warm.reads);
  record("reload: file MiB once settled", warm.totalMib);
  const opened = await page.evaluate(() => performance.now());
  await page.getByRole("row", { name: "scan-00.pdf" }).first().click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLCanvasElement>(".react-pdf__Page__canvas")].some(
        (c) => c.width > 0,
      ),
    undefined,
    { timeout: 60_000, polling: "raf" },
  );
  record("open PDF: page drawn ms", (await page.evaluate(() => performance.now())) - opened);
  await context.close();
}

for (const [name, values] of results) {
  console.log(
    `${name.padEnd(38)} ${median(values).toFixed(1).padStart(9)}   [${values.map((v) => v.toFixed(1)).join(", ")}]`,
  );
}
await browser.close();
await worker.close();
await mailService.close();
await db.execute(sql`delete from storage_nodes where id = ${folderId} or parent_id = ${folderId}`);
await close();
