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
        // The Worker only hands this to Stripe.js in the browser; here the SetupIntent is confirmed
        // with the secret key instead, as Stripe.js would.
        STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY || "pk_test_omnie2e",
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

  const api = (path: string, cookie: string, body?: unknown, method?: string) =>
    fetch(new URL(`/api${path}`, worker.url), {
      method: method ?? (body === undefined ? "GET" : "POST"),
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
      // Friends redeem a promotion code (100% off) here.
      allow_promotion_codes: true,
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

  test("setup's plan step: the trial starts with no card and no Stripe page; after it, Checkout charges", async () => {
    const { db } = database;
    const { org, cookie } = await ownerOf("plan-page");
    const plan = (await (await api("/billing", cookie)).json()) as {
      trialAvailable: boolean;
      prices: { month: { amount: number; currency: string } | null };
    };
    const monthly = await stripe.prices.retrieve(prices.monthly);
    expect(plan.trialAvailable).toBe(true);
    expect(plan.prices.month).toEqual({ amount: monthly.unit_amount, currency: monthly.currency });

    // Choosing the plan starts its trial at once: setup can move on without waiting for Stripe.
    const since = Math.floor(Date.now() / 1000) - 5;
    const started = await api("/billing/trial", cookie, { interval: "year" });
    expect(await started.json()).toEqual({ started: true });
    const onboarding = async () =>
      (
        (await (await api("/onboarding", cookie)).json()) as {
          organization: { needsPlan: boolean };
        }
      ).organization;
    expect(await onboarding()).toMatchObject({ needsPlan: false });
    const rows = () =>
      db.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, org.id));
    const [row] = await rows();
    expect(row).toMatchObject({ status: "trialing", billingInterval: "year", plan: "omnipresent" });
    const customer = await customerOf(org.id);
    const inStripe = await stripe.subscriptions.list({ customer, status: "all" });
    expect(inStripe.data).toHaveLength(1);
    expect(inStripe.data[0]).toMatchObject({ status: "trialing", default_payment_method: null });

    // A double click, then Stripe's own event for it: still one trial, one row.
    expect(await (await api("/billing/trial", cookie, { interval: "year" })).json()).toEqual({
      started: false,
    });
    const created = await forwardEvents(inStripe.data[0]!.id, since, [
      "customer.subscription.created",
    ]);
    expect(created.results.every((r) => r.status === 200)).toBe(true);
    expect(await rows()).toHaveLength(1);
    expect((await stripe.subscriptions.list({ customer, status: "all" })).data).toHaveLength(1);

    // The trial ends without a card (here, canceled in Stripe): the plan step is back, with no
    // second trial, and Checkout charges the first month now and returns to setup.
    const endedSince = Math.floor(Date.now() / 1000) - 1;
    await stripe.subscriptions.cancel(inStripe.data[0]!.id);
    await forwardEvents(inStripe.data[0]!.id, endedSince, ["customer.subscription.deleted"]);
    expect(await onboarding()).toMatchObject({ needsPlan: true });
    expect(await (await api("/billing", cookie)).json()).toMatchObject({ trialAvailable: false });
    expect((await api("/billing/trial", cookie, { interval: "month" })).status).toBe(409);
    expect(
      (await api("/billing/checkout", cookie, { interval: "month", returnPath: "/onboarding" }))
        .status,
    ).toBe(200);
    const [session] = (await stripe.checkout.sessions.list({ customer, limit: 1 })).data;
    expect(session!.amount_total).toBe(monthly.unit_amount);
    expect(decodeURIComponent(session!.success_url ?? "")).toContain("/onboarding");
    expect(session!.cancel_url).toMatch(/\/onboarding$/);

    // The same person makes a second workspace: their trial is spent, so it pays from day one,
    // and Checkout grants no trial of its own.
    const [owned] = await db
      .select({ userId: schema.members.userId })
      .from(schema.members)
      .where(eq(schema.members.organizationId, org.id));
    const userId = owned!.userId;
    const next = await createOrg(db, "plan-page-next");
    await db.insert(schema.members).values({
      id: randomUUID(),
      organizationId: next.id,
      userId: userId,
      role: "owner",
      createdAt: new Date(),
    });
    await db
      .update(schema.sessions)
      .set({ activeOrganizationId: next.id })
      .where(eq(schema.sessions.userId, userId));
    expect(await (await api("/billing", cookie)).json()).toMatchObject({ trialAvailable: false });
    expect((await api("/billing/trial", cookie, { interval: "month" })).status).toBe(409);
    expect(
      (await api("/billing/checkout", cookie, { interval: "month", returnPath: "/onboarding" }))
        .status,
    ).toBe(200);
    const [paid] = (await stripe.checkout.sessions.list({ customer: await customerOf(next.id) }))
      .data;
    // A trial would make the first charge 0.
    expect(paid!.amount_total).toBe(monthly.unit_amount);
  }, 90_000);

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

  test("cards: added by a SetupIntent, charged by the plan, the last one kept; invoices listed", async () => {
    const { org, cookie } = await ownerOf("cards");
    expect(await (await api("/billing/trial", cookie, { interval: "month" })).json()).toEqual({
      started: true,
    });
    const customer = await customerOf(org.id);
    const [trialing] = (await stripe.subscriptions.list({ customer })).data;
    type Cards = { cards: { id: string; brand: string; last4: string; isDefault: boolean }[] };
    const cards = async () => (await (await api("/billing/cards", cookie)).json()) as Cards;
    expect(await cards()).toEqual({ cards: [], addCard: true });

    /** What the add-card dialog does: a SetupIntent, confirmed by Stripe, then reported. */
    async function addCard(token: string) {
      const setup = await api("/billing/cards/setup", cookie, {});
      expect(setup.status).toBe(200);
      const { clientSecret } = (await setup.json()) as { clientSecret: string };
      const intentId = clientSecret.split("_secret_")[0]!;
      const confirmed = await stripe.setupIntents.confirm(intentId, { payment_method: token });
      expect(confirmed.status).toBe("succeeded");
      const saved = await api("/billing/cards", cookie, { setupIntent: intentId });
      expect(saved.status).toBe(200);
      return { ...((await saved.json()) as Cards), id: confirmed.payment_method as string };
    }
    const charged = async () => ({
      customer: ((await stripe.customers.retrieve(customer)) as Stripe.Customer).invoice_settings
        .default_payment_method,
      subscription: (await stripe.subscriptions.retrieve(trialing!.id)).default_payment_method,
    });

    // The first card becomes the one the trial charges: without it the trial would cancel at its end.
    const visa = await addCard("pm_card_visa");
    expect(visa.cards).toMatchObject([
      { id: visa.id, brand: "visa", last4: "4242", isDefault: true },
    ]);
    expect(await charged()).toEqual({ customer: visa.id, subscription: visa.id });

    // The plan needs a card: the only one cannot go.
    const lonely = await api(`/billing/cards/${visa.id}`, cookie, undefined, "DELETE");
    expect(lonely.status).toBe(409);

    // A second card is saved but charges nothing until made the default.
    const mastercard = await addCard("pm_card_mastercard");
    expect(mastercard.cards.map((c) => [c.brand, c.isDefault])).toEqual([
      ["visa", true],
      ["mastercard", false],
    ]);
    const made = await api(`/billing/cards/${mastercard.id}/default`, cookie, {});
    expect(((await made.json()) as Cards).cards[0]).toMatchObject({
      id: mastercard.id,
      isDefault: true,
    });
    expect(await charged()).toEqual({ customer: mastercard.id, subscription: mastercard.id });

    // Another workspace's owner cannot touch this workspace's cards.
    const stranger = await ownerOf("cards-stranger");
    expect(
      (await api(`/billing/cards/${visa.id}`, stranger.cookie, undefined, "DELETE")).status,
    ).toBe(404);
    expect((await api(`/billing/cards/${visa.id}/default`, stranger.cookie, {})).status).toBe(404);

    // Removing the card being charged moves the plan onto the one left, so the renewal still pays.
    const removed = await api(`/billing/cards/${mastercard.id}`, cookie, undefined, "DELETE");
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as Cards).cards).toMatchObject([
      { id: visa.id, isDefault: true },
    ]);
    expect(await charged()).toEqual({ customer: visa.id, subscription: visa.id });
    expect((await stripe.paymentMethods.retrieve(mastercard.id)).customer).toBeNull();

    // The trial's own $0 invoice, with Stripe's page and PDF.
    const { invoices } = (await (await api("/billing/invoices", cookie)).json()) as {
      invoices: { status: string; total: number; url: string | null; pdfUrl: string | null }[];
    };
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "paid", total: 0 });
    expect(invoices[0]!.url).toMatch(/^https:\/\/invoice\.stripe\.com\//);
    expect(invoices[0]!.pdfUrl).toMatch(/^https:\/\/pay\.stripe\.com\//);
  }, 120_000);
});
