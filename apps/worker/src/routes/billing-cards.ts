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
import { zValidator } from "../validator.ts";

type Ctx = { var: AppEnv["Variables"] };

const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

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

async function manage(c: Ctx) {
  const plans = requireBilling(c.var.config);
  await requireBillingManager(c, "manage");
  return { plans, stripe: createStripeClient(plans.secretKey) };
}

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
  .get("/billing/cards", async (c) => {
    const { stripe } = await manage(c);
    return c.json(await cardsOf(c, stripe, await storedCustomer(c)));
  })

  .post("/billing/cards/setup", async (c) => {
    const { plans, stripe } = await manage(c);
    if (!plans.publishableKey) {
      throw new HTTPException(404, { message: "adding a card here is not configured" });
    }
    const customer = await workspaceCustomer(c, stripe);
    const intent = await stripe.setupIntents.create({
      customer,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: { organizationId: c.var.member.orgId },
    });
    if (!intent.client_secret) throw new HTTPException(502, { message: "Stripe sent no secret" });
    return c.json({ clientSecret: intent.client_secret, publishableKey: plans.publishableKey });
  })

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

  .post("/billing/cards/:id/default", zValidator("param", paymentMethodId), async (c) => {
    const { stripe } = await manage(c);
    const customer = await storedCustomer(c);
    const card = await ownCard(stripe, customer, c.req.valid("param").id);
    const { live } = await wallet(stripe, customer!);
    await makeDefault(stripe, customer!, live, card.id);
    return c.json(await cardsOf(c, stripe, customer));
  })

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
