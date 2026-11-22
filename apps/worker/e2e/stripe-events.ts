import { randomUUID } from "node:crypto";
import Stripe from "stripe";

export const BILLING_SECRETS = {
  STRIPE_SECRET_KEY: "sk_test_e2e_never_dialed",
  STRIPE_WEBHOOK_SECRET: "whsec_e2e_webhook_secret_e2e_webhook_secret",
};
export const MONTHLY_PRICE = "price_e2e_monthly";
export const YEARLY_PRICE = "price_e2e_yearly";
export const BUSINESS_MONTHLY_PRICE = "price_e2e_business_monthly";
export const BUSINESS_YEARLY_PRICE = "price_e2e_business_yearly";

/** The Worker vars that sell Team and Business at the prices above. */
export const PLAN_PRICES = {
  STRIPE_PRICE_MONTHLY: MONTHLY_PRICE,
  STRIPE_PRICE_YEARLY: YEARLY_PRICE,
  STRIPE_PRICE_BUSINESS_MONTHLY: BUSINESS_MONTHLY_PRICE,
  STRIPE_PRICE_BUSINESS_YEARLY: BUSINESS_YEARLY_PRICE,
};

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
  const interval =
    state.priceId === YEARLY_PRICE || state.priceId === BUSINESS_YEARLY_PRICE ? "year" : "month";
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
  } catch {}
  return { status: response.status, body };
}
