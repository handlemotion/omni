// Billing against Stripe itself, in test mode. Runs only when asked for: STRIPE_E2E=1 and a
// test-mode STRIPE_SECRET_KEY (`doppler run -p omni -c dev_worker -- env STRIPE_E2E=1 pnpm
// --filter @omni/worker test:e2e billing-stripe`); never in `pnpm test` or CI. It refuses a
// live key. It uses the plan's prices from STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY when set,
// else creates them in the test account on first run (lookup keys `omni-e2e-monthly` /
// `omni-e2e-yearly`). Events are the ones Stripe really emitted, read back
// from its API and re-signed for this Worker, so no tunnel (`stripe listen`) is needed.
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createMailbox,
  createMember,
  createOrg,
  createTestDatabase,
  signIn,
  startMailServiceEndpoint,
  startWorker,
  SYSTEM_MAIL_FROM,
  workerEvents,
} from "./support.ts";
import { postStripeEvent } from "./stripe-events.ts";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const requested = process.env.STRIPE_E2E === "1";
const WEBHOOK_SECRET = `whsec_live_e2e_${randomUUID().replaceAll("-", "")}`;
const TRIAL_DAYS = 7;

describe.runIf(requested)("Stripe test mode", () => {
  let stripe: Stripe;
  let prices: { monthly: string; yearly: string };
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let mailService: Awaited<ReturnType<typeof startMailServiceEndpoint>>;
  let worker: Awaited<ReturnType<typeof startWorker>>;
  const customers: string[] = [];

  async function price(lookupKey: string, interval: "month" | "year", amount: number) {
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    if (found.data[0]) return found.data[0].id;
    const product = await stripe.products.create({ name: "Omni workspace (e2e)" });
    const created = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: amount,
      recurring: { interval },
      lookup_key: lookupKey,
    });
    return created.id;
  }

  /** Stripe's own events about `objectId` since `since`, oldest first, forwarded to the Worker. */
  async function forwardEvents(objectId: string, since: number, types: string[]) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const events = (await stripe.events.list({ created: { gte: since }, limit: 100 })).data
        .filter((e) => (e.data.object as { id?: string }).id === objectId && types.includes(e.type))
        .toReversed();
      if (types.every((type) => events.some((e) => e.type === type))) {
        const results = [];
        for (const event of events) {
          results.push(await postStripeEvent(worker.url, event, { secret: WEBHOOK_SECRET }));
        }
        return { events, results };
      }
      if (Date.now() > deadline) throw new Error(`Stripe never emitted ${types.join(", ")}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  beforeAll(async () => {
    if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
      throw new Error("STRIPE_E2E needs a test-mode STRIPE_SECRET_KEY (sk_test_…); refusing");
    }
    stripe = new Stripe(key);
    prices = {
      monthly:
        process.env.STRIPE_PRICE_MONTHLY || (await price("omni-e2e-monthly", "month", 1_900)),
      yearly: process.env.STRIPE_PRICE_YEARLY || (await price("omni-e2e-yearly", "year", 19_000)),
    };
    database = await createTestDatabase();
    mailService = await startMailServiceEndpoint();
    worker = await startWorker({
      databaseUrl: database.url,
      mailServiceUrl: mailService.url,
      vars: {
        STRIPE_PRICE_MONTHLY: prices.monthly,
        STRIPE_PRICE_YEARLY: prices.yearly,
        BILLING_TRIAL_DAYS: String(TRIAL_DAYS),
        BILLING_TRIAGE_ALLOWANCE: "500",
      },
      secrets: { STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
    });
    const system = await createOrg(database.db, "system");
    await createMailbox(database.db, system.id, SYSTEM_MAIL_FROM);
  }, 60_000);

  afterAll(async () => {
    for (const customer of customers) await stripe?.customers.del(customer).catch(() => {});
    await worker?.server.close();
    await mailService?.close();
    await database?.teardown();
  });

  const api = (path: string, cookie: string, body?: unknown) =>
    fetch(new URL(`/api${path}`, worker.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test("a workspace starts a trial, is subscribed by Stripe's events, and opens the portal", async () => {
    const { db } = database;
    const org = await createOrg(db, "stripe");
    const email = `owner-${randomUUID().slice(0, 8)}@omni.test`;
    const member = await createMember(db, org.id, email);
    await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
    const cookie = await signIn(worker, db, email);

    // Checkout: a real Stripe Checkout Session for the workspace, with the trial and no card.
    const started = await api("/billing/checkout", cookie, { interval: "year" });
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [organization] = await db
      .select({ customer: schema.organizations.stripeCustomerId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
    const customer = organization!.customer!;
    customers.push(customer);
    const sessions = await stripe.checkout.sessions.list({ customer, limit: 1 });
    expect(sessions.data[0]).toMatchObject({
      mode: "subscription",
      client_reference_id: org.id,
      payment_method_collection: "if_required",
    });
    const items = await stripe.checkout.sessions.listLineItems(sessions.data[0]!.id);
    expect(items.data[0]?.price?.id).toBe(prices.yearly);

    // Completing Checkout needs a browser; the subscription it creates is made here instead, the
    // same way: the workspace's customer, the plan's price, the trial, no card.
    const since = Math.floor(Date.now() / 1000) - 5;
    const subscription = await stripe.subscriptions.create({
      customer,
      items: [{ price: prices.monthly }],
      trial_period_days: TRIAL_DAYS,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      metadata: { referenceId: org.id },
    });
    const created = await forwardEvents(subscription.id, since, ["customer.subscription.created"]);
    expect(created.results.every((r) => r.status === 200)).toBe(true);
    const state = (await (await api("/billing", cookie)).json()) as Record<string, unknown>;
    expect(state).toMatchObject({
      readOnly: false,
      subscription: { status: "trialing", interval: "month" },
      triage: { used: 0, allowance: 500 },
    });

    // Replaying Stripe's real event changes nothing.
    const before = await db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.orgId, org.id));
    const replay = await postStripeEvent(worker.url, created.events[0], { secret: WEBHOOK_SECRET });
    expect(replay.body).toMatchObject({ applied: false, reason: "duplicate" });
    expect(
      await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, org.id)),
    ).toEqual(before);

    // The customer portal for that workspace.
    const portal = await api("/billing/portal", cookie, {});
    expect(portal.status).toBe(200);
    expect(((await portal.json()) as { url: string }).url).toMatch(
      /^https:\/\/billing\.stripe\.com\//,
    );

    // Canceled in Stripe: the workspace turns read-only.
    const canceledSince = Math.floor(Date.now() / 1000) - 1;
    await stripe.subscriptions.cancel(subscription.id);
    await forwardEvents(subscription.id, canceledSince, ["customer.subscription.deleted"]);
    expect(await (await api("/billing", cookie)).json()).toMatchObject({
      readOnly: true,
      subscription: { status: "canceled" },
    });
  }, 90_000);

  async function ownerOf(slug: string) {
    const { db } = database;
    const org = await createOrg(db, slug);
    const email = `owner-${randomUUID().slice(0, 8)}@omni.test`;
    const member = await createMember(db, org.id, email);
    await db.update(schema.members).set({ role: "owner" }).where(eq(schema.members.id, member.id));
    return { org, cookie: await signIn(worker, db, email) };
  }

  async function customerOf(orgId: string) {
    const [organization] = await database.db
      .select({ customer: schema.organizations.stripeCustomerId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    const customer = organization!.customer!;
    if (!customers.includes(customer)) customers.push(customer);
    return customer;
  }

  test("a second checkout expires the first, so two tabs cannot both subscribe", async () => {
    const { org, cookie } = await ownerOf("two-tabs");
    const first = await api("/billing/checkout", cookie, { interval: "month" });
    expect(first.status).toBe(200);
    const customer = await customerOf(org.id);
    const [opened] = (await stripe.checkout.sessions.list({ customer, limit: 1 })).data;
    expect(opened?.status).toBe("open");

    const second = await api("/billing/checkout", cookie, { interval: "year" });
    expect(second.status).toBe(200);
    expect((await stripe.checkout.sessions.retrieve(opened!.id)).status).toBe("expired");
    const open = await stripe.checkout.sessions.list({ customer, status: "open" });
    expect(open.data).toHaveLength(1);
    expect(open.data[0]!.id).not.toBe(opened!.id);
  }, 60_000);

  test("two paid subscriptions for one workspace: the newer is canceled, the older kept", async () => {
    const { org, cookie } = await ownerOf("duplicate");
    expect((await api("/billing/checkout", cookie, { interval: "month" })).status).toBe(200);
    const customer = await customerOf(org.id);

    // Both checkouts completing, as Stripe's API does it: same customer, plan and trial.
    const since = Math.floor(Date.now() / 1000) - 5;
    const subscribe = () =>
      stripe.subscriptions.create({
        customer,
        items: [{ price: prices.monthly }],
        trial_period_days: TRIAL_DAYS,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { referenceId: org.id },
      });
    const older = await subscribe();
    const newer = await subscribe();

    const created = [
      ...(await forwardEvents(older.id, since, ["customer.subscription.created"])).results,
      ...(await forwardEvents(newer.id, since, ["customer.subscription.created"])).results,
    ];
    expect(created.every((r) => r.status === 200)).toBe(true);
    expect((await stripe.subscriptions.retrieve(older.id)).status).toBe("trialing");
    expect((await stripe.subscriptions.retrieve(newer.id)).status).toBe("canceled");
    // Not refunded automatically: an error a person sees, naming what to refund.
    expect(
      workerEvents(worker).filter((e) => e.event === "billing.duplicate_subscription_canceled"),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        orgId: org.id,
        customerId: customer,
        keptSubscriptionId: older.id,
        canceledSubscriptionId: newer.id,
      }),
    ]);

    // What the cancel made Stripe send: the newer one deleted, the older one touched.
    const deleted = await forwardEvents(newer.id, since, ["customer.subscription.deleted"]);
    const touched = await forwardEvents(older.id, since, [
      "customer.subscription.created",
      "customer.subscription.updated",
    ]);
    const all = [...deleted.events, ...touched.events];
    expect(await (await api("/billing", cookie)).json()).toMatchObject({
      readOnly: false,
      subscription: { status: "trialing" },
    });

    // Replaying every event again cancels nothing more: the survivor stays.
    for (const event of all) {
      await postStripeEvent(worker.url, event, { secret: WEBHOOK_SECRET });
    }
    const paid = await stripe.subscriptions.list({ customer, status: "all" });
    expect(
      paid.data
        .filter((s) => ["active", "trialing", "past_due"].includes(s.status))
        .map((s) => s.id),
    ).toEqual([older.id]);
  }, 120_000);
});
