import { randomUUID } from "node:crypto";
import { ensurePersonalSpace, schema } from "@omni/db";
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
  BUSINESS_MONTHLY_PRICE,
  PLAN_PRICES,
  postStripeEvent,
  stripeEvent,
  subscriptionObject,
  type SubscriptionState,
} from "./stripe-events.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
let worker: Awaited<ReturnType<typeof startWorker>>;
let unbilled: Awaited<ReturnType<typeof startWorker>>;
let switchedOff: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  database = await createTestDatabase();
  mailService = await startMailServiceEndpoint();
  worker = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: PLAN_PRICES,
    secrets: BILLING_SECRETS,
  });
  const system = await createOrg(database.db, "system");
  await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
}, 60_000);

afterAll(async () => {
  await worker?.server.close();
  await unbilled?.server.close();
  await switchedOff?.server.close();
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
  plan?: string;
  readOnly?: boolean;
  subscription?: { status: string; interval: string | null; periodEnd: string | null } | null;
};

async function billing(cookie: string, base: { url: string | URL } = worker) {
  const response = await api(base, "/billing", cookie);
  expect(response.status).toBe(200);
  return (await response.json()) as Billing;
}

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

  expect(await billing(cookie)).toMatchObject({
    enabled: true,
    plan: "free",
    readOnly: false,
    subscription: null,
  });
  expect(await archive(cookie, threadId)).toBe(200);

  const created = stripeEvent("customer.subscription.created", sub({}), at(0));
  expect(await postStripeEvent(worker.url, created)).toMatchObject({
    status: 200,
    body: { applied: true },
  });
  expect(await billing(cookie)).toMatchObject({
    plan: "team",
    subscription: { status: "trialing", interval: "month" },
  });

  const activated = stripeEvent(
    "customer.subscription.updated",
    sub({ status: "active", trialEnd: undefined }),
    at(10),
  );
  expect((await postStripeEvent(worker.url, activated)).body).toMatchObject({ applied: true });
  const afterActivation = await subscriptionRows(org.id);
  expect(afterActivation).toHaveLength(1);
  expect(afterActivation[0]).toMatchObject({ status: "active", stripeSubscriptionId: sub({}).id });

  expect(await postStripeEvent(worker.url, activated)).toMatchObject({
    status: 200,
    body: { applied: false, reason: "duplicate" },
  });
  const late = stripeEvent("customer.subscription.updated", sub({ status: "past_due" }), at(5));
  expect((await postStripeEvent(worker.url, late)).body).toMatchObject({
    applied: false,
    reason: "stale",
  });
  expect(await postStripeEvent(worker.url, created)).toMatchObject({
    body: { applied: false, reason: "duplicate" },
  });
  expect(await subscriptionRows(org.id)).toEqual(afterActivation);

  const movedUp = stripeEvent(
    "customer.subscription.updated",
    sub({ status: "active", trialEnd: undefined, priceId: BUSINESS_MONTHLY_PRICE }),
    at(15),
  );
  expect((await postStripeEvent(worker.url, movedUp)).body).toMatchObject({ applied: true });
  expect(await billing(cookie)).toMatchObject({ plan: "business" });
  expect((await subscriptionRows(org.id))[0]).toMatchObject({ plan: "business" });

  const deleted = stripeEvent(
    "customer.subscription.deleted",
    sub({ status: "canceled", trialEnd: undefined }),
    at(20),
  );
  expect((await postStripeEvent(worker.url, deleted)).body).toMatchObject({ applied: true });
  expect(await billing(cookie)).toMatchObject({
    plan: "free",
    readOnly: false,
    subscription: { status: "canceled" },
  });
  expect(await archive(cookie, threadId)).toBe(200);
  const final = await subscriptionRows(org.id);
  expect((await postStripeEvent(worker.url, deleted)).body).toMatchObject({ applied: false });
  expect(await subscriptionRows(org.id)).toEqual(final);

  const recorded = await database.db
    .select({ id: schema.stripeEvents.id, orgId: schema.stripeEvents.orgId })
    .from(schema.stripeEvents)
    .where(eq(schema.stripeEvents.objectId, sub({}).id));
  expect(recorded.map((e) => e.id).toSorted()).toEqual(
    [created.id, activated.id, late.id, movedUp.id, deleted.id].toSorted(),
  );
});

test("an event whose write did not land is retried, not acknowledged; one Omni ignores is", async () => {
  const { org, customer } = await workspace();
  const t0 = new Date(Date.now() - 60_000);
  const sub = subscriptionObject({
    id: `sub_e2e_${randomUUID().slice(0, 8)}`,
    customer,
    status: "trialing",
    periodStart: t0,
    periodEnd: new Date(t0.getTime() + 14 * 86_400_000),
    trialEnd: new Date(t0.getTime() + 14 * 86_400_000),
  });
  const recorded = async (id: string) =>
    database.db.select().from(schema.stripeEvents).where(eq(schema.stripeEvents.id, id));

  const activated = stripeEvent(
    "customer.subscription.updated",
    { ...sub, status: "active", trial_start: null, trial_end: null },
    new Date(t0.getTime() + 10_000),
  );
  expect((await postStripeEvent(worker.url, activated)).status).toBe(500);
  expect(await recorded(activated.id)).toEqual([]);
  expect(await subscriptionRows(org.id)).toEqual([]);

  const created = stripeEvent("customer.subscription.created", sub, t0);
  expect((await postStripeEvent(worker.url, created)).body).toMatchObject({ applied: true });
  expect(await postStripeEvent(worker.url, activated)).toMatchObject({
    status: 200,
    body: { applied: true },
  });
  expect(await subscriptionRows(org.id)).toMatchObject([
    { status: "active", stripeSubscriptionId: sub.id },
  ]);
  expect(await recorded(activated.id)).toHaveLength(1);

  const stranger = stripeEvent(
    "customer.subscription.updated",
    { ...sub, id: `sub_e2e_${randomUUID().slice(0, 8)}`, customer: "cus_e2e_nobody" },
    new Date(),
  );
  expect((await postStripeEvent(worker.url, stranger)).status).toBe(200);
  expect(await recorded(stranger.id)).toHaveLength(1);
});

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
  expect(
    (await api(worker, "/billing/portal", member.cookie, { method: "POST", body: "{}" })).status,
  ).toBe(403);
  expect(await billing(member.cookie)).toMatchObject({ canManage: false });
  for (const [method, path] of [
    ["GET", "/billing/cards"],
    ["POST", "/billing/cards/setup"],
    ["POST", "/billing/cards"],
    ["POST", "/billing/cards/pm_e2e/default"],
    ["DELETE", "/billing/cards/pm_e2e"],
    ["GET", "/billing/invoices"],
  ] as const) {
    const response = await api(worker, path, member.cookie, {
      method,
      body: method === "GET" ? undefined : JSON.stringify({ setupIntent: "seti_e2e" }),
    });
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 });
  }

  const direct = await api(worker, "/auth/subscription/upgrade", member.cookie, {
    method: "POST",
    headers: { origin: "http://localhost:5173" },
    body: JSON.stringify({ plan: "team" }),
  });
  expect(direct.status).toBe(404);

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

test("a new workspace finishes setup on Free: no plan, no trial, nothing to pay first", async () => {
  const { db } = database;
  const owner = await workspace("owner");
  await db
    .insert(schema.orgSetup)
    .values({ orgId: owner.org.id, step: "mailboxes_created" })
    .onConflictDoUpdate({ target: schema.orgSetup.orgId, set: { step: "mailboxes_created" } });
  expect(await (await api(worker, "/onboarding", owner.cookie)).json()).toMatchObject({
    billing: { enabled: true },
    organization: { setup: "mailboxes_created", needsPlan: false },
  });
  expect(await billing(owner.cookie)).toMatchObject({
    plan: "free",
    trialAvailable: false,
    trialDays: 0,
  });
  const trial = await api(worker, "/billing/trial", owner.cookie, {
    method: "POST",
    body: JSON.stringify({ interval: "month" }),
  });
  expect(trial.status).toBe(409);
  expect(
    await db.select().from(schema.trialClaims).where(eq(schema.trialClaims.orgId, owner.org.id)),
  ).toEqual([]);

  for (const body of [
    { interval: "month", returnPath: "//evil.example/x" },
    { interval: "month", returnPath: "https://evil.example" },
    { interval: "month", returnPath: "/\\evil.example" },
    { plan: "enterprise", interval: "month" },
    { plan: "free", interval: "month" },
  ]) {
    const refused = await api(worker, "/billing/checkout", owner.cookie, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect({ body, status: refused.status }).toEqual({ body, status: 400 });
  }

  const finished = await api(worker, "/onboarding/complete", owner.cookie, {
    method: "POST",
    body: "{}",
  });
  expect(finished.status).toBe(200);
  expect(await finished.json()).toMatchObject({ setup: "complete" });
});

async function withoutBilling(unbilled: Awaited<ReturnType<typeof startWorker>>) {
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

  const answer = await billing(cookie, unbilled);
  expect(await (await api(unbilled, "/onboarding", cookie)).json()).toMatchObject({
    billing: { enabled: false },
    organization: { needsPlan: false },
  });
  expect(await archive(cookie, threadId, unbilled)).toBe(200);
  expect(
    (await api(unbilled, "/billing/checkout", cookie, { method: "POST", body: "{}" })).status,
  ).toBe(404);
  expect((await api(unbilled, "/billing/cards", cookie)).status).toBe(404);
  expect((await api(unbilled, "/billing/invoices", cookie)).status).toBe(404);
  const webhook = await postStripeEvent(
    unbilled.url,
    stripeEvent("customer.subscription.created", {}, new Date()),
  );
  expect(webhook.status).toBe(404);
  return answer;
}

test("with no Stripe configuration there is no billing: no webhook, no limits, all writable", async () => {
  unbilled = await startWorker({ databaseUrl: database.url, mailServiceUrl: mailService.url });
  expect(await withoutBilling(unbilled)).toEqual({ enabled: false });
});

test("BILLING=off turns billing off with every Stripe setting still in place", async () => {
  switchedOff = await startWorker({
    databaseUrl: database.url,
    mailServiceUrl: mailService.url,
    vars: { BILLING: "off", ...PLAN_PRICES },
    secrets: BILLING_SECRETS,
  });
  expect(await withoutBilling(switchedOff)).toEqual({ enabled: false });
});

test("a Personal space is on Free like any workspace, and its owner may move it to a paid plan", async () => {
  const { db } = database;
  const email = `personal-${randomUUID().slice(0, 8)}@omni.test`;
  let cookie = await signIn(worker, db, email);
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  const spaceId = await ensurePersonalSpace(db, user!.id);
  await db
    .update(schema.sessions)
    .set({ activeOrganizationId: spaceId })
    .where(eq(schema.sessions.userId, user!.id));
  cookie = cookie
    .split("; ")
    .filter((c) => !c.includes("session_data"))
    .join("; ");

  expect(await billing(cookie)).toMatchObject({
    enabled: true,
    plan: "free",
    canManage: true,
    limits: { storageGb: 5, meetingMinutes: 0 },
  });
  await db
    .insert(schema.subscriptions)
    .values({ id: randomUUID(), plan: "team", orgId: spaceId, status: "active" });
  expect(await billing(cookie)).toMatchObject({ plan: "team", limits: { storageGb: 100 } });
});
