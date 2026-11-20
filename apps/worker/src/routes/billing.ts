import { createStripeClient, mayManageBilling, PLAN_NAME } from "@omni/auth";
import {
  claimTrial,
  createStripeSubscription,
  schema,
  trialUnavailable,
  workspaceKind,
  workspaceSubscription,
} from "@omni/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { subscriptionFields } from "../billing-reconcile.ts";
import { requireBilling, workspaceBilling } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";

const appPath = z
  .string()
  .regex(/^\/(?![/\\])[\w\-./]*$/, "use a path in the app, like /onboarding")
  .max(200);

const interval = z.enum(["month", "year"]).default("month");

const checkoutBody = z.object({
  interval,
  returnPath: appPath.default("/"),
});

const trialBody = z.object({ interval });

/**
 * The workspace's Stripe customer, made the way Better Auth's Stripe plugin makes one (same
 * metadata, so its checkout and portal find it), or the one it has. Stripe's idempotency key
 * makes a retried or double-clicked request create one customer.
 */
export async function workspaceCustomer(
  c: { var: AppEnv["Variables"] },
  stripe: ReturnType<typeof createStripeClient>,
) {
  const { db, member } = c.var;
  const [org] = await db
    .select({ name: schema.organizations.name, customer: schema.organizations.stripeCustomerId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, member.orgId));
  if (org?.customer) return org.customer;
  const customer = await stripe.customers.create(
    {
      name: org?.name,
      metadata: { organizationId: member.orgId, customerType: "organization" },
    },
    { idempotencyKey: `omni-workspace-customer-${member.orgId}` },
  );
  await db
    .update(schema.organizations)
    .set({ stripeCustomerId: customer.id })
    .where(
      and(eq(schema.organizations.id, member.orgId), isNull(schema.organizations.stripeCustomerId)),
    );
  const [saved] = await db
    .select({ customer: schema.organizations.stripeCustomerId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, member.orgId));
  return saved?.customer ?? customer.id;
}

const portalBody = z.object({ returnPath: appPath.default("/") });

function appUrl(c: { var: AppEnv["Variables"] }, path: string) {
  return new URL(path, c.var.config.auth.webAppURL).toString();
}

type PlanPrice = {
  amount: number;
  currency: string;
  name: string | null;
};

const priceCache = new Map<string, { price: PlanPrice | null; until: number }>();

const planPrice: (
  c: { var: AppEnv["Variables"] },
  secretKey: string,
  priceId: string | undefined,
) => Promise<PlanPrice | null> = async (c, secretKey, priceId) => {
  if (!priceId) return null;
  const cached = priceCache.get(priceId);
  if (cached && cached.until > Date.now()) return cached.price;
  try {
    const price = await createStripeClient(secretKey).prices.retrieve(priceId, {
      expand: ["product"],
    });
    const product =
      typeof price.product === "string" || price.product.deleted ? null : price.product;
    const value =
      price.unit_amount === null
        ? null
        : { amount: price.unit_amount, currency: price.currency, name: product?.name ?? null };
    priceCache.set(priceId, { price: value, until: Date.now() + 5 * 60_000 });
    return value;
  } catch (error) {
    c.var.log.warn("billing.price_unavailable", { priceId, error });
    return null;
  }
};

/**
 * Owners and admins only. A Personal space is free: it may never start a plan
 * (`subscribe`), and may manage one (`manage`: the portal, cards) only if it somehow has one,
 * so it can always be cancelled.
 */
export async function requireBillingManager(
  c: { var: AppEnv["Variables"] },
  purpose: "subscribe" | "manage" = "subscribe",
) {
  if ((await workspaceKind(c.var.db, c.var.member.orgId)) === "personal") {
    const existing =
      purpose === "manage" ? await workspaceSubscription(c.var.db, c.var.member.orgId) : null;
    if (!existing) {
      throw new HTTPException(403, { message: "a Personal space is free; it has no plan" });
    }
  }
  if (!(await mayManageBilling(c.var.db, c.var.user.id, c.var.member.orgId))) {
    throw new HTTPException(403, { message: "only owners and admins manage billing" });
  }
}

async function expireOtherCheckouts(
  c: { var: AppEnv["Variables"] },
  secretKey: string,
  keepId: string | null,
) {
  const [org] = await c.var.db
    .select({ customer: schema.organizations.stripeCustomerId })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, c.var.member.orgId));
  if (!org?.customer) return;
  const stripe = createStripeClient(secretKey);
  const open = await stripe.checkout.sessions.list({
    customer: org.customer,
    status: "open",
    limit: 100,
  });
  for (const other of open.data) {
    if (other.id === keepId || other.mode !== "subscription") continue;
    await stripe.checkout.sessions.expire(other.id).catch((error: unknown) => {
      c.var.log.warn("billing.checkout_expire_failed", { sessionId: other.id, error });
    });
  }
}

export const billing = new Hono<AppEnv>()
  .get("/billing", async (c) => {
    const state = await workspaceBilling(c.var.db, c.var.config, c.var.member.orgId);
    if (!state.enabled) return c.json({ enabled: false as const });
    const { subscription, readOnly, triage } = state;
    const plans = c.var.config.auth.billing!;
    const [month, year] = await Promise.all([
      planPrice(c, plans.secretKey, plans.monthlyPriceId),
      planPrice(c, plans.secretKey, plans.yearlyPriceId),
    ]);
    const amount = (price: PlanPrice | null) =>
      price && { amount: price.amount, currency: price.currency };
    return c.json({
      enabled: true as const,
      readOnly,
      canManage: await mayManageBilling(c.var.db, c.var.user.id, c.var.member.orgId),
      intervals: plans.yearlyPriceId ? (["month", "year"] as const) : (["month"] as const),
      planName: month?.name ?? year?.name ?? null,
      prices: { month: amount(month), year: amount(year) },
      trialDays: plans.trialDays,
      trialAvailable:
        plans.trialDays > 0 &&
        (await trialUnavailable(c.var.db, { orgId: c.var.member.orgId, userId: c.var.user.id })) ===
          null,
      subscription: subscription && {
        status: subscription.status,
        interval: subscription.billingInterval,
        periodEnd: subscription.periodEnd?.toISOString() ?? null,
        trialEnd: subscription.trialEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
      },
      triage: triage && {
        used: triage.used,
        allowance: triage.allowance,
        periodEnd: triage.periodEnd.toISOString(),
        pausedUntil: triage.paused ? triage.periodEnd.toISOString() : null,
      },
    });
  })

  .post("/billing/trial", zValidator("json", trialBody), async (c) => {
    const plans = requireBilling(c.var.config);
    await requireBillingManager(c);
    const { interval: chosen } = c.req.valid("json");
    const priceId = chosen === "year" ? plans.yearlyPriceId : plans.monthlyPriceId;
    if (!priceId) throw new HTTPException(400, { message: "yearly billing is not offered" });
    const { orgId } = c.var.member;
    const state = await workspaceBilling(c.var.db, c.var.config, orgId);
    if (state.enabled && !state.readOnly) return c.json({ started: false as const });
    if (plans.trialDays === 0) {
      throw new HTTPException(409, { message: "no free trial is offered" });
    }
    const who = { orgId, userId: c.var.user.id };
    const taken = (await trialUnavailable(c.var.db, who)) ?? (await claimTrial(c.var.db, who));
    if (taken === "workspace") {
      throw new HTTPException(409, { message: "this workspace has had its free trial" });
    }
    if (taken === "account") {
      throw new HTTPException(409, {
        message: "you have used your free trial on another workspace",
      });
    }
    const stripe = createStripeClient(plans.secretKey);
    const customer = await workspaceCustomer(c, stripe);
    const subscription = await stripe.subscriptions.create(
      {
        customer,
        items: [{ price: priceId }],
        trial_period_days: plans.trialDays,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { referenceId: orgId },
      },
      { idempotencyKey: `omni-workspace-trial-${orgId}-${chosen}` },
    );
    const fields = subscriptionFields(subscription, plans);
    if (fields) await createStripeSubscription(c.var.db, orgId, { ...fields, plan: PLAN_NAME });
    return c.json({ started: true as const });
  })

  .post("/billing/checkout", zValidator("json", checkoutBody), async (c) => {
    const plans = requireBilling(c.var.config);
    await requireBillingManager(c);
    const { interval, returnPath } = c.req.valid("json");
    if (interval === "year" && !plans.yearlyPriceId) {
      throw new HTTPException(400, { message: "yearly billing is not offered" });
    }
    const state = await workspaceBilling(c.var.db, c.var.config, c.var.member.orgId);
    if (state.enabled && !state.readOnly) {
      throw new HTTPException(409, {
        message: "already subscribed; manage the plan in the portal",
      });
    }
    const url = appUrl(c, returnPath);
    const session = await c.var.auth.api.upgradeSubscription({
      headers: c.req.raw.headers,
      body: {
        plan: PLAN_NAME,
        annual: interval === "year",
        customerType: "organization",
        referenceId: c.var.member.orgId,
        successUrl: url,
        cancelUrl: url,
        disableRedirect: true,
      },
    });
    if (!session.url) throw new HTTPException(502, { message: "Stripe returned no checkout URL" });
    await expireOtherCheckouts(c, plans.secretKey, "id" in session ? session.id : null);
    return c.json({ url: session.url });
  })

  .post("/billing/portal", zValidator("json", portalBody), async (c) => {
    requireBilling(c.var.config);
    await requireBillingManager(c, "manage");
    const portal = await c.var.auth.api.createBillingPortal({
      headers: c.req.raw.headers,
      body: {
        customerType: "organization",
        referenceId: c.var.member.orgId,
        returnUrl: appUrl(c, c.req.valid("json").returnPath),
        disableRedirect: true,
      },
    });
    return c.json({ url: portal.url });
  });
