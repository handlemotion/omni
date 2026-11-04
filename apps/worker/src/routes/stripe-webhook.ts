// Stripe's webhook (ADR 0014), in front of Better Auth's Stripe plugin. Verifies Stripe's
// signature, then applies each event at most once and never an older one over a newer: the
// plugin writes each event's snapshot as-is, so a replayed or late event would roll state back.
import { createStripeClient } from "@omni/auth";
import { recordStripeEvent, schema, stripeEventDisposition, type StripeEventRef } from "@omni/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import Stripe from "stripe";
import type { AppEnv } from "../context.ts";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

/** The workspace an event is about, from the metadata the plugin puts on checkout and subscriptions. */
function referencedOrg(object: Record<string, unknown>) {
  const metadata = object.metadata as Record<string, string> | null | undefined;
  const reference =
    (object.client_reference_id as string | null | undefined) ?? metadata?.referenceId;
  return typeof reference === "string" && reference ? reference : null;
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

  const object = event.data.object as unknown as Record<string, unknown>;
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

  const response = await c.var.auth.handler(
    new Request(c.req.raw.url, { method: "POST", headers: c.req.raw.headers, body: payload }),
  );
  // A non-2xx makes Stripe retry, so only a handled event is marked applied.
  if (response.ok) await recordStripeEvent(c.var.db, ref);
  c.var.log.info("stripe.event", {
    eventId: event.id,
    type: event.type,
    status: response.status,
    orgId: ref.orgId,
  });
  return response.ok ? c.json({ received: true, applied: true }) : response;
});
