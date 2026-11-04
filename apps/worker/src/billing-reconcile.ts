// The daily billing reconcile (ADR 0015). Subscription state arrives through Stripe's webhook,
// and a missed or failed event leaves a workspace wrong until the next one: a paying workspace
// read-only, or a canceled one writable. Once a day this reads every workspace's subscriptions
// back from Stripe, the source of truth, and writes what the plugin's handlers would have
// written. It only converges: running it twice changes nothing the second time.
import { PLAN_NAME, type BillingConfig } from "@omni/auth";
import {
  applyStripeSubscription,
  billedWorkspaces,
  createStripeSubscription,
  isSettled,
  subscriptionRows,
  type Db,
  type StripeSubscriptionFields,
} from "@omni/db";
import type Stripe from "stripe";
import type { Logger } from "./log.ts";

/** Stripe allows about 25 requests a second in test mode (100 live); stay well under. */
const STRIPE_REQUEST_INTERVAL_MS = 100;

export interface ReconcileResult {
  /** Stripe subscriptions compared with their row. */
  checked: number;
  /** Rows updated (or linked to their Stripe subscription) because they had drifted. */
  changed: number;
  /** Rows created for Stripe subscriptions Omni never heard of. */
  created: number;
  /** Workspaces or subscriptions that could not be read or written; the next run retries. */
  errors: number;
}

export async function reconcileSubscriptions(input: {
  db: Db;
  stripe: Stripe;
  billing: BillingConfig;
  log: Logger;
}): Promise<ReconcileResult> {
  const { db, stripe, billing, log } = input;
  const result: ReconcileResult = { checked: 0, changed: 0, created: 0, errors: 0 };
  const pace = pacer(STRIPE_REQUEST_INTERVAL_MS);
  const rows = await subscriptionRows(db);
  const byStripeId = new Map(
    rows.flatMap((r) => (r.stripeSubscriptionId ? [[r.stripeSubscriptionId, r]] : [])),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<string>();

  const apply = async (orgId: string | null, subscription: Stripe.Subscription) => {
    seen.add(subscription.id);
    const row = byStripeId.get(subscription.id) ?? checkoutRow(subscription, orgId);
    if (row && isSettled(row)) return;
    const fields = subscriptionFields(subscription, billing);
    if (!fields) return; // not this plan's subscription
    result.checked++;
    if (row) {
      byId.delete(row.id); // linked now: a second subscription naming it gets its own row
      if (await applyStripeSubscription(db, row, fields)) result.changed++;
    } else if (orgId && fields.plan) {
      if (await createStripeSubscription(db, orgId, { ...fields, plan: fields.plan })) {
        result.created++;
      }
    }
  };

  /**
   * The row checkout created for this subscription, before Stripe knew its id: the plugin puts
   * that row's id in the subscription's metadata and fills in the Stripe id on
   * `checkout.session.completed`. Linking it, rather than creating a second row, is what that
   * event would have done.
   */
  const checkoutRow = (subscription: Stripe.Subscription, orgId: string | null) => {
    const row = byId.get(subscription.metadata?.subscriptionId ?? "");
    return row && row.orgId === orgId && !row.stripeSubscriptionId ? row : undefined;
  };

  // Every workspace customer's subscriptions: finds the ones Omni has no row for.
  for (const workspace of await billedWorkspaces(db)) {
    try {
      for (let after: string | undefined; ;) {
        await pace();
        const page = await stripe.subscriptions.list({
          customer: workspace.stripeCustomerId,
          status: "all",
          limit: 100,
          starting_after: after,
        });
        for (const subscription of page.data) await apply(workspace.orgId, subscription);
        after = page.data.at(-1)?.id;
        if (!page.has_more || !after) break;
      }
    } catch (error) {
      result.errors++;
      log.warn("billing.reconcile.workspace_failed", { orgId: workspace.orgId, error });
    }
  }

  // Rows whose subscription the listing did not cover (another customer, or a failed listing).
  for (const row of rows) {
    const id = row.stripeSubscriptionId;
    if (!id || seen.has(id) || isSettled(row)) continue;
    try {
      await pace();
      await apply(null, await stripe.subscriptions.retrieve(id));
    } catch (error) {
      result.errors++;
      log.warn("billing.reconcile.subscription_failed", {
        orgId: row.orgId,
        subscriptionId: row.id,
        error,
      });
    }
  }

  return result;
}

/**
 * What the plugin's `customer.subscription.updated` handler writes from `subscription`, or null
 * when the subscription is not this plan's (a multi-item subscription with none of its prices).
 */
export function subscriptionFields(
  subscription: Stripe.Subscription,
  billing: BillingConfig,
): StripeSubscriptionFields | null {
  const prices = [billing.monthlyPriceId, billing.yearlyPriceId].filter(Boolean);
  const items = subscription.items.data;
  const matched = items.find((item) => prices.includes(item.price.id));
  const item = matched ?? (items.length === 1 ? items[0] : undefined);
  if (!item) return null;
  return {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: idOf(subscription.customer),
    status: subscription.status,
    periodStart: fromSeconds(item.current_period_start),
    periodEnd: fromSeconds(item.current_period_end),
    ...(subscription.trial_start && subscription.trial_end
      ? {
          trialStart: fromSeconds(subscription.trial_start),
          trialEnd: fromSeconds(subscription.trial_end),
        }
      : {}),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelAt: maybeDate(subscription.cancel_at),
    canceledAt: maybeDate(subscription.canceled_at),
    endedAt: maybeDate(subscription.ended_at),
    seats: item.quantity ?? 1,
    billingInterval: item.price.recurring?.interval ?? null,
    stripeScheduleId: subscription.schedule ? idOf(subscription.schedule) : null,
    ...(matched ? { plan: PLAN_NAME } : {}),
  };
}

const fromSeconds = (seconds: number) => new Date(seconds * 1000);
const maybeDate = (seconds: number | null) => (seconds ? fromSeconds(seconds) : null);
/** Stripe sends a related object as its id, or expanded. */
const idOf = (ref: string | { id: string }) => (typeof ref === "string" ? ref : ref.id);

/** Resolves no sooner than `intervalMs` after the previous call resolved. */
function pacer(intervalMs: number) {
  let next = 0;
  return async () => {
    const wait = next - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    next = Date.now() + intervalMs;
  };
}
