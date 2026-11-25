import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { chromium, type Page } from "playwright-core";
import {
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorkerWithNetwork,
} from "../../worker/e2e/support.ts";
import buildWorker from "../../worker/e2e/global-setup.ts";

await buildWorker();

const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const DB_LATENCY = Number(process.env.BENCH_DB_LATENCY ?? 60);
const MODEL_MS = Number(process.env.BENCH_MODEL_MS ?? 3000);

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

const model = createHttpServer((req, res) => {
  req.resume();
  req.on("end", () =>
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_bench",
          type: "message",
          role: "assistant",
          model: "bench",
          content: [{ type: "text", text: JSON.stringify({ summary: "Where things stand." }) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    }, MODEL_MS),
  );
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const modelOrigin = "http://127.0.0.1:" + (model.address() as { port: number }).port;

const database = await createTestDatabase();
const slow = await slowPostgres(new URL(database.url), DB_LATENCY);
const mailService = await startMailServiceEndpoint();
const port = await freePort();
const worker = await startWorkerWithNetwork({
  databaseUrl: slow.url,
  mailServiceUrl: mailService.url,
  port,
  vars: {
    BETTER_AUTH_URL: "http://127.0.0.1:" + port,
    RATE_LIMIT_AUTH: "off",
    RATE_LIMIT_ACTIONS: "off",
    TRANSCRIBE_PROVIDER: "assemblyai",
    TRANSCRIBE_URL: modelOrigin,
    ANTHROPIC_BASE_URL: modelOrigin,
  },
  secrets: { ANTHROPIC_API_KEY: "bench", TRANSCRIBE_API_KEY: "bench" },
});
const origin = String(worker.url).replace(/\/$/, "");
const db = database.db;
const org = await createOrg(db, "bench");
const email = "owner-" + randomUUID() + "@bench.test";
const member = await createMember(db, org.id, email);
await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
await db.insert(schema.orgSetup).values({ orgId: org.id, step: "complete" });
const cookie = await signIn({ url: new URL(origin) }, db, email);

const WORDS =
  "so we agreed that the dashboard ships next week and the export moves to the second release because the numbers were off by one".split(
    " ",
  );
const sentence = (n: number) =>
  Array.from({ length: 22 }, (_, i) => WORDS[(n * 7 + i * 3) % WORDS.length]).join(" ") + ".";
const HOUR = 3_600_000;
const now = Date.now();
type Seeded = { id: string; title: string; groupKey: string; startedAt: Date; turns: number };
const meetings: Seeded[] = [];
let slot = 0;
for (let s = 0; s < 20; s++) {
  const base = now - (slot++ * 5 + 2) * HOUR;
  for (let k = 0; k < 10; k++) {
    meetings.push({
      id: randomUUID(),
      title: "Weekly sync " + s,
      groupKey: "series:bench-" + s,
      startedAt: new Date(base - k * 7 * 24 * HOUR),
      turns: 80,
    });
  }
}
for (let c = 0; c < 20; c++) {
  const base = now - (slot++ * 5 + 2) * HOUR;
  for (let k = 0; k < 5; k++) {
    meetings.push({
      id: randomUUID(),
      title: "Client call " + c + "." + k,
      groupKey: "domain:client" + c + ".test",
      startedAt: new Date(base - k * 9 * 24 * HOUR),
      turns: 80,
    });
  }
}
const LONG = RUNS + 2;
for (let i = 0; i < 60; i++) {
  const id = randomUUID();
  meetings.push({
    id,
    title: "One-off call " + i,
    groupKey: "meeting:" + id,
    startedAt: new Date(now - (i * 5 + 1) * HOUR),
    turns: i < LONG ? 1200 : 80,
  });
}
const chunked = async <T>(rows: T[], insert: (part: T[]) => Promise<unknown>) => {
  for (let i = 0; i < rows.length; i += 1000) await insert(rows.slice(i, i + 1000));
};
await chunked(meetings, (part) =>
  db.insert(schema.meetingsMeetings).values(
    part.map((m) => ({
      id: m.id,
      orgId: org.id,
      title: m.title,
      startedAt: m.startedAt,
      endedAt: new Date(m.startedAt.getTime() + m.turns * 4500),
      durationMs: m.turns * 4500,
      groupKey: m.groupKey,
      recordedByMemberId: member.id,
      consentAt: m.startedAt,
      status: "ready" as const,
      language: "en",
    })),
  ),
);
const labels = ["A", "B", "C"];
await chunked(
  meetings.flatMap((m) =>
    labels.map((label, i) => ({
      meetingId: m.id,
      orgId: org.id,
      label,
      name: ["Ana Ruiz", "José Pérez", "Priya Shah"][i]!,
      confidence: 1,
    })),
  ),
  (part) => db.insert(schema.meetingsSpeakers).values(part),
);
await chunked(
  meetings.flatMap((m) =>
    ["ana@bench.test", "jose@client.test", "priya@client.test"].map((address) => ({
      meetingId: m.id,
      orgId: org.id,
      address,
      name: address.split("@")[0]!,
    })),
  ),
  (part) => db.insert(schema.meetingsAttendees).values(part),
);
await chunked(
  meetings.map((m) => ({
    meetingId: m.id,
    orgId: org.id,
    summary: "The team went over " + m.title + ". " + sentence(1) + " " + sentence(2),
    highlights: Array.from({ length: 8 }, (_, i) => ({
      text: "Highlight " + i + " of " + m.title,
      atMs: i * 300_000,
    })),
    topics: ["dashboard", "export"],
    model: "bench",
    promptVersion: 2,
  })),
  (part) => db.insert(schema.meetingsNotes).values(part),
);
await chunked(
  meetings.flatMap((m) =>
    Array.from({ length: 4 }, (_, i) => ({
      meetingId: m.id,
      orgId: org.id,
      seq: i,
      kind: "task" as const,
      payload: { title: "Follow up " + i + " on " + m.title },
    })),
  ),
  (part) => db.insert(schema.meetingsActions).values(part),
);
await chunked(
  meetings.flatMap((m) =>
    Array.from({ length: m.turns }, (_, seq) => ({
      meetingId: m.id,
      orgId: org.id,
      seq,
      speakerLabel: labels[Math.floor(seq / 3) % 3]!,
      startMs: seq * 4500,
      endMs: seq * 4500 + 4300,
      text: sentence(seq),
    })),
  ),
  (part) => db.insert(schema.meetingsSegments).values(part),
);

const byStart = meetings.toSorted((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
const newest = byStart[0]!;
const oneOffs = meetings.filter((m) => m.groupKey.startsWith("meeting:"));
const longOnes = oneOffs.slice(0, LONG);
const seriesTitles = Array.from({ length: 20 }, (_, s) => "Weekly sync " + s);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  const w = window as unknown as Record<string, unknown>;
  w.benchVisible = (test: () => boolean) =>
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
  addEventListener("pointerdown", () => (w.benchPressedAt = performance.now()), true);
  w.benchLong = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) (w.benchLong as number) += entry.duration;
  }).observe({ type: "longtask", buffered: true });
});
await context.addCookies(
  cookie.split("; ").map((pair) => {
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
  }),
);

async function throttled() {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  return page;
}

const TESTS = {
  title: (t: string) =>
    "[...document.querySelectorAll('h1')].some((h) => h.textContent?.trim() === " +
    JSON.stringify(t) +
    " && !h.closest('[aria-busy=true]'))",
  overview: () =>
    "!!document.querySelector('section[aria-label=Overview]:not([aria-busy=true] *)')",
  notes: (t: string) => "(" + TESTS.title(t) + ") && (" + TESTS.overview() + ")",
  turn: () =>
    "[...document.querySelectorAll('[role=tabpanel] ol > li')].some((li) => !li.closest('[aria-busy=true]'))",
  turns: (n: number) => "document.querySelectorAll('[role=tabpanel] ol > li').length >= " + n,
  summary: () =>
    "[...document.querySelectorAll('p')].some((p) => p.textContent === 'Where things stand.')",
  timeline: () =>
    "[...document.querySelectorAll('h2')].some((h) => h.textContent === 'Timeline' && !h.closest('[aria-busy=true]'))",
  link: (t: string) =>
    "[...document.querySelectorAll('a')].some((a) => a.textContent?.trim() === " +
    JSON.stringify(t) +
    ")",
};

async function timed(page: Page, tests: string[], act: () => Promise<void>) {
  await page.evaluate((tests) => {
    const w = window as unknown as {
      benchVisible: (test: () => boolean) => Promise<number>;
      benchPending: Promise<number[]>;
      benchPressedAt: number;
      benchLong: number;
      benchLongAt: number;
    };
    w.benchPressedAt = 0;
    w.benchLongAt = w.benchLong;
    w.benchPending = Promise.all(
      tests.map((t) => w.benchVisible(new Function("return " + t) as () => boolean)),
    );
  }, tests);
  await act();
  return page.evaluate(async () => {
    const w = window as unknown as {
      benchPending: Promise<number[]>;
      benchPressedAt: number;
      benchLong: number;
      benchLongAt: number;
    };
    const at = await Promise.race([
      w.benchPending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("not shown")), 30_000)),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    return { ms: at.map((t) => t - w.benchPressedAt), long: w.benchLong - w.benchLongAt };
  });
}

const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const results = new Map<string, number[]>();
const record = (name: string, value: number) =>
  results.set(name, [...(results.get(name) ?? []), value]);
const sidebarLink = (page: Page, label: string) =>
  page.locator("a", { has: page.getByText(label, { exact: true }) }).first();

for (let run = 0; run < RUNS; run++) {
  const page = await throttled();
  const nav = page.evaluate.bind(page);
  await page.goto(origin + "/" + org.slug + "/meetings");
  const startup = await nav(async (test) => {
    const w = window as unknown as { benchVisible: (t: () => boolean) => Promise<number> };
    return w.benchVisible(new Function("return " + test) as () => boolean);
  }, TESTS.title(newest.title));
  record("startup: newest meeting shown ms", startup);
  await page.waitForLoadState("networkidle");

  const target = oneOffs[LONG + 1 + run]!;
  await sidebarLink(page, target.title).waitFor();
  const open = await timed(page, [TESTS.title(target.title), TESTS.notes(target.title)], () =>
    sidebarLink(page, target.title).click(),
  );
  record("open a meeting: title ms", open.ms[0]!);
  record("open a meeting: notes ms", open.ms[1]!);

  const hovered = oneOffs[LONG + 2 * RUNS + 3 + run]!;
  await sidebarLink(page, hovered.title).scrollIntoViewIfNeeded();
  const afterHover = await timed(page, [TESTS.notes(hovered.title)], async () => {
    await sidebarLink(page, hovered.title).hover();
    await page.waitForTimeout(200);
    await sidebarLink(page, hovered.title).click();
  });
  record("open a meeting, hovered 200 ms first: notes ms", afterHover.ms[0]!);

  const back = await timed(page, [TESTS.notes(newest.title)], () =>
    sidebarLink(page, newest.title).click(),
  );
  record("back to a seen meeting: notes ms", back.ms[0]!);
  await page.waitForLoadState("networkidle");

  const long = longOnes[run]!;
  await timed(page, [TESTS.title(long.title)], () => sidebarLink(page, long.title).click());
  await page.waitForLoadState("networkidle");
  const transcript = await timed(page, [TESTS.turn(), TESTS.turns(400)], () =>
    page.getByRole("tab", { name: "Transcript" }).click(),
  );
  record("transcript tab (1,200 turns): first turn ms", transcript.ms[0]!);
  record("transcript tab (1,200 turns): all 400 turns ms", transcript.ms[1]!);
  if (process.env.BENCH_SHOTS)
    await page.screenshot({ path: process.env.BENCH_SHOTS + "/transcript.png" });
  record("transcript tab (1,200 turns): long tasks ms", transcript.long);

  const summaryTab = await timed(page, [TESTS.overview()], () =>
    page.getByRole("tab", { name: "Summary" }).click(),
  );
  record("summary tab back: shown ms", summaryTab.ms[0]!);

  const series = seriesTitles[run]!;
  const group = await timed(page, [TESTS.timeline(), TESTS.summary()], async () => {
    await sidebarLink(page, series).click();
    if (!process.env.BENCH_SHOTS) return;
    await page.getByRole("heading", { name: "Timeline" }).waitFor();
    await page.screenshot({ path: process.env.BENCH_SHOTS + "/series-pending.png" });
  });
  record("open a series (summary not made yet): timeline ms", group.ms[0]!);
  if (process.env.BENCH_SHOTS)
    await page.screenshot({ path: process.env.BENCH_SHOTS + "/series-" + run + ".png" });
  record("open a series (summary not made yet): summary ms", group.ms[1]!);
  await page.waitForLoadState("networkidle");

  const series2 = seriesTitles[RUNS + run]!;
  await page.getByRole("button", { name: "Expand " + series2, exact: true }).click({ force: true });
  await page.getByRole("button", { name: "Collapse " + series2, exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
  const linked = oneOffs[LONG + RUNS + 2 + run]!;
  const deep = await throttled();
  await deep.goto(origin + "/" + org.slug + "/meetings/" + linked.id);
  record(
    "startup on a meeting's link: notes shown ms",
    await deep.evaluate(async (test) => {
      const w = window as unknown as { benchVisible: (t: () => boolean) => Promise<number> };
      return w.benchVisible(new Function("return " + test) as () => boolean);
    }, TESTS.notes(linked.title)),
  );
  await deep.close();
  if (process.env.BENCH_CALLS) {
    const api = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((e) => new URL(e.name).pathname.startsWith("/api/"))
        .map((e) => {
          const u = new URL(e.name);
          const path = u.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id");
          return [path.replace(/groups\/[^/]+/, "groups/:key"), e.duration] as const;
        }),
    );
    for (const [path, ms] of api) record("api " + path + " ms", ms);
  }
  await page.close();
}

console.log(
  "\nMeetings, database " +
    DB_LATENCY +
    " ms away, model " +
    MODEL_MS +
    " ms, CPU 4x, median of " +
    RUNS,
);
for (const [name, values] of results) {
  console.log(
    name.padEnd(52) +
      String(Math.round(median(values))).padStart(7) +
      "   [" +
      values.map((v) => v.toFixed(0)).join(", ") +
      "]",
  );
}

await browser.close();
await worker.close();
await mailService.close();
model.close();
slow.close();
await database.teardown();
process.exit(0);
