// The workspace's saved cards and invoices (ADR 0015, "Cards and invoices"), read from and
// changed in Stripe for the active workspace's own customer. Owners and admins only, like
// checkout and the portal; with billing off every route answers 404. Card numbers never reach
// Omni: a card is added by a SetupIntent the browser confirms with Stripe.js, and Omni sees only
// its brand, last four and expiry.
import { zValidator } from "@hono/zod-validator";
import { createStripeClient } from "@omni/auth";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { z } from "zod";
import { requireBilling } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { requireBillingManager, workspaceCustomer } from "./billing.ts";

type Ctx = { var: AppEnv["Variables"] };

/** Subscriptions that will still charge: anything not over. */
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

/** Stripe's own pages for an invoice; any other link Stripe hands back is dropped. */
const INVOICE_ORIGINS = new Set(["https://invoice.stripe.com", "https://pay.stripe.com"]);

const idOf = (value: string | { id: string } | null | undefined) =>
  value ? (typeof value === "string" ? value : value.id) : null;

async function storedCustomer(c: Ctx) {
  const [org] = await c.var.db
    .select({ customer: schema.organizations.stripeCustomerId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, c.var.member.orgId));
  return org?.customer ?? null;
}

/** Billing on and the caller an owner or admin, else 404 / 403 before any Stripe call. */
async function manage(c: Ctx) {
  const plans = requireBilling(c.var.config);
  await requireBillingManager(c);
  return { plans, stripe: createStripeClient(plans.secretKey) };
}

/**
 * The customer's cards, its live subscriptions, and the card Stripe charges next: a
 * subscription's own default wins over the customer's (Checkout sets one on the subscription).
 */
async function wallet(stripe: Stripe, customerId: string) {
  const [customer, methods, subscriptions] = await Promise.all([
    stripe.customers.retrieve(customerId),
    stripe.customers.listPaymentMethods(customerId, { type: "card", limit: 100 }),
    stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 }),
  ]);
  if (customer.deleted) return { cards: [], live: [], defaultId: null };
  const live = subscriptions.data.filter((s) => LIVE.has(s.status));
  const defaultId =
    idOf(live[0]?.default_payment_method) ??
    idOf(customer.invoice_settings?.default_payment_method);
  const cards = methods.data.flatMap((method) =>
    method.card && idOf(method.customer) === customerId
      ? [
          {
            id: method.id,
            brand: method.card.brand,
            last4: method.card.last4,
            expMonth: method.card.exp_month,
            expYear: method.card.exp_year,
            isDefault: method.id === defaultId,
          },
        ]
      : [],
  );
  return { cards, live, defaultId };
}

/** Charges `paymentMethodId` from now on: the customer's default and each live subscription's. */
async function makeDefault(
  stripe: Stripe,
  customerId: string,
  live: Stripe.Subscription[],
  paymentMethodId: string,
) {
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
  for (const subscription of live) {
    if (idOf(subscription.default_payment_method) === paymentMethodId) continue;
    await stripe.subscriptions.update(subscription.id, { default_payment_method: paymentMethodId });
  }
}

/** One of this customer's cards, or 404: another workspace's card, or one already removed. */
async function ownCard(stripe: Stripe, customerId: string | null, id: string) {
  const notFound = new HTTPException(404, { message: "that card is not saved for this workspace" });
  if (!customerId) throw notFound;
  const method = await stripe.paymentMethods.retrieve(id).catch((error: unknown) => {
    if ((error as { statusCode?: number }).statusCode === 404) throw notFound;
    throw error;
  });
  if (method.type !== "card" || idOf(method.customer) !== customerId) throw notFound;
  return method;
}

async function cardsOf(c: Ctx, stripe: Stripe, customerId: string | null) {
  const addCard = c.var.config.auth.billing?.publishableKey !== undefined;
  if (!customerId) return { cards: [], addCard };
  const { cards } = await wallet(stripe, customerId);
  // The card that will be charged leads; the rest keep Stripe's newest-first order.
  return { cards: cards.toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault)), addCard };
}

const paymentMethodId = z.object({ id: z.string().regex(/^pm_[A-Za-z0-9]+$/) });
const setupIntentBody = z.object({ setupIntent: z.string().regex(/^seti_[A-Za-z0-9]+$/) });

function approvedUrl(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return INVOICE_ORIGINS.has(url.origin) && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export const billingCards = new Hono<AppEnv>()
  /** The saved cards, default first, and whether a card can be added here (`addCard`). */
  .get("/billing/cards", async (c) => {
    const { stripe } = await manage(c);
    return c.json(await cardsOf(c, stripe, await storedCustomer(c)));
  })

  /**
   * A SetupIntent for one new card, for Stripe.js to confirm in the browser. Makes the
   * workspace's Stripe customer if it has none. 404 when no publishable key is configured.
   */
  .post("/billing/cards/setup", async (c) => {
    const { plans, stripe } = await manage(c);
    if (!plans.publishableKey) {
      throw new HTTPException(404, { message: "adding a card here is not configured" });
    }
    const customer = await workspaceCustomer(c, stripe);
    const intent = await stripe.setupIntents.create({
      customer,
      payment_method_types: ["card"],
      // Saved to pay the plan's renewals while nobody is there.
      usage: "off_session",
      metadata: { organizationId: c.var.member.orgId },
    });
    if (!intent.client_secret) throw new HTTPException(502, { message: "Stripe sent no secret" });
    return c.json({ clientSecret: intent.client_secret, publishableKey: plans.publishableKey });
  })

  /**
   * After Stripe.js confirmed the SetupIntent: the new card becomes the one charged when the
   * workspace has none yet (a trial started with no card would otherwise cancel at its end).
   * Safe to repeat.
   */
  .post("/billing/cards", zValidator("json", setupIntentBody), async (c) => {
    const { stripe } = await manage(c);
    const customer = await storedCustomer(c);
    const intent = await stripe.setupIntents
      .retrieve(c.req.valid("json").setupIntent)
      .catch(() => null);
    if (!intent || !customer || idOf(intent.customer) !== customer) {
      throw new HTTPException(404, { message: "no such card setup for this workspace" });
    }
    if (intent.status !== "succeeded") {
      throw new HTTPException(409, { message: "the card has not been confirmed with Stripe" });
    }
    const added = idOf(intent.payment_method);
    const { cards, live, defaultId } = await wallet(stripe, customer);
    if (added && cards.some((card) => card.id === added)) {
      if (!defaultId || !cards.some((card) => card.id === defaultId)) {
        await makeDefault(stripe, customer, live, added);
      }
    }
    return c.json(await cardsOf(c, stripe, customer));
  })

  /** Charges this card from now on: renewals of the plan and any open invoice's retries. */
  .post("/billing/cards/:id/default", zValidator("param", paymentMethodId), async (c) => {
    const { stripe } = await manage(c);
    const customer = await storedCustomer(c);
    const card = await ownCard(stripe, customer, c.req.valid("param").id);
    const { live } = await wallet(stripe, customer!);
    await makeDefault(stripe, customer!, live, card.id);
    return c.json(await cardsOf(c, stripe, customer));
  })

  /**
   * Removes a card from Stripe. The last card cannot go while a plan will still charge it (409):
   * add another first, or cancel the plan. Removing the card that is charged makes the newest
   * other card the one charged, because Stripe would otherwise charge nothing and the renewal
   * would fail.
   */
  .delete("/billing/cards/:id", zValidator("param", paymentMethodId), async (c) => {
    const { stripe } = await manage(c);
    const customer = await storedCustomer(c);
    const card = await ownCard(stripe, customer, c.req.valid("param").id);
    const { cards, live, defaultId } = await wallet(stripe, customer!);
    const others = cards.filter((other) => other.id !== card.id);
    const charging = live.some((s) => !s.cancel_at_period_end);
    if (others.length === 0 && charging) {
      throw new HTTPException(409, {
        message: "the plan needs a card: add another before removing this one",
      });
    }
    if (others[0] && (defaultId === card.id || !defaultId)) {
      await makeDefault(stripe, customer!, live, others[0].id);
    }
    await stripe.paymentMethods.detach(card.id);
    return c.json(await cardsOf(c, stripe, customer));
  })

  /** The workspace's invoices, newest first (drafts left out), with Stripe's page and PDF. */
  .get("/billing/invoices", async (c) => {
    const { stripe } = await manage(c);
    const customer = await storedCustomer(c);
    if (!customer) return c.json({ invoices: [] });
    const list = await stripe.invoices.list({ customer, limit: 24 });
    return c.json({
      invoices: list.data.flatMap((invoice) =>
        invoice.status === "draft" || !invoice.id
          ? []
          : [
              {
                id: invoice.id,
                number: invoice.number,
                createdAt: new Date(invoice.created * 1000).toISOString(),
                /** In the currency's smallest unit (cents). */
                total: invoice.total,
                currency: invoice.currency,
                status: invoice.status as "open" | "paid" | "uncollectible" | "void",
                url: approvedUrl(invoice.hosted_invoice_url),
                pdfUrl: approvedUrl(invoice.invoice_pdf),
              },
            ],
      ),
    });
  });
