import { randomUUID } from "node:crypto";
import { PLAN_NAME } from "@omni/auth";
import { forMember, schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { BILLING_SECRETS, MONTHLY_PRICE } from "./stripe-events.ts";
import {
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  createMailbox,
} from "./support.ts";

const source = (path: string) => import(/* @vite-ignore */ new URL(path, import.meta.url).href);
const { app } = (await source("../src/app.ts")) as {
  app: { routes: { method: string; path: string }[] };
};
const { allowedWhileReadOnly } = (await source("../src/billing.ts")) as {
  allowedWhileReadOnly: (path: string) => boolean;
};

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: {
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      BILLING_TRIAL_DAYS: "14",
      BILLING_TRIAGE_ALLOWANCE: "500",
    },
    secrets: BILLING_SECRETS,
  });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
}, 60_000);

afterAll(async () => {
  await worker?.server.close();
  await mailService?.close();
  await database?.teardown();
});

async function withPaidPlan<T>(orgId: string, write: () => Promise<T>) {
  const { db } = database;
  const id = randomUUID();
  await db.insert(schema.subscriptions).values({ id, plan: PLAN_NAME, orgId, status: "active" });
  try {
    return await write();
  } finally {
    await db.delete(schema.subscriptions).where(eq(schema.subscriptions.id, id));
  }
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

async function uploadIcon(dealId: string, cookie: string) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "icon");
  const response = await fetch(new URL(`/api/crm/deals/${dealId}/icon`, worker.url), {
    method: "PUT",
    headers: { cookie },
    body: form,
  });
  if (response.status !== 200) throw new Error(`icon upload: ${response.status}`);
  return ((await response.json()) as { deal: { iconUrl: string } }).deal.iconUrl;
}

const DESKTOP_SYNC_ROUTES = "/api/storage/sync/";

function writeRoutes() {
  const seen = new Set<string>();
  return app.routes
    .filter((r) => !["GET", "HEAD", "ALL"].includes(r.method) && r.path.startsWith("/api/"))
    .filter((r) => !r.path.startsWith(DESKTOP_SYNC_ROUTES))
    .filter((r) => !seen.has(`${r.method} ${r.path}`) && seen.add(`${r.method} ${r.path}`))
    .map((r) => ({
      method: r.method,
      pattern: r.path,
      path: r.path.replace(/:\w+(\{[^}]*\})?/g, randomUUID()).replace(/\*$/, "x"),
    }));
}

test("every write route is gated for an unpaid workspace unless the allowlist names it", async () => {
  const { db } = database;
  const org = await createOrg(db, "unpaid");
  const email = `owner-${randomUUID().slice(0, 8)}@omni.test`;
  const owner = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, owner.id));
  const cookie = await signIn(worker, db, email);

  const routes = writeRoutes();
  expect(routes.length).toBeGreaterThan(10);
  const answers = [];
  for (const route of routes) {
    const response = await fetch(new URL(route.path, worker.url), {
      method: route.method,
      headers: { cookie, "content-type": "application/json", "idempotency-key": randomUUID() },
      body: "{not json",
    });
    await response.body?.cancel();
    answers.push({
      route: `${route.method} ${route.pattern}`,
      allowed: allowedWhileReadOnly(route.path),
      gated: response.status === 402,
    });
  }
  expect(answers.filter((a) => a.allowed === a.gated)).toEqual([]);
  expect(answers).toContainEqual({
    route: "POST /api/threads/:id/archive",
    allowed: false,
    gated: true,
  });
  expect(answers).toContainEqual({ route: "POST /api/crm/people", allowed: false, gated: true });
  expect(answers).toContainEqual({
    route: "POST /api/workspace/invitations/:id/resend",
    allowed: true,
    gated: false,
  });
  expect(answers).toContainEqual({
    route: "POST /api/billing/portal",
    allowed: true,
    gated: false,
  });
});

test("a read-only workspace still reads every CRM route", async () => {
  const { db } = database;
  const org = await createOrg(db, "unpaid-crm");
  const email = `member-${randomUUID().slice(0, 8)}@omni.test`;
  const member = await createMember(db, org.id, email);
  const cookie = await signIn(worker, db, email);
  const crm = forMember(db, member.id).crm;
  const added = await crm.addPerson({ name: "Carla", address: "carla@northwind.com" });
  if (added.status !== "ok" || !added.person.companyId) throw new Error("no person");
  const deal = await crm.createDeal({ name: "Website", personIds: [added.person.id] });
  if (deal.status !== "ok") throw new Error("no deal");
  const task = await crm.createTask({ title: "Send the brief" });
  if (task.status !== "ok") throw new Error("no task");
  const icon = await withPaidPlan(org.id, () => uploadIcon(deal.deal.id, cookie));
  const ids: Record<string, string> = {
    companies: added.person.companyId,
    people: added.person.id,
    deals: deal.deal.id,
    tasks: task.task.id,
  };
  const params: Record<string, string> = { iconId: icon.split("/").at(-1)! };
  const queries: Record<string, string> = {
    lookup: "?address=carla@northwind.com",
    search: "?q=car",
    contracts: `?deal=${deal.deal.id}`,
  };

  const reads = [
    ...new Set(
      app.routes
        .filter((r) => r.method === "GET" && r.path.startsWith("/api/crm/"))
        .map((r) => r.path),
    ),
  ];
  expect(reads.length).toBeGreaterThan(10);
  const answers = [];
  for (const pattern of reads) {
    const records = pattern.split("/")[3]!;
    const path =
      pattern.replace(/:(\w+)(\{(?:[^{}]|\{[^}]*\})*\})?/g, (_, name: string) =>
        name === "id" ? (ids[records] ?? "") : (params[name] ?? ""),
      ) + (queries[records] ?? "");
    const response = await fetch(new URL(path, worker.url), { headers: { cookie } });
    await response.body?.cancel();
    answers.push({ route: pattern, status: response.status });
  }
  expect(answers.filter((a) => a.status !== 200)).toEqual([]);
  const write = await fetch(new URL("/api/crm/companies", worker.url), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "Initech" }),
  });
  expect(write.status).toBe(402);
});
