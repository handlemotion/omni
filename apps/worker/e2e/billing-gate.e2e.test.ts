// The read-only gate's contract (ADR 0015) over the real Worker with billing on: every write
// route under `/api` that the app has today answers 402 to a workspace that never subscribed,
// unless `READ_ONLY_ALLOWED` names it, and every route it names is not gated. The routes come
// from the app itself, so a new write route fails here until someone decides which side it is on.
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
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

// The Worker's own route table and allowlist, loaded by Vitest. The specifiers are not literals
// so this Node-typed project does not type-check Worker source against the Workers runtime.
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

/** Every distinct write route the app registers under `/api` (middleware is method `ALL`). */
function writeRoutes() {
  const seen = new Set<string>();
  return app.routes
    .filter((r) => !["GET", "HEAD", "ALL"].includes(r.method) && r.path.startsWith("/api/"))
    .filter((r) => !seen.has(`${r.method} ${r.path}`) && seen.add(`${r.method} ${r.path}`))
    .map((r) => ({
      method: r.method,
      pattern: r.path,
      // Any id will do: the gate answers before a handler looks anything up.
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
      // A body no route accepts: what gets past the gate stops at validation or a missing
      // record (the workspace has no Stripe customer), so nothing here sends mail, changes the
      // workspace or dials Stripe.
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
  // One assertion over the whole table, so a failure names every route on the wrong side.
  expect(answers.filter((a) => a.allowed === a.gated)).toEqual([]);
  // Both sides are exercised: mail writes are gated, billing stays open.
  expect(answers).toContainEqual({
    route: "POST /api/threads/:id/archive",
    allowed: false,
    gated: true,
  });
  expect(answers).toContainEqual({
    route: "POST /api/billing/portal",
    allowed: true,
    gated: false,
  });
}, 60_000);
