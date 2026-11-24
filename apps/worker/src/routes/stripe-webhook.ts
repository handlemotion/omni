import { createStripeClient, planPriceIds, type BillingConfig } from "@omni/auth";
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
import { apiError } from "../errors.ts";
import { modules } from "../modules.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

type StripeObject = Record<string, unknown>;

function referencedOrg(object: StripeObject) {
  const metadata = object.metadata as Record<string, string> | null | undefined;
  const reference =
    (object.client_reference_id as string | null | undefined) ?? metadata?.referenceId;
  return typeof reference === "string" && reference ? reference : null;
}

type Effect = { stripeSubscriptionId: string; status?: string } | { ignored: string };

async function checkoutEffect(db: Db, object: StripeObject, ourId: string | undefined) {
  if (object.mode !== "subscription" || typeof object.subscription !== "string") {
    return { ignored: "not a subscription checkout" } satisfies Effect;
  }
  if (!referencedOrg(object) || !ourId) return { ignored: "checkout not started by Wok" };
  if (!(await storedSubscriptions(db, { id: ourId })).length) {
    return { ignored: "no pending subscription for the checkout" };
  }
  return { stripeSubscriptionId: object.subscription } satisfies Effect;
}

interface SubscriptionEvent {
  db: Db;
  id: string;
  customer: string | null;
  status: string;
  matchesPlan: boolean;
  itemCount: number;
  belongsHere: boolean;
  orgFound: boolean;
  storedByOurId: () => Promise<unknown[]>;
}

const createdEffect: (event: SubscriptionEvent) => Promise<Effect> = async (event) => {
  if (!event.customer) return { ignored: "subscription without a customer" };
  if ((await event.storedByOurId()).length) return { ignored: "subscription already stored" };
  if (!event.orgFound) return { ignored: "customer maps to no workspace" };
  if (!event.matchesPlan) return { ignored: "price matches no plan" };
  return { stripeSubscriptionId: event.id, status: event.status };
};

const updatedEffect: (event: SubscriptionEvent) => Promise<Effect> = async (event) => {
  const { db, id, customer, status } = event;
  if (!event.matchesPlan && event.itemCount !== 1) return { ignored: "price matches no plan" };
  if ((await event.storedByOurId()).length) return { stripeSubscriptionId: id, status };
  const ofCustomer = customer ? await storedSubscriptions(db, { stripeCustomerId: customer }) : [];
  if (ofCustomer.length > 1 && !ofCustomer.some((s) => ["active", "trialing"].includes(s.status))) {
    return { ignored: "several subscriptions for the customer, none active" };
  }
  if (ofCustomer.length || event.belongsHere) return { stripeSubscriptionId: id, status };
  return { ignored: "subscription Wok does not hold" };
};

const deletedEffect: (event: SubscriptionEvent) => Promise<Effect> = async (event) => {
  const { db, id, status } = event;
  if ((await storedSubscriptions(db, { stripeSubscriptionId: id })).length || event.belongsHere) {
    return { stripeSubscriptionId: id, status };
  }
  return { ignored: "subscription Wok does not hold" };
};

const subscriptionEffects = {
  created: createdEffect,
  updated: updatedEffect,
  deleted: deletedEffect,
};

async function orgOfCustomer(db: Db, customer: string | null) {
  if (!customer) return undefined;
  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.stripeCustomerId, customer));
  return org;
}

async function subscriptionEffect(
  db: Db,
  billing: BillingConfig,
  kind: keyof typeof subscriptionEffects,
  object: StripeObject & { id: string },
  ourId: string | undefined,
) {
  const { id } = object;
  const customer = typeof object.customer === "string" ? object.customer : null;
  const items = (object.items as { data?: { price?: { id?: string } }[] } | undefined)?.data ?? [];
  const prices = planPriceIds(billing.plans);
  const matchesPlan = items.some((item) => prices.includes(item.price?.id ?? ""));
  const org = await orgOfCustomer(db, customer);
  return subscriptionEffects[kind]({
    db,
    id,
    customer,
    status: kind === "deleted" ? "canceled" : String(object.status),
    matchesPlan,
    itemCount: items.length,
    belongsHere: org !== undefined && matchesPlan,
    orgFound: org !== undefined,
    storedByOurId: () =>
      storedSubscriptions(db, ourId ? { id: ourId } : { stripeSubscriptionId: id }),
  });
}

function isSubscriptionKind(kind: string): kind is keyof typeof subscriptionEffects {
  return Object.hasOwn(subscriptionEffects, kind);
}

const expectedEffect: (
  db: Db,
  billing: BillingConfig,
  event: Stripe.Event,
) => Promise<Effect> = async (db, billing, event) => {
  const object = event.data.object as unknown as StripeObject;
  const metadata = (object.metadata ?? {}) as Record<string, string | undefined>;
  const ourId = metadata.subscriptionId;
  if (event.type === "checkout.session.completed") return checkoutEffect(db, object, ourId);
  const kind = event.type.replace("customer.subscription.", "");
  if (!isSubscriptionKind(kind) || typeof object.id !== "string") {
    return { ignored: "not an event the plugin handles" };
  }
  return subscriptionEffect(db, billing, kind, { ...object, id: object.id }, ourId);
};

export const stripeWebhook = new Hono<AppEnv>().post("/", async (c) => {
  const billing = c.var.config.auth.billing;
  if (!billing) return apiError(c, "not_found", "billing is not enabled");
  const signature = c.req.header("stripe-signature");
  if (!signature) return apiError(c, "bad_request", "missing Stripe signature");
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
    return apiError(c, "bad_request", "invalid Stripe signature");
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
    await recordStripeEvent(c.var.db, ref);
    c.var.log.info("stripe.event_skipped", { eventId: event.id, type: event.type, disposition });
    return c.json({ received: true, applied: false, reason: disposition });
  }

  const expected = await expectedEffect(c.var.db, billing, event);
  const response = await c.var.auth.handler(
    new Request(c.req.raw.url, { method: "POST", headers: c.req.raw.headers, body: payload }),
  );
  const fields = { eventId: event.id, type: event.type, status: response.status, orgId: ref.orgId };
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
      return apiError(c, "internal_server_error", "event not applied; retry");
    }
  }
  for (const module of modules) await module.stripeEvent?.(c.var.db, billing, event);
  await recordStripeEvent(c.var.db, ref);
  c.var.log.info("stripe.event", fields);
  return c.json({ received: true, applied: true });
});
