// Billing (ADR 0014) over the real Worker and Postgres: Stripe's signed webhook drives the
// workspace's plan through Better Auth's Stripe plugin, a replayed or out-of-order event changes
// nothing, a workspace without a plan in good standing reads its mail but writes none, and an
// install with no Stripe configuration has no billing at all.
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  grant,
  seedMessage,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
} from "./support.ts";
import {
  BILLING_SECRETS,
  MONTHLY_PRICE,
  postStripeEvent,
  stripeEvent,
  subscriptionObject,
  YEARLY_PRICE,
  type SubscriptionState,
} from "./stripe-events.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let unbilled: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: {
      STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
      STRIPE_PRICE_YEARLY: YEARLY_PRICE,
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
  await unbilled?.server.close();
  await mailService?.close();
  await database?.teardown();
});

let keys = 0;

function api(base: { url: string | URL }, path: string, cookie: string, init: RequestInit = {}) {
  return fetch(new URL(`/api${path}`, base.url), {
    ...init,
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": `billing-${keys++}`,
      ...init.headers,
    },
  });
}

/** A workspace with a Stripe customer, an owner signed in, and one thread they can read. */
async function workspace(role = "owner") {
  const { db } = database;
  const org = await createOrg(db, "billed");
  const customer = `cus_e2e_${randomUUID().slice(0, 8)}`;
  await db
    .update(schema.organizations)
    .set({ stripeCustomerId: customer })
    .where(eq(schema.organizations.id, org.id));
  const email = `${role}-${randomUUID().slice(0, 8)}@omni.test`;
  const member = await createMember(db, org.id, email);
  await db.update(schema.members).set({ role }).where(eq(schema.members.id, member.id));
  const mailbox = await createMailbox(db, org.id, `hello-${randomUUID().slice(0, 8)}@omni.test`);
  await grant(db, org.id, mailbox.id, member.id);
  const { threadId } = await seedMessage(db, mailbox, {
    subject: "Quarterly numbers",
    fromAddress: "ana@client.example",
    uid: 1,
  });
  return { org, customer, threadId, cookie: await signIn(worker, db, email) };
}

type Billing = {
  enabled: boolean;
  readOnly?: boolean;
  subscription?: { status: string; interval: string | null; periodEnd: string | null } | null;
};

async function billing(cookie: string, base: { url: string | URL } = worker) {
  const response = await api(base, "/billing", cookie);
  expect(response.status).toBe(200);
  return (await response.json()) as Billing;
}

/** A mail write: archiving the thread. 402 means the workspace is read-only. */
async function archive(cookie: string, threadId: string, base: { url: string | URL } = worker) {
  const response = await api(base, `/threads/${threadId}/archive`, cookie, {
    method: "POST",
    body: JSON.stringify({ archived: true }),
  });
  return response.status;
}

async function subscriptionRows(orgId: string) {
  return database.db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.orgId, orgId));
}

test("the webhook drives the plan; a replayed or older event changes nothing", async () => {
  const { org, customer, threadId, cookie } = await workspace();
  const t0 = new Date(Date.now() - 60_000);
  const sub = (state: Partial<SubscriptionState>) =>
    subscriptionObject({
      id: "sub_e2e_" + org.id.slice(0, 8),
      customer,
      status: "trialing",
      periodStart: t0,
      periodEnd: new Date(t0.getTime() + 14 * 86_400_000),
      trialEnd: new Date(t0.getTime() + 14 * 86_400_000),
      ...state,
    });
  const at = (offsetSeconds: number) => new Date(t0.getTime() + offsetSeconds * 1000);

  // Never subscribed: mail stays readable, writes are refused.
  expect(await billing(cookie)).toMatchObject({
    enabled: true,
    readOnly: true,
    subscription: null,
  });
  expect(await archive(cookie, threadId)).toBe(402);
  expect((await api(worker, "/threads?view=all", cookie)).status).toBe(200);

  const created = stripeEvent("customer.subscription.created", sub({}), at(0));
  expect(await postStripeEvent(worker.url, created)).toMatchObject({
    status: 200,
    body: { applied: true },
  });
  expect(await billing(cookie)).toMatchObject({
    readOnly: false,
    subscription: { status: "trialing", interval: "month" },
  });
  expect(await archive(cookie, threadId)).not.toBe(402);

  const activated = stripeEvent(
    "customer.subscription.updated",
    sub({ status: "active", trialEnd: undefined }),
    at(10),
  );
  expect((await postStripeEvent(worker.url, activated)).body).toMatchObject({ applied: true });
  const afterActivation = await subscriptionRows(org.id);
  expect(afterActivation).toHaveLength(1);
  expect(afterActivation[0]).toMatchObject({ status: "active", stripeSubscriptionId: sub({}).id });

  // Stripe retries and replays: the same event again is acknowledged and ignored.
  expect(await postStripeEvent(worker.url, activated)).toMatchObject({
    status: 200,
    body: { applied: false, reason: "duplicate" },
  });
  // Stripe does not deliver in order: an event created before the one applied would roll the
  // plan back to its snapshot (here, past_due); it is skipped.
  const late = stripeEvent("customer.subscription.updated", sub({ status: "past_due" }), at(5));
  expect((await postStripeEvent(worker.url, late)).body).toMatchObject({
    applied: false,
    reason: "stale",
  });
  expect(await postStripeEvent(worker.url, created)).toMatchObject({
    body: { applied: false, reason: "duplicate" },
  });
  expect(await subscriptionRows(org.id)).toEqual(afterActivation);

  // Canceled (or a trial that ended without a card): read-only again, mail still readable.
  const deleted = stripeEvent(
    "customer.subscription.deleted",
    sub({ status: "canceled", trialEnd: undefined }),
    at(20),
  );
  expect((await postStripeEvent(worker.url, deleted)).body).toMatchObject({ applied: true });
  expect(await billing(cookie)).toMatchObject({
    readOnly: true,
    subscription: { status: "canceled" },
  });
  expect(await archive(cookie, threadId)).toBe(402);
  expect((await api(worker, `/threads/${threadId}`, cookie)).status).toBe(200);
  const final = await subscriptionRows(org.id);
  expect((await postStripeEvent(worker.url, deleted)).body).toMatchObject({ applied: false });
  expect(await subscriptionRows(org.id)).toEqual(final);

  const recorded = await database.db
    .select({ id: schema.stripeEvents.id, orgId: schema.stripeEvents.orgId })
    .from(schema.stripeEvents)
    .where(eq(schema.stripeEvents.objectId, sub({}).id));
  expect(recorded.map((e) => e.id).toSorted()).toEqual(
    [created.id, activated.id, late.id, deleted.id].toSorted(),
  );
}, 60_000);

test("an unsigned or wrongly signed event is refused and recorded nowhere", async () => {
  const { org, customer } = await workspace();
  const event = stripeEvent(
    "customer.subscription.created",
    subscriptionObject({
      id: `sub_forged_${randomUUID().slice(0, 8)}`,
      customer,
      status: "active",
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000),
    }),
    new Date(),
  );
  expect((await postStripeEvent(worker.url, event, { secret: "whsec_someone_else" })).status).toBe(
    400,
  );
  expect((await postStripeEvent(worker.url, event, { signature: "t=1,v1=00" })).status).toBe(400);
  const unsigned = await fetch(new URL("/api/auth/stripe/webhook", worker.url), {
    method: "POST",
    body: JSON.stringify(event),
  });
  expect(unsigned.status).toBe(400);
  expect(await subscriptionRows(org.id)).toEqual([]);
  const recorded = await database.db
    .select()
    .from(schema.stripeEvents)
    .where(eq(schema.stripeEvents.id, event.id));
  expect(recorded).toEqual([]);
});

test("checkout and the portal are for the workspace's owners and admins only", async () => {
  const member = await workspace("member");
  const checkout = (cookie: string) =>
    api(worker, "/billing/checkout", cookie, { method: "POST", body: "{}" });
  expect((await checkout(member.cookie)).status).toBe(403);
  expect((await api(worker, "/billing/portal", member.cookie, { method: "POST" })).status).toBe(
    403,
  );
  expect(await billing(member.cookie)).toMatchObject({ canManage: false });

  // The plugin's own endpoints would let anyone subscribe for themselves: closed.
  const direct = await api(worker, "/auth/subscription/upgrade", member.cookie, {
    method: "POST",
    headers: { origin: "http://localhost:5173" },
    body: JSON.stringify({ plan: "workspace" }),
  });
  expect(direct.status).toBe(404);

  // An owner whose workspace is already paid is sent to the portal, not into a second plan.
  const owner = await workspace("owner");
  await postStripeEvent(
    worker.url,
    stripeEvent(
      "customer.subscription.created",
      subscriptionObject({
        id: `sub_e2e_${randomUUID().slice(0, 8)}`,
        customer: owner.customer,
        status: "active",
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000),
      }),
      new Date(),
    ),
  );
  expect((await checkout(owner.cookie)).status).toBe(409);
});

test("with no Stripe configuration there is no billing: no webhook, no limits, all writable", async () => {
  unbilled = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  const { db } = database;
  const org = await createOrg(db, "self-hosted");
  const email = `self-${randomUUID().slice(0, 8)}@omni.test`;
  const member = await createMember(db, org.id, email);
  const mailbox = await createMailbox(db, org.id, `team-${randomUUID().slice(0, 8)}@omni.test`);
  await grant(db, org.id, mailbox.id, member.id);
  const { threadId } = await seedMessage(db, mailbox, {
    subject: "Hello",
    fromAddress: "ana@client.example",
    uid: 1,
  });
  const cookie = await signIn(unbilled, db, email);

  expect(await billing(cookie, unbilled)).toEqual({ enabled: false });
  expect(await archive(cookie, threadId, unbilled)).toBe(200);
  expect(
    (await api(unbilled, "/billing/checkout", cookie, { method: "POST", body: "{}" })).status,
  ).toBe(404);
  const webhook = await postStripeEvent(
    unbilled.url,
    stripeEvent("customer.subscription.created", {}, new Date()),
  );
  expect(webhook.status).toBe(404);
}, 60_000);
