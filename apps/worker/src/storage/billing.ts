import { usagePeriod } from "@omni/ai";
import type { BillingConfig } from "@omni/auth";
import {
  noteSubscriptionPaymentMethod,
  raiseStoragePeak,
  setStorageOverage,
  storageBilledWorkspaces,
  type Db,
  type StorageBilledWorkspace,
} from "@omni/db";
import { Effect } from "effect";
import type Stripe from "stripe";
import { type JobError, Permanent, Retryable, retried } from "../job-effects.ts";
import type { Logger } from "../log.ts";
import { billsOverage, extraGb } from "./core.ts";

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const STRIPE_REQUEST_INTERVAL_MS = 100;
const STRIPE_TIMEOUT_MS = 20_000;
const ITEM_KEPT_MS = 7 * DAY_MS;

export interface StorageBillingResult {
  /** Workspaces whose peak was recorded. */
  workspaces: number;
  /** Meter events sent. */
  reported: number;
  itemsAdded: number;
  itemsRemoved: number;
  /** Workspaces that could not be read or told to Stripe; the next run repairs them. */
  errors: number;
}

const idOf = (ref: string | { id: string }) => (typeof ref === "string" ? ref : ref.id);

function hasPaymentMethod(subscription: Stripe.Subscription) {
  const customer = subscription.customer;
  const ofCustomer =
    typeof customer === "string" || customer.deleted
      ? null
      : (customer.invoice_settings?.default_payment_method ?? customer.default_source);
  return Boolean(subscription.default_payment_method ?? ofCustomer);
}

function storageItemKey(subscriptionId: string, priceId: string, periodStart: Date, now: Date) {
  const day = now.toISOString().slice(0, 10);
  return `omni-storage-item-${subscriptionId}-${priceId}-${periodStart.toISOString()}-${day}`;
}

/**
 * The meter event's identifier: Stripe drops a second event with the same one for at least a
 * day, so a run repeated with nothing new is one event. The period and the value are in it, so
 * a higher peak later the same day, or a new period's first value, still goes through.
 */
export async function meterEventIdentifier(input: {
  orgId: string;
  periodStart: Date;
  day: string;
  extraGb: number;
}) {
  const text = [input.orgId, input.periodStart.toISOString(), input.day, input.extraGb].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `omni-storage-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function billWorkspace(
  input: Pick<BillingRun, "db" | "stripe" | "storage" | "now">,
  workspace: StorageBilledWorkspace & { stripeCustomerId: string; stripeSubscriptionId: string },
  period: { start: Date; peakBytes: number },
  result: StorageBillingResult,
) {
  const { db, stripe, storage, now } = input;
  const subscription = await stripe.subscriptions.retrieve(
    workspace.stripeSubscriptionId,
    { expand: ["customer"] },
    { timeout: STRIPE_TIMEOUT_MS },
  );
  const card = hasPaymentMethod(subscription);
  await setStorageOverage(db, workspace.orgId, card ? subscription.id : null);
  const billable =
    card &&
    !subscription.schedule &&
    (subscription.status === "active" || subscription.status === "past_due");
  const extra = extraGb(period.peakBytes, Math.floor(storage.includedGb * GB));
  let item = subscription.items.data.find((i) => i.price.id === storage.priceId);
  if (!item && billable && extra > 0) {
    const updated = await stripe.subscriptions.update(
      subscription.id,
      { items: [{ price: storage.priceId }], proration_behavior: "none" },
      {
        timeout: STRIPE_TIMEOUT_MS,
        idempotencyKey: storageItemKey(subscription.id, storage.priceId, period.start, now),
      },
    );
    item = updated.items.data.find((i) => i.price.id === storage.priceId);
    result.itemsAdded++;
  } else if (item && extra === 0 && now.getTime() - period.start.getTime() >= ITEM_KEPT_MS) {
    await stripe.subscriptionItems.del(
      item.id,
      { proration_behavior: "none" },
      { timeout: STRIPE_TIMEOUT_MS, idempotencyKey: `omni-storage-item-del-${item.id}` },
    );
    item = undefined;
    result.itemsRemoved++;
  }
  if (!item) return;
  await stripe.billing.meterEvents.create(
    {
      event_name: storage.meterEvent,
      payload: { stripe_customer_id: idOf(subscription.customer), value: String(extra) },
      identifier: await meterEventIdentifier({
        orgId: workspace.orgId,
        periodStart: period.start,
        day: now.toISOString().slice(0, 10),
        extraGb: extra,
      }),
      timestamp: Math.floor(Math.max(now.getTime(), Date.now()) / 1000),
    },
    { timeout: STRIPE_TIMEOUT_MS },
  );
  result.reported++;
}

interface BillingRun {
  db: Db;
  stripe: Stripe;
  storage: NonNullable<BillingConfig["storage"]>;
  now: Date;
  result: StorageBillingResult;
  pace: { next: number };
}

/**
 * The daily job. Nothing to do when the plan has no storage allowance. A workspace that fails
 * is logged and left for the next run: the peak only rises, and the meter keeps the last value.
 */
export function billStorage(input: {
  db: Db;
  stripe: Stripe;
  billing: BillingConfig;
  log: Logger;
  now?: Date;
}) {
  const { db, stripe, billing, log, now = new Date() } = input;
  return Effect.gen(function* () {
    const storage = billing.storage;
    if (!storage) return null;
    const result: StorageBillingResult = {
      workspaces: 0,
      reported: 0,
      itemsAdded: 0,
      itemsRemoved: 0,
      errors: 0,
    };
    const run: BillingRun = { db, stripe, storage, now, result, pace: { next: 0 } };
    const workspaces = yield* retried("billed_workspaces", () => storageBilledWorkspaces(db));
    yield* Effect.forEach(
      workspaces,
      (workspace) =>
        billOne(run, workspace).pipe(
          Effect.catchDefect((cause) => Effect.fail(new Retryable({ step: "workspace", cause }))),
          Effect.catch((failure) =>
            Effect.sync(() => {
              result.errors++;
              log.warn("storage.billing.workspace_failed", {
                orgId: workspace.orgId,
                error: failure.cause,
                step: failure.step,
                permanent: failure instanceof Permanent,
              });
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    return result;
  }) satisfies Effect.Effect<StorageBillingResult | null, JobError>;
}

function billOne(run: BillingRun, workspace: StorageBilledWorkspace) {
  const { db, result, now } = run;
  return Effect.gen(function* () {
    const { periodStart } = workspace;
    if (!periodStart) return;
    const { start } = yield* Effect.try({
      try: () =>
        usagePeriod(
          { periodStart, periodEnd: workspace.periodEnd, interval: workspace.billingInterval },
          now,
        ),
      catch: (cause) => new Permanent({ step: "usage_period", cause }),
    });
    const peakBytes = yield* retried("raise_peak", () =>
      raiseStoragePeak(db, { orgId: workspace.orgId, periodStart: start, bytes: workspace.bytes }),
    );
    result.workspaces++;
    const { stripeCustomerId } = workspace;
    if (!stripeCustomerId || !billsOverage(workspace)) return;
    const wait = run.pace.next - Date.now();
    if (wait > 0) yield* Effect.sleep(wait);
    run.pace.next = Date.now() + STRIPE_REQUEST_INTERVAL_MS;
    yield* retried("stripe", () =>
      billWorkspace(run, { ...workspace, stripeCustomerId }, { start, peakBytes }, result),
    );
  }) satisfies Effect.Effect<void, JobError>;
}

/**
 * From Stripe's webhook: a subscription event that shows a payment method on the subscription
 * (Checkout and the app's own card form both set one) lets that workspace's uploads pass the
 * allowance at once, without waiting for the daily job. An event without one proves nothing
 * (the card may be the customer's default), so only the daily job takes the fact away.
 */
export async function notePaymentMethod(db: Db, billing: BillingConfig, event: Stripe.Event) {
  if (!billing.storage) return;
  if (
    event.type !== "customer.subscription.created" &&
    event.type !== "customer.subscription.updated"
  ) {
    return;
  }
  const subscription = event.data.object;
  if (!subscription.default_payment_method) return;
  await noteSubscriptionPaymentMethod(db, {
    stripeCustomerId: idOf(subscription.customer),
    stripeSubscriptionId: subscription.id,
  });
}
