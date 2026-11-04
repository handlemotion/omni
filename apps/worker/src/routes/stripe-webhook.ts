// Stripe's webhook (ADR 0015), in front of Better Auth's Stripe plugin. Verifies Stripe's
// signature, then applies each event at most once and never an older one over a newer: the
// plugin writes each event's snapshot as-is, so a replayed or late event would roll state back.
// The plugin answers 200 even when its write failed (it logs and swallows the error), so an event
// counts as applied only once its effect is in the database; otherwise Stripe is told to retry.
import { createStripeClient, type BillingConfig } from "@omni/auth";
import {
  recordStripeEvent,
  schema,
  storedSubscriptions,
  stripeEventDisposition,
  type Db,
  type StripeEventRef,
} from "@omni/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import Stripe from "stripe";
import type { AppEnv } from "../context.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

type StripeObject = Record<string, unknown>;

/** The workspace an event is about, from the metadata the plugin puts on checkout and subscriptions. */
function referencedOrg(object: StripeObject) {
  const metadata = object.metadata as Record<string, string> | null | undefined;
  const reference =
    (object.client_reference_id as string | null | undefined) ?? metadata?.referenceId;
  return typeof reference === "string" && reference ? reference : null;
}

/**
 * What the plugin should leave in `subscriptions` once it handles `event`: a row with this Stripe
 * subscription id (and status), or nothing, with the reason it ignores the event. Mirrors the
 * lookups the plugin makes, so an event it is meant to ignore is never retried forever. Runs
 * before the plugin, which changes what those lookups see.
 */
async function expectedEffect(
  db: Db,
  billing: BillingConfig,
  event: Stripe.Event,
): Promise<{ stripeSubscriptionId: string; status?: string } | { ignored: string }> {
  const object = event.data.object as unknown as StripeObject;
  const metadata = (object.metadata ?? {}) as Record<string, string | undefined>;
  const ourId = metadata.subscriptionId;

  if (event.type === "checkout.session.completed") {
    if (object.mode !== "subscription" || typeof object.subscription !== "string") {
      return { ignored: "not a subscription checkout" };
    }
    // The plugin only completes a checkout it started, by updating the row it created for it.
    if (!referencedOrg(object) || !ourId) return { ignored: "checkout not started by Omni" };
    if (!(await storedSubscriptions(db, { id: ourId })).length) {
      return { ignored: "no pending subscription for the checkout" };
    }
    return { stripeSubscriptionId: object.subscription };
  }

  const kind = event.type.replace("customer.subscription.", "");
  if (!["created", "updated", "deleted"].includes(kind) || typeof object.id !== "string") {
    return { ignored: "not an event the plugin handles" };
  }
  const id = object.id;
  const customer = typeof object.customer === "string" ? object.customer : null;
  const items = (object.items as { data?: { price?: { id?: string } }[] } | undefined)?.data ?? [];
  const prices = [billing.monthlyPriceId, billing.yearlyPriceId].filter(Boolean);
  const matchesPlan = items.some((item) => prices.includes(item.price?.id ?? ""));
  const [org] = customer
    ? await db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.stripeCustomerId, customer))
    : [];
  // A subscription Omni would have stored when it was created; if the row is missing, the
  // `created` event has not landed yet (Stripe does not deliver in order), so retry.
  const belongsHere = org !== undefined && matchesPlan;
  const byOurId = async () =>
    storedSubscriptions(db, ourId ? { id: ourId } : { stripeSubscriptionId: id });
  const status = kind === "deleted" ? "canceled" : String(object.status);

  if (kind === "created") {
    if (!customer) return { ignored: "subscription without a customer" };
    if ((await byOurId()).length) return { ignored: "subscription already stored" };
    if (!org) return { ignored: "customer maps to no workspace" };
    if (!matchesPlan) return { ignored: "price matches no plan" };
    return { stripeSubscriptionId: id, status };
  }
  if (kind === "updated") {
    // The plugin needs one item: one matching a plan, or the only one.
    if (!matchesPlan && items.length !== 1) return { ignored: "price matches no plan" };
    if ((await byOurId()).length) return { stripeSubscriptionId: id, status };
    const ofCustomer = customer
      ? await storedSubscriptions(db, { stripeCustomerId: customer })
      : [];
    if (
      ofCustomer.length > 1 &&
      !ofCustomer.some((s) => ["active", "trialing"].includes(s.status))
    ) {
      return { ignored: "several subscriptions for the customer, none active" };
    }
    if (ofCustomer.length || belongsHere) return { stripeSubscriptionId: id, status };
    return { ignored: "subscription Omni does not hold" };
  }
  if ((await storedSubscriptions(db, { stripeSubscriptionId: id })).length || belongsHere) {
    return { stripeSubscriptionId: id, status };
  }
  return { ignored: "subscription Omni does not hold" };
}

export const stripeWebhook = new Hono<AppEnv>().post("/", async (c) => {
  const billing = c.var.config.auth.billing;
  if (!billing) return c.json({ error: "billing is not enabled" }, 404);
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "missing Stripe signature" }, 400);
  const payload = await c.req.text();

  let event: Stripe.Event;
  try {
    event = await createStripeClient(billing.secretKey).webhooks.constructEventAsync(
      payload,
      signature,
      billing.webhookSecret,
      undefined,
      cryptoProvider,
    );
  } catch {
    return c.json({ error: "invalid Stripe signature" }, 400);
  }

  const object = event.data.object as unknown as StripeObject;
  const orgId = referencedOrg(object);
  const [org] = orgId
    ? await c.var.db
        .select({ id: schema.organizations.id })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
    : [];
  const ref: StripeEventRef = {
    id: event.id,
    type: event.type,
    objectId: typeof object.id === "string" ? object.id : null,
    orgId: org?.id ?? null,
    createdAt: new Date(event.created * 1000),
  };
  const disposition = await stripeEventDisposition(c.var.db, ref);
  if (disposition !== "new") {
    // Stale events are recorded too, so a replay of one is a plain duplicate.
    await recordStripeEvent(c.var.db, ref);
    c.var.log.info("stripe.event_skipped", { eventId: event.id, type: event.type, disposition });
    return c.json({ received: true, applied: false, reason: disposition });
  }

  const expected = await expectedEffect(c.var.db, billing, event);
  const response = await c.var.auth.handler(
    new Request(c.req.raw.url, { method: "POST", headers: c.req.raw.headers, body: payload }),
  );
  const fields = { eventId: event.id, type: event.type, status: response.status, orgId: ref.orgId };
  // A non-2xx makes Stripe retry, so only a handled event is marked applied.
  if (!response.ok) {
    c.var.log.info("stripe.event", fields);
    return response;
  }
  if ("ignored" in expected) {
    c.var.log.info("stripe.event_ignored", { ...fields, reason: expected.ignored });
  } else {
    const rows = await storedSubscriptions(c.var.db, {
      stripeSubscriptionId: expected.stripeSubscriptionId,
    });
    if (!rows.some((row) => !expected.status || row.status === expected.status)) {
      c.var.log.error("stripe.event_not_applied", { ...fields, expected });
      return c.json({ error: "event not applied; retry" }, 500);
    }
  }
  await recordStripeEvent(c.var.db, ref);
  c.var.log.info("stripe.event", fields);
  return c.json({ received: true, applied: true });
});
