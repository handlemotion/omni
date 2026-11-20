import { createServer, connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Page } from "playwright-core";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
  SYSTEM_MAIL_FROM,
} from "../../worker/e2e/support.ts";
import buildWorker from "../../worker/e2e/global-setup.ts";

await buildWorker();

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const DB_LATENCY = Number(process.env.BENCH_DB_LATENCY ?? 60);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

async function slowPostgres(target: URL, roundTripMs: number) {
  const port = await freePort();
  const delay = (from: Socket, to: Socket) =>
    from.on("data", (chunk) => {
      setTimeout(() => to.writable && to.write(chunk), roundTripMs / 2);
    });
  const server = createServer((client) => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    delay(client, upstream);
    delay(upstream, client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return { url: url.toString(), close: () => server.close() };
}

const database = await createTestDatabase();
const slow = await slowPostgres(new URL(database.url), DB_LATENCY);
const mailService = await startMailServiceEndpoint();
const port = await freePort();
const worker = await startWorkerWithNetwork({
  databaseUrl: slow.url,
  mailServiceUrl: mailService.url,
  port,
  vars: {
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    RATE_LIMIT_AUTH: "off",
    RATE_LIMIT_ACTIONS: "off",
  },
});
const origin = String(worker.url).replace(/\/$/, "");
const db = database.db;
const system = await createOrg(db, "system");
await createMailbox(db, system.id, SYSTEM_MAIL_FROM);
const org = await createOrg(db, "bench");
const email = `owner-${randomUUID()}@bench.test`;
const member = await createMember(db, org.id, email);
await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
const cookie = await signIn({ url: new URL(origin) }, db, email);

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}/api/crm${path}`, {
    method,
    headers: { cookie, origin, "content-type": "application/json", "omni-workspace": org.id },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  // oxlint-disable-next-line typescript/no-explicit-any -- seed answers
  return (await response.json()) as any;
}

const companies: { id: string; name: string }[] = [];
for (let i = 0; i < 20; i++) {
  companies.push((await api("POST", "/companies", { name: `Company ${i}` })).company);
}
for (let i = 0; i < 20; i++) {
  await api("POST", "/people", {
    name: `Person ${i}`,
    address: `person${i}@company${i}.test`,
    companyId: companies[i]!.id,
  });
}
const deals: { id: string }[] = [];
for (let i = 0; i < 10; i++) {
  deals.push(
    (await api("POST", "/deals", { name: `Deal ${i}`, companyId: companies[i]!.id })).deal,
  );
}
const TASKS = RUNS * 2 + 4;
for (let i = 0; i < TASKS; i++) {
  await api("POST", "/tasks", { title: `Task ${i}`, assigneeMemberId: member.id });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(
  cookie.split("; ").map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
  }),
);
const page = await context.newPage();
page.setDefaultTimeout(30_000);
let requests = 0;
let inFlight = 0;
let lastActivity = Date.now();
const settled = (request: { url: () => string }) => {
  if (!new URL(request.url()).pathname.startsWith("/api/")) return;
  inFlight--;
  lastActivity = Date.now();
};
page.on("requestfailed", settled);
const calls = new Map<string, number[]>();
page.on("request", (request) => {
  if (!new URL(request.url()).pathname.startsWith("/api/")) return;
  requests++;
  inFlight++;
  lastActivity = Date.now();
});
page.on("requestfinished", (request) => {
  settled(request);
  const path = new URL(request.url()).pathname;
  if (!path.startsWith("/api/")) return;
  const name = `${request.method()} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id")}`;
  const { responseEnd } = request.timing();
  calls.set(name, [...(calls.get(name) ?? []), responseEnd]);
});

async function quiet() {
  while (inFlight > 0 || Date.now() - lastActivity < 1_000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function timed(shown: string, act: () => Promise<void>) {
  await page.evaluate((test) => {
    const w = window as unknown as { benchDone: Promise<number> };
    const holds = new Function(`return (${test})()`) as () => boolean;
    const start = performance.now();
    w.benchDone = new Promise((resolve) => {
      const check = () => holds() && (resolve(performance.now() - start), true);
      if (check()) return;
      const observer = new MutationObserver(() => check() && observer.disconnect());
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    });
  }, shown);
  requests = 0;
  await act();
  const ms = await page.evaluate(() =>
    Promise.race([
      (window as unknown as { benchDone: Promise<number> }).benchDone,
      new Promise<number>((_, reject) => setTimeout(() => reject(new Error("not shown")), 20_000)),
    ]),
  );
  await quiet();
  const counted = requests;
  const stuck = await page.evaluate(
    (test) => (new Function(`return (${test})()`) as () => boolean)(),
    shown,
  );
  if (!stuck) throw new Error(`shown, then undone once the app refetched: ${shown}`);
  return { ms, requests: counted };
}

const results = new Map<string, { ms: number[]; requests: number[] }>();
const record = (name: string, value: { ms: number; requests: number }) => {
  const entry = results.get(name) ?? { ms: [], requests: [] };
  entry.ms.push(value.ms);
  entry.requests.push(value.requests);
  results.set(name, entry);
};
const go = async (path: string, ready: (page: Page) => Promise<unknown>) => {
  await page.goto(`${origin}/${org.slug}${path}`);
  await ready(page);
  await quiet();
};

for (let run = 0; run < RUNS; run++) {
  const deal = deals[run % deals.length]!;
  const name = `Deal renamed ${run}`;
  await go(`/crm/deals/${deal.id}`, (p) => p.getByRole("textbox", { name: "Name" }).waitFor());
  record(
    "rename a deal (title shows)",
    await timed(
      `() => [...document.querySelectorAll("h2")].some((h) => h.textContent === ${JSON.stringify(name)})`,
      async () => {
        const field = page.getByRole("textbox", { name: "Name", exact: true });
        await field.fill(name);
        await field.press("Enter");
      },
    ),
  );

  const note = `Bench note ${run} ${randomUUID()}`;
  record(
    "add a note (note shows)",
    await timed(
      `() => [...document.querySelectorAll("li, article, p")].some((el) => !el.closest("form") && el.textContent?.includes(${JSON.stringify(note)}))`,
      async () => {
        await page.getByRole("textbox", { name: "Note" }).fill(note);
        await page.getByRole("button", { name: "Add note" }).click();
      },
    ),
  );

  const task = `Task ${run}`;
  await go(`/crm/tasks`, (p) =>
    p.getByRole("checkbox", { name: `Complete ${task}`, exact: true }).waitFor(),
  );
  record(
    "complete a task (check or row goes)",
    await timed(
      `() => {
        if (document.querySelector(${JSON.stringify(`[aria-label="Reopen ${task}"]`)})) return true;
        const box = document.querySelector(${JSON.stringify(`[aria-label="Complete ${task}"]`)});
        return !box || box.matches(":checked, [aria-checked=true], [data-selected]");
      }`,
      () =>
        page
          .getByRole("checkbox", { name: `Complete ${task}`, exact: true })
          .click({ force: true }),
    ),
  );

  const company = companies[run % companies.length]!;
  await go(`/crm/companies`, (p) => p.getByText(company.name, { exact: true }).first().waitFor());
  record(
    "open a company from the list",
    await timed(
      `() => [...document.querySelectorAll("h2")].some((h) => h.textContent === ${JSON.stringify(company.name)})`,
      () => page.getByText(company.name, { exact: true }).first().click(),
    ),
  );
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log(`\nCRM, database ${DB_LATENCY} ms away, median of ${RUNS} runs`);
for (const [name, { ms, requests }] of results) {
  console.log(
    `${name.padEnd(34)} ${String(Math.round(median(ms))).padStart(6)} ms  ${String(median(requests)).padStart(3)} API requests`,
  );
}

if (process.env.BENCH_CALLS) {
  console.log("\nAPI calls, median ms (count)");
  for (const [name, ms] of [...calls].toSorted((a, b) => median(b[1]) - median(a[1]))) {
    console.log(`${String(Math.round(median(ms))).padStart(6)} (${ms.length})  ${name}`);
  }
}

await browser.close();
await worker.close();
await mailService.close();
slow.close();
await database.teardown();
process.exit(0);
