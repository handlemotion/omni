// One paid subscription per workspace (ADR 0015). Checkout expires a workspace's other open
// sessions, but two can still both complete (a session paid while the next one is created), and
// Stripe would then bill the workspace's customer twice. After each subscription event this
// keeps the oldest paid subscription in Stripe and cancels the rest, without refunding.
import type { Db } from "@omni/db";
import { isPaid, PAID_STATUSES, schema } from "@omni/db";
import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";

/** Where a canceled duplicate is reported: error level, so a person refunds it. */
export type BillingLog = (event: string, fields: Record<string, unknown>) => void;

// oxlint-disable-next-line no-console -- default sink when the host passes no logger
const consoleLog: BillingLog = (event, fields) =>
  console.error(JSON.stringify({ level: "error", event, ...fields }));

const CHECKED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
]);

function customerOf(object: Record<string, unknown>) {
  const customer = object.customer as string | { id: string } | null | undefined;
  return typeof customer === "string" ? customer : (customer?.id ?? null);
}

/**
 * Runs after the plugin applied `event`. Stripe is the authority, but it is asked only when a
 * duplicate is possible: after a completed Checkout (the plugin points the workspace's one local
 * row at whichever session completed last, hiding the first), or when the workspace's own rows
 * show more than one paid subscription. Idempotent: the survivor is chosen from Stripe's current
 * state, so a replayed event finds nothing left to cancel.
 */
export async function cancelDuplicateSubscriptions(
  stripe: Stripe,
  db: Db,
  event: Stripe.Event,
  log: BillingLog = consoleLog,
) {
  if (!CHECKED_EVENTS.has(event.type)) return;
  const object = event.data.object as unknown as Record<string, unknown>;
  if (event.type === "checkout.session.completed" && object.mode !== "subscription") return;
  const customerId = customerOf(object);
  if (!customerId) return;
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.stripeCustomerId, customerId));
  if (!org) return;

  if (event.type !== "checkout.session.completed") {
    const paidRows = await db
      .selectDistinct({ id: schema.subscriptions.stripeSubscriptionId })
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.orgId, org.id),
          inArray(schema.subscriptions.status, [...PAID_STATUSES]),
        ),
      );
    if (paidRows.length < 2) return;
  }

  const listed = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
  });
  const [kept, ...duplicates] = listed.data
    .filter((subscription) => isPaid(subscription.status))
    .toSorted((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  if (!kept) return;
  for (const duplicate of duplicates) {
    // Touch the survivor first: its `customer.subscription.updated` re-points the plugin's row
    // at it if a completed Checkout had pointed that row at the duplicate.
    await stripe.subscriptions.update(kept.id, {
      metadata: { omniCanceledDuplicate: duplicate.id },
    });
    await stripe.subscriptions.cancel(
      duplicate.id,
      {},
      {
        idempotencyKey: `omni-cancel-duplicate-${duplicate.id}`,
      },
    );
    log("billing.duplicate_subscription_canceled", {
      orgId: org.id,
      customerId,
      keptSubscriptionId: kept.id,
      canceledSubscriptionId: duplicate.id,
      canceledStatus: duplicate.status,
      // What a person refunds, if it was paid.
      latestInvoiceId:
        typeof duplicate.latest_invoice === "string"
          ? duplicate.latest_invoice
          : (duplicate.latest_invoice?.id ?? null),
      eventId: event.id,
    });
  }
}
