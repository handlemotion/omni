// Stripe webhook events for the e2e suites, signed with Stripe's own library exactly as Stripe
// signs them, and posted to the real Worker. The payloads carry only the fields Stripe sends that
// the plugin reads; the live suite (`billing-stripe.e2e.test.ts`) covers events Stripe itself sent.
import { randomUUID } from "node:crypto";
import Stripe from "stripe";

export const BILLING_SECRETS = {
  // Never dialed by these suites: the events below need no Stripe API call.
  STRIPE_SECRET_KEY: "sk_test_e2e_never_dialed",
  STRIPE_WEBHOOK_SECRET: "whsec_e2e_webhook_secret_e2e_webhook_secret",
};
export const MONTHLY_PRICE = "price_e2e_monthly";
export const YEARLY_PRICE = "price_e2e_yearly";

const signer = new Stripe(BILLING_SECRETS.STRIPE_SECRET_KEY);
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export interface SubscriptionState {
  id: string;
  customer: string;
  status: Stripe.Subscription.Status;
  periodStart: Date;
  periodEnd: Date;
  priceId?: string;
  trialEnd?: Date;
  cancelAtPeriodEnd?: boolean;
}

export function subscriptionObject(state: SubscriptionState) {
  const interval = state.priceId === YEARLY_PRICE ? "year" : "month";
  return {
    id: state.id,
    object: "subscription",
    customer: state.customer,
    status: state.status,
    cancel_at_period_end: state.cancelAtPeriodEnd ?? false,
    cancel_at: null,
    canceled_at: state.status === "canceled" ? seconds(state.periodEnd) : null,
    ended_at: state.status === "canceled" ? seconds(state.periodEnd) : null,
    trial_start: state.trialEnd ? seconds(state.periodStart) : null,
    trial_end: state.trialEnd ? seconds(state.trialEnd) : null,
    schedule: null,
    metadata: {},
    items: {
      object: "list",
      data: [
        {
          id: `si_${randomUUID().slice(0, 8)}`,
          object: "subscription_item",
          quantity: 1,
          current_period_start: seconds(state.periodStart),
          current_period_end: seconds(state.periodEnd),
          price: {
            id: state.priceId ?? MONTHLY_PRICE,
            object: "price",
            lookup_key: null,
            recurring: { interval, interval_count: 1 },
          },
        },
      ],
    },
  };
}

export function stripeEvent(type: string, object: unknown, created: Date, id?: string) {
  return {
    id: id ?? `evt_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    api_version: "2026-10-28",
    type,
    created: seconds(created),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

/** Posts `event` to the Worker's webhook with a valid signature (or `signature` as given). */
export async function postStripeEvent(
  workerUrl: string | URL,
  event: unknown,
  options: { signature?: string; secret?: string } = {},
) {
  const payload = JSON.stringify(event);
  const signature =
    options.signature ??
    (await signer.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: options.secret ?? BILLING_SECRETS.STRIPE_WEBHOOK_SECRET,
    }));
  const response = await fetch(new URL("/api/auth/stripe/webhook", workerUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}
