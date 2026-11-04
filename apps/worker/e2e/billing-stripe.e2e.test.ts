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
} from "./support.ts";
import { postStripeEvent } from "./stripe-events.ts";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const requested = process.env.STRIPE_E2E === "1";
const WEBHOOK_SECRET = `whsec_live_e2e_${randomUUID().replaceAll("-", "")}`;
const TRIAL_DAYS = 7;
/** The daily billing cron in wrangler.jsonc. */
const RECONCILE_CRON = "47 3 * * *";

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

  /** A workspace that is a Stripe customer, as its first checkout leaves it. */
  async function billedWorkspace(slug: string) {
    const org = await createOrg(database.db, slug);
    const customer = await stripe.customers.create({ metadata: { organizationId: org.id } });
    customers.push(customer.id);
    await database.db
      .update(schema.organizations)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.organizations.id, org.id));
    const rows = () =>
      database.db.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, org.id));
    return { org, customer: customer.id, rows };
  }

  const trial = (customer: string, metadata: Record<string, string>) =>
    stripe.subscriptions.create({
      customer,
      items: [{ price: prices.monthly }],
      trial_period_days: TRIAL_DAYS,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      metadata,
    });

  /** The daily billing cron, run the way Cloudflare runs it. */
  async function reconcile() {
    const result = await worker.server.getWorker().scheduled({ cron: RECONCILE_CRON });
    expect(result.outcome).toBe("ok");
  }

  test("the daily reconcile follows Stripe when no webhook arrives, and a rerun changes nothing", async () => {
    const { org, customer, rows } = await billedWorkspace("reconcile");

    // A subscription made in Stripe whose webhook never reached Omni: the cron creates its row.
    const subscription = await trial(customer, { referenceId: org.id });
    await reconcile();
    expect(await rows()).toMatchObject([
      {
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: customer,
        plan: "omnipresent",
        status: "trialing",
        billingInterval: "month",
        trialEnd: new Date((subscription.trial_end ?? 0) * 1000),
        periodEnd: new Date((subscription.items.data[0]?.current_period_end ?? 0) * 1000),
        cancelAtPeriodEnd: false,
        seats: 1,
      },
    ]);

    // Changed in Stripe (set to cancel at the trial's end): the row follows; a rerun is a no-op.
    await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
    await reconcile();
    const pending = await rows();
    expect(pending).toMatchObject([{ status: "trialing", cancelAtPeriodEnd: true }]);
    expect(pending[0]?.cancelAt).toBeInstanceOf(Date);
    await reconcile();
    expect(await rows()).toEqual(pending);

    // Canceled in Stripe: the row turns canceled, so the workspace is read-only; then it settles.
    await stripe.subscriptions.cancel(subscription.id);
    await reconcile();
    const canceled = await rows();
    expect(canceled).toMatchObject([{ status: "canceled" }]);
    expect(canceled[0]?.endedAt).toBeInstanceOf(Date);
    await reconcile();
    expect(await rows()).toEqual(canceled);
  }, 90_000);

  test("a checkout whose completion never arrived is linked to the row checkout made, not duplicated", async () => {
    const { org, customer, rows } = await billedWorkspace("reconcile-checkout");
    // What the plugin writes when checkout starts: a row that does not know its Stripe id yet,
    // whose id rides in the subscription's metadata.
    const rowId = randomUUID();
    await database.db.insert(schema.subscriptions).values({
      id: rowId,
      orgId: org.id,
      plan: "omnipresent",
      stripeCustomerId: customer,
      status: "incomplete",
    });
    const subscription = await trial(customer, { referenceId: org.id, subscriptionId: rowId });
    await reconcile();
    expect(await rows()).toMatchObject([
      { id: rowId, stripeSubscriptionId: subscription.id, status: "trialing" },
    ]);
  }, 60_000);
});
