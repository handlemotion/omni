// Storage on the bill (ADR 0034 decision 7 and its amendment). Once a day each workspace's peak
// for its usage month is raised to what it stores, and what a paying monthly workspace stored
// above the plan's allowance is told to Stripe's meter, which bills the last value it heard in
// the billing period. Stripe is asked, here and never on a request, whether the subscription has
// a payment method; the answer is what lets uploads pass the allowance. Safe to run twice.
// The daily job is an Effect program (ADR 0038 decision 2): each workspace is billed on its own,
// a Stripe 429 or 5xx is retried in the run, and a workspace that still fails waits for tomorrow.
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
import {
  attempt,
  type JobError,
  Permanent,
  Retryable,
  retried,
  retryTransient,
  within,
} from "../job-effects.ts";
import type { Logger } from "../log.ts";
import { billsOverage, extraGb } from "./core.ts";

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Stripe allows about 25 requests a second in test mode (100 live); stay well under. */
const STRIPE_REQUEST_INTERVAL_MS = 100;
/** One try at one workspace's Stripe calls; past it the try is abandoned and retried. */
const STRIPE_TIME_LIMIT = "20 seconds";
/**
 * How far into a billing period with nothing to bill the metered item is taken off again. Its
 * removal drops whatever that item has not been invoiced for, so it waits until the period
 * before is long invoiced (an invoice stays a draft for an hour, or the account's grace period).
 */
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

/** Whether Stripe has something to charge for `subscription` (its customer expanded). */
function hasPaymentMethod(subscription: Stripe.Subscription) {
  const customer = subscription.customer;
  const ofCustomer =
    typeof customer === "string" || customer.deleted
      ? null
      : (customer.invoice_settings?.default_payment_method ?? customer.default_source);
  return Boolean(subscription.default_payment_method ?? ofCustomer);
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

/**
 * The Stripe half for one workspace whose row says extra storage could be billed: learn whether
 * it has a card, put the metered item on its subscription the first time it stores more than
 * the allowance (and take it off in a later period that stays under it, so the customer portal
 * can change the plan again), and tell the meter this period's value while the item is there.
 */
async function billWorkspace(
  input: Pick<BillingRun, "db" | "stripe" | "storage" | "now">,
  workspace: StorageBilledWorkspace & { stripeCustomerId: string; stripeSubscriptionId: string },
  period: { start: Date; peakBytes: number },
  result: StorageBillingResult,
) {
  const { db, stripe, storage, now } = input;
  const subscription = await stripe.subscriptions.retrieve(workspace.stripeSubscriptionId, {
    expand: ["customer"],
  });
  const card = hasPaymentMethod(subscription);
  await setStorageOverage(db, workspace.orgId, card ? subscription.id : null);
  const billable =
    card &&
    !subscription.schedule &&
    (subscription.status === "active" || subscription.status === "past_due");
  const extra = extraGb(period.peakBytes, Math.floor(storage.includedGb * GB));
  let item = subscription.items.data.find((i) => i.price.id === storage.priceId);
  if (!item && billable && extra > 0) {
    // Before the event: on a classic subscription an item added mid-period is billed only for
    // what is reported after it was added.
    const updated = await stripe.subscriptions.update(subscription.id, {
      items: [{ price: storage.priceId }],
      proration_behavior: "none",
    });
    item = updated.items.data.find((i) => i.price.id === storage.priceId);
    result.itemsAdded++;
  } else if (item && extra === 0 && now.getTime() - period.start.getTime() >= ITEM_KEPT_MS) {
    await stripe.subscriptionItems.del(item.id, { proration_behavior: "none" });
    item = undefined;
    result.itemsRemoved++;
  }
  if (!item) return;
  // Every day, 0 included: the meter bills the last value of the period, and a period nobody
  // reported in has none.
  await stripe.billing.meterEvents.create({
    event_name: storage.meterEvent,
    payload: { stripe_customer_id: idOf(subscription.customer), value: String(extra) },
    identifier: await meterEventIdentifier({
      orgId: workspace.orgId,
      periodStart: period.start,
      day: now.toISOString().slice(0, 10),
      extraGb: extra,
    }),
    // Stamped when sent, not when the job started: an item added above in this run would
    // otherwise exist only after its first event, and that event would not be billed.
    timestamp: Math.floor(Math.max(now.getTime(), Date.now()) / 1000),
  });
  result.reported++;
}

interface BillingRun {
  db: Db;
  stripe: Stripe;
  storage: NonNullable<BillingConfig["storage"]>;
  now: Date;
  result: StorageBillingResult;
  /** Stripe is asked at most once per `STRIPE_REQUEST_INTERVAL_MS`: when it next may be. */
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
}): Effect.Effect<StorageBillingResult | null, JobError> {
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
    // One at a time, paced for Stripe; a workspace that fails never stops the rest.
    yield* Effect.forEach(
      workspaces,
      (workspace) =>
        billOne(run, workspace).pipe(
          // A bug for one workspace is that workspace's failure, as a thrown error was before.
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
  });
}

/** One workspace: its peak, then, when extra storage may be billed, its Stripe half. */
function billOne(
  run: BillingRun,
  workspace: StorageBilledWorkspace,
): Effect.Effect<void, JobError> {
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
    // A trial, a yearly plan and a workspace Stripe does not know are capped at the allowance:
    // nothing of theirs is billed, so Stripe is not asked.
    const { stripeCustomerId } = workspace;
    if (!stripeCustomerId || !billsOverage(workspace)) return;
    const wait = run.pace.next - Date.now();
    if (wait > 0) yield* Effect.sleep(wait);
    run.pace.next = Date.now() + STRIPE_REQUEST_INTERVAL_MS;
    // Safe to try again: it reads the subscription afresh, and the meter event's identifier
    // makes a repeated event one.
    yield* attempt("stripe", () =>
      billWorkspace(run, { ...workspace, stripeCustomerId }, { start, peakBytes }, result),
    ).pipe(within("stripe", STRIPE_TIME_LIMIT), retryTransient);
  });
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
