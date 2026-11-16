// Storage billing against Stripe itself, in test mode (ADR 0034 "Verification"). Runs only when
// asked for: STRIPE_E2E=1 and a test-mode STRIPE_SECRET_KEY (`doppler run -p omni -c dev_worker
// -- env STRIPE_E2E=1 pnpm --filter @omni/worker test:e2e e2e/storage-billing-stripe`); never in
// `pnpm test` or CI. It refuses a live key. It uses STRIPE_PRICE_MONTHLY / STRIPE_PRICE_YEARLY /
// STRIPE_PRICE_STORAGE / STRIPE_STORAGE_METER_EVENT when set, else creates the plan's prices (lookup
// keys `omni-e2e-monthly` / `omni-e2e-yearly`), a `last` meter (event `omni_e2e_storage_gb`) and its
// metered price (lookup key `omni-e2e-storage`) in the test account on first run.
//
// Meter events are processed asynchronously, so what was billed is read back from the meter's
// event summaries and the subscription's invoice preview, polled until they settle.
import { randomUUID } from "node:crypto";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startStorageStack, type StorageStack } from "./storage-support.ts";

const key = process.env.STRIPE_SECRET_KEY ?? "";
const requested = process.env.STRIPE_E2E === "1";
const GIB = 1024 ** 3;
const DAY_MS = 86_400_000;
const METER_EVENT = "omni_e2e_storage_gb";
/** The plan includes 1 GB here. */
const INCLUDED_GB = 1;

/** Polls `read` until `done` holds of its value, for up to `ms`. */
async function settle<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

describe.runIf(requested)("Storage billing in Stripe test mode", () => {
  let stripe: Stripe;
  let stack: StorageStack;
  let prices: { monthly: string; yearly: string; storage: string };
  let meter: Stripe.Billing.Meter;
  const customers: string[] = [];
  const clocks: string[] = [];

  async function price(
    lookupKey: string,
    recurring: Stripe.PriceCreateParams.Recurring,
    amount: number,
  ) {
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
    if (found.data[0]) return found.data[0].id;
    const product = await stripe.products.create({ name: `Omni ${lookupKey}` });
    const created = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: amount,
      recurring,
      lookup_key: lookupKey,
    });
    return created.id;
  }

  async function storageMeter(eventName: string) {
    for await (const found of stripe.billing.meters.list({ status: "active", limit: 100 })) {
      if (found.event_name === eventName) return found;
    }
    return stripe.billing.meters.create({
      display_name: "Omni storage GB (e2e)",
      event_name: eventName,
      default_aggregation: { formula: "last" },
      customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
      value_settings: { event_payload_key: "value" },
    });
  }

  beforeAll(async () => {
    if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
      throw new Error("STRIPE_E2E needs a test-mode STRIPE_SECRET_KEY (sk_test_…); refusing");
    }
    stripe = new Stripe(key);
    meter = await storageMeter(process.env.STRIPE_STORAGE_METER_EVENT || METER_EVENT);
    if (meter.default_aggregation.formula !== "last") {
      throw new Error(`meter ${meter.event_name} must aggregate with last`);
    }
    prices = {
      monthly:
        process.env.STRIPE_PRICE_MONTHLY ||
        (await price("omni-e2e-monthly", { interval: "month" }, 1_900)),
      yearly:
        process.env.STRIPE_PRICE_YEARLY ||
        (await price("omni-e2e-yearly", { interval: "year" }, 19_000)),
      storage:
        process.env.STRIPE_PRICE_STORAGE ||
        (await price(
          "omni-e2e-storage",
          { interval: "month", usage_type: "metered", meter: meter.id },
          50,
        )),
    };
    stack = await startStorageStack({
      vars: {
        STRIPE_PRICE_MONTHLY: prices.monthly,
        STRIPE_PRICE_YEARLY: prices.yearly,
        BILLING_TRIAGE_ALLOWANCE: "500",
        BILLING_STORAGE_INCLUDED_GB: String(INCLUDED_GB),
        STRIPE_PRICE_STORAGE: prices.storage,
        STRIPE_STORAGE_METER_EVENT: meter.event_name,
      },
      secrets: {
        STRIPE_SECRET_KEY: key,
        STRIPE_WEBHOOK_SECRET: `whsec_e2e_${randomUUID().replaceAll("-", "")}`,
      },
    });
  }, 120_000);

  afterAll(async () => {
    for (const id of customers) await stripe?.customers.del(id).catch(() => {});
    // Deleting a test clock deletes its customers and their subscriptions.
    for (const id of clocks) await stripe?.testHelpers.testClocks.del(id).catch(() => {});
    await stack?.stop();
  });

  /**
   * A company that pays `priceId` with a test card, as a paid Checkout leaves it: the workspace's
   * customer, its default card, the subscription. Its row is written by the daily reconcile.
   */
  async function payingWorkspace(slug: string, priceId: string, storedBytes: number) {
    const org = await stack.company(slug);
    const customer = await stripe.customers.create({
      metadata: { organizationId: org.id, customerType: "organization" },
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    customers.push(customer.id);
    await stack.db
      .update(schema.organizations)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.organizations.id, org.id));
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      metadata: { referenceId: org.id },
    });
    expect(subscription.status).toBe("active");
    await store(org.id, storedBytes);
    return { org, customer: customer.id, subscription };
  }

  /**
   * What a workspace stores: one Shared file row of `bytes` and the counter to match. The daily
   * recount runs beside the billing and sums the file rows, so a counter alone would be reset.
   * No object is uploaded: nothing here reads it.
   */
  async function store(orgId: string, bytes: number) {
    const [file] = await stack.db
      .select({ id: schema.storageNodes.id })
      .from(schema.storageNodes)
      .where(eq(schema.storageNodes.orgId, orgId));
    if (file) {
      await stack.db
        .update(schema.storageNodes)
        .set({ size: bytes })
        .where(eq(schema.storageNodes.id, file.id));
    } else {
      await stack.db.insert(schema.storageNodes).values({
        orgId,
        space: "shared",
        kind: "file",
        name: "stored.bin",
        size: bytes,
        r2Key: `orgs/${orgId}/${randomUUID()}`,
      });
    }
    await stack.db
      .insert(schema.storageUsage)
      .values({ orgId, bytes })
      .onConflictDoUpdate({ target: schema.storageUsage.orgId, set: { bytes } });
  }

  /** The daily billing cron, run the way Cloudflare runs it: reconcile, then Storage's meter. */
  async function daily() {
    expect(await stack.cron("47 3 * * *")).toBe("ok");
  }

  const storageItems = async (subscriptionId: string) =>
    (await stripe.subscriptions.retrieve(subscriptionId)).items.data.filter(
      (item) => item.price.id === prices.storage,
    );

  /** The meter's value for `customer` from `since` on: the `last` value Stripe holds. */
  async function meterValue(customer: string, since: Date) {
    const summaries = await stripe.billing.meters.listEventSummaries(meter.id, {
      customer,
      start_time: Math.floor(since.getTime() / 1000 / 60) * 60,
      end_time: Math.ceil((Date.now() + 60_000) / 1000 / 60) * 60,
    });
    return summaries.data.at(-1)?.aggregated_value ?? null;
  }

  /** Quantity of the storage line on the subscription's next invoice. */
  async function previewQuantity(customer: string, subscription: string) {
    const preview = await stripe.invoices.createPreview({ customer, subscription });
    const line = preview.lines.data.find((l) => l.pricing?.price_details?.price === prices.storage);
    return line?.quantity ?? null;
  }

  test("the daily job run twice for one workspace bills its peak once, and a lower day bills the peak", async () => {
    const since = new Date(Date.now() - 60_000);
    // 3.5 GB above the 1 GB included: 3 whole GB.
    const stored = (INCLUDED_GB + 3.5) * GIB;
    const { org, customer, subscription } = await payingWorkspace(
      "metered",
      prices.monthly,
      stored,
    );

    await daily();
    await daily();
    // The item went on once, and is a monthly metered item next to the plan's.
    expect(await storageItems(subscription.id)).toHaveLength(1);
    const [peak] = await stack.db
      .select()
      .from(schema.storagePeaks)
      .where(eq(schema.storagePeaks.orgId, org.id));
    expect(peak?.peakBytes).toBe(stored);
    expect(
      await settle(
        () => meterValue(customer, since),
        (v) => v === 3,
      ),
    ).toBe(3);
    expect(
      await settle(
        () => previewQuantity(customer, subscription.id),
        (v) => v === 3,
      ),
    ).toBe(3);

    // Files deleted: what is billed is still the month's peak.
    await store(org.id, INCLUDED_GB * GIB);
    await daily();
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    expect(await meterValue(customer, since)).toBe(3);
    expect(await previewQuantity(customer, subscription.id)).toBe(3);

    // A higher peak the same day is a new value, not a duplicate of the first.
    await store(org.id, (INCLUDED_GB + 5) * GIB);
    await daily();
    expect(
      await settle(
        () => meterValue(customer, since),
        (v) => v === 5,
      ),
    ).toBe(5);
  }, 300_000);

  test("a yearly workspace gets no metered item and no meter event; it is capped at the allowance", async () => {
    const since = new Date(Date.now() - 60_000);
    const { org, customer, subscription } = await payingWorkspace(
      "yearly",
      prices.yearly,
      (INCLUDED_GB + 2) * GIB,
    );
    await daily();
    expect(await storageItems(subscription.id)).toHaveLength(0);
    const [row] = await stack.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.orgId, org.id));
    expect(row).toMatchObject({ status: "active", billingInterval: "year" });
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    expect(await meterValue(customer, since)).toBeNull();
    const owner = await stack.member(org.id, "owner");
    expect((await stack.api(owner.jar, "GET", "/usage")).body).toMatchObject({
      limitBytes: INCLUDED_GB * GIB,
      allowanceBytes: INCLUDED_GB * GIB,
      overage: null,
      uploadsBlocked: "storage_full",
    });
  }, 180_000);

  // Confirms two things the ADR left to Stripe (ADR 0034 "Verification"): a monthly metered item
  // on a monthly classic subscription bills the last value of its period, and a period in which
  // nothing was reported bills 0, not the previous period's value. Meter events are sent here
  // directly (the daily job stamps them with the real time, which a test clock's time is not).
  test("on a test clock, a `last` meter bills each period's last value, and a silent period bills nothing", async () => {
    const start = Math.floor(Date.now() / 1000);
    const clock = await stripe.testHelpers.testClocks.create({ frozen_time: start });
    clocks.push(clock.id);
    const customer = await stripe.customers.create({
      test_clock: clock.id,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: prices.monthly }, { price: prices.storage }],
    });
    const send = (value: number, identifier: string, at: number) =>
      stripe.billing.meterEvents.create({
        event_name: meter.event_name,
        payload: { stripe_customer_id: customer.id, value: String(value) },
        identifier,
        timestamp: at,
      });
    await send(4, `e2e-${randomUUID()}`, start + 60);
    await send(2, `e2e-${randomUUID()}`, start + 120);
    // A duplicate identifier is dropped (or refused): the value stays 2.
    const repeated = `e2e-${randomUUID()}`;
    await send(7, repeated, start + 180);
    await send(7, repeated, start + 180).catch(() => {});
    // Stripe's note on test clocks: let events aggregate before advancing.
    await new Promise((resolve) => setTimeout(resolve, 90_000));

    async function advance(to: number) {
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: to });
      await settle(
        () => stripe.testHelpers.testClocks.retrieve(clock.id),
        (c) => c.status === "ready",
        180_000,
      );
    }
    const storageQuantity = async (periodStart: number) => {
      const invoices = await stripe.invoices.list({ subscription: subscription.id, limit: 10 });
      const invoice = invoices.data.find((i) => i.period_start === periodStart);
      const line = invoice?.lines.data.find(
        (l) => l.pricing?.price_details?.price === prices.storage,
      );
      return line ? line.quantity : null;
    };

    // One month and a day on: the first period's invoice bills the last value, 7.
    const firstEnd = subscription.items.data[0]!.current_period_end;
    await advance(firstEnd + DAY_MS / 1000);
    expect(await storageQuantity(start)).toBe(7);
    // Another month with no event: the second period bills 0.
    await advance(firstEnd + 32 * (DAY_MS / 1000));
    expect(await storageQuantity(firstEnd)).toBe(0);
  }, 600_000);
});
