import {
  createStripeClient,
  mayManageBilling,
  planOfPrice,
  planPriceIds,
  type BillingConfig,
} from "@omni/auth";
import {
  CAPS,
  PLAN_KEYS,
  PLAN_LIMITS,
  type Cap,
  type PlanKey,
  type PlanLimits,
} from "@omni/contracts";
import {
  applyStripeSubscription,
  capUsage,
  claimTrial,
  createStripeSubscription,
  isPaid,
  trialUnavailable,
  schema,
  subscriptionRowFor,
  type Db,
} from "@omni/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { z } from "zod";
import { subscriptionFields } from "../billing-reconcile.ts";
import { entitlements, monthUsage, requireBilling } from "../billing.ts";
import type { AppEnv } from "../context.ts";
import { zValidator } from "../validator.ts";

const appPath = z
  .string()
  .regex(/^\/(?![/\\])[\w\-./]*$/, "use a path in the app, like /onboarding")
  .max(200);

const interval = z.enum(["month", "year"]).default("month");

const paidPlan = z.enum(PLAN_KEYS).default("team");

const checkoutBody = z.object({
  plan: paidPlan,
  interval,
  returnPath: appPath.default("/"),
});

const planBody = z.object({ plan: paidPlan, interval });

const trialBody = z.object({ plan: paidPlan, interval });

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

/** Owners and admins only. */
export async function requireBillingManager(c: { var: AppEnv["Variables"] }) {
  if (!(await mayManageBilling(c.var.db, c.var.user.id, c.var.member.orgId))) {
    throw new HTTPException(403, { message: "only owners and admins manage billing" });
  }
}

function priceFor(billing: BillingConfig, plan: PlanKey, chosen: "month" | "year") {
  const prices = billing.plans[plan];
  if (!prices) throw new HTTPException(400, { message: `the ${plan} plan is not offered` });
  const id = chosen === "year" ? prices.yearlyPriceId : prices.monthlyPriceId;
  if (!id) throw new HTTPException(400, { message: `the ${plan} plan is not offered yearly` });
  return id;
}

async function capsHeld(db: Db, orgId: string) {
  const entries = await Promise.all(
    CAPS.map(async (cap) => [cap, await capUsage(db, orgId, cap)] as const),
  );
  return Object.fromEntries(entries) as Record<Cap, number>;
}

async function moveSubscription(
  stripe: Stripe,
  billing: BillingConfig,
  subscription: Stripe.Subscription,
  input: { priceId: string; up: boolean },
) {
  const planPrices = planPriceIds(billing.plans);
  const item = subscription.items.data.find((i) => planPrices.includes(i.price.id));
  if (!item) throw new HTTPException(409, { message: "this subscription is no plan's" });
  const toYear = planOfPrice(billing.plans, input.priceId)?.interval === "year";
  const extras = subscription.items.data.filter(
    (i) => i.id !== item.id && toYear && i.price.recurring?.usage_type === "metered",
  );
  for (const extra of extras) {
    await stripe.subscriptionItems.del(
      extra.id,
      { proration_behavior: "none" },
      { idempotencyKey: `omni-plan-yearly-item-del-${extra.id}` },
    );
  }
  return stripe.subscriptions.update(subscription.id, {
    items: [{ id: item.id, price: input.priceId }],
    proration_behavior: input.up ? "always_invoice" : "create_prorations",
    ...(input.up ? { payment_behavior: "pending_if_incomplete" as const } : {}),
  });
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

type LegacyTriage = {
  used: number;
  allowance: number;
  periodEnd: string;
  pausedUntil: string | null;
};

const amount = (price: PlanPrice | null) =>
  price && { amount: price.amount, currency: price.currency };

async function offeredPlans(c: { var: AppEnv["Variables"] }, billing: BillingConfig) {
  const offered = PLAN_KEYS.filter((key) => billing.plans[key]);
  return Promise.all(
    offered.map(async (key) => {
      const prices = billing.plans[key]!;
      const [month, year] = await Promise.all([
        planPrice(c, billing.secretKey, prices.monthlyPriceId),
        planPrice(c, billing.secretKey, prices.yearlyPriceId),
      ]);
      return {
        key,
        name: month?.name ?? year?.name ?? null,
        limits: PLAN_LIMITS[key] as PlanLimits,
        intervals: prices.yearlyPriceId ? (["month", "year"] as const) : (["month"] as const),
        prices: { month: amount(month), year: amount(year) },
      };
    }),
  );
}

type Planned = Extract<Awaited<ReturnType<typeof entitlements>>, { enabled: true }>;

function legacyTriage(plan: Planned, used: number | undefined) {
  const resets = plan.month?.end.toISOString();
  if (used === undefined || !resets) return null;
  const triage: LegacyTriage = {
    used,
    allowance: plan.limits.triage,
    periodEnd: resets,
    pausedUntil: used >= plan.limits.triage ? resets : null,
  };
  return triage;
}

async function billingState(c: { var: AppEnv["Variables"] }, plan: Planned) {
  const { db, config, member, user } = c.var;
  const billingConfig = config.auth.billing!;
  const [plans, held, used, canManage, trialBlocked] = await Promise.all([
    offeredPlans(c, billingConfig),
    capsHeld(db, member.orgId),
    plan.month ? monthUsage(db, member.orgId, plan.month.start) : null,
    mayManageBilling(db, user.id, member.orgId),
    trialUnavailable(db, { orgId: member.orgId, userId: user.id }),
  ]);
  const { subscription } = plan;
  const team = plans.find((p) => p.key === "team");
  return {
    enabled: true as const,
    plan: plan.plan,
    readOnly: plan.readOnly,
    limits: plan.limits,
    usage: { ...held, ...(used ?? { triage: 0, assist: 0, meetingMinutes: 0 }) },
    month: plan.month && {
      start: plan.month.start.toISOString(),
      end: plan.month.end.toISOString(),
    },
    plans,
    canManage,
    trialDays: billingConfig.trialDays,
    trialAvailable: billingConfig.trialDays > 0 && trialBlocked === null && plan.readOnly,
    subscription: subscription && {
      status: subscription.status,
      interval: subscription.billingInterval,
      periodEnd: subscription.periodEnd?.toISOString() ?? null,
      trialEnd: subscription.trialEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
    },
    intervals: team?.intervals ?? (["month"] as const),
    planName: team?.name ?? null,
    prices: team?.prices ?? { month: null, year: null },
    triage: legacyTriage(plan, used?.triage),
  };
}

export const billing = new Hono<AppEnv>()
  .get("/billing", async (c) => {
    const plan = await entitlements(c.var.db, c.var.config, c.var.member.orgId);
    if (!plan.enabled) return c.json({ enabled: false as const });
    return c.json(await billingState(c, plan));
  })

  .post("/billing/trial", zValidator("json", trialBody), async (c) => {
    const billingConfig = requireBilling(c.var.config);
    await requireBillingManager(c);
    const { plan, interval: chosen } = c.req.valid("json");
    const priceId = priceFor(billingConfig, plan, chosen);
    const { orgId } = c.var.member;
    const current = await entitlements(c.var.db, c.var.config, orgId);
    if (current.enabled && !current.readOnly) return c.json({ started: false as const });
    if (billingConfig.trialDays === 0) {
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
    const stripe = createStripeClient(billingConfig.secretKey);
    const customer = await workspaceCustomer(c, stripe);
    const subscription = await stripe.subscriptions.create(
      {
        customer,
        items: [{ price: priceId }],
        trial_period_days: billingConfig.trialDays,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { referenceId: orgId },
      },
      { idempotencyKey: `omni-workspace-trial-${orgId}-${plan}-${chosen}` },
    );
    const fields = subscriptionFields(subscription, billingConfig);
    if (fields) await createStripeSubscription(c.var.db, orgId, { ...fields, plan });
    return c.json({ started: true as const });
  })

  .post("/billing/checkout", zValidator("json", checkoutBody), async (c) => {
    const billingConfig = requireBilling(c.var.config);
    await requireBillingManager(c);
    const { plan, interval, returnPath } = c.req.valid("json");
    priceFor(billingConfig, plan, interval);
    const current = await entitlements(c.var.db, c.var.config, c.var.member.orgId);
    if (current.enabled && !current.readOnly) {
      throw new HTTPException(409, {
        message: "already on a plan; change it with POST /billing/plan",
      });
    }
    const url = appUrl(c, returnPath);
    const session = await c.var.auth.api.upgradeSubscription({
      headers: c.req.raw.headers,
      body: {
        plan,
        annual: interval === "year",
        customerType: "organization",
        referenceId: c.var.member.orgId,
        successUrl: url,
        cancelUrl: url,
        disableRedirect: true,
      },
    });
    if (!session.url) throw new HTTPException(502, { message: "Stripe returned no checkout URL" });
    await expireOtherCheckouts(c, billingConfig.secretKey, "id" in session ? session.id : null);
    return c.json({ url: session.url });
  })

  .post("/billing/plan", zValidator("json", planBody), async (c) => {
    const billingConfig = requireBilling(c.var.config);
    await requireBillingManager(c);
    const { db, config, member } = c.var;
    const { plan, interval: chosen } = c.req.valid("json");
    const priceId = priceFor(billingConfig, plan, chosen);
    const current = await entitlements(db, config, member.orgId);
    const stored = current.enabled ? current.subscription : null;
    if (!current.enabled || current.readOnly || !stored?.stripeSubscriptionId) {
      throw new HTTPException(409, { message: "no paid plan to change; start one at checkout" });
    }
    if (stored.stripeScheduleId) {
      throw new HTTPException(409, {
        message: "this plan has a scheduled change; manage it in the portal",
      });
    }
    const stripe = createStripeClient(billingConfig.secretKey);
    const subscription = await stripe.subscriptions.retrieve(stored.stripeSubscriptionId);
    if (!isPaid(subscription.status)) {
      throw new HTTPException(409, { message: "the plan is not in good standing" });
    }
    const now = subscription.items.data.find((i) =>
      planPriceIds(billingConfig.plans).includes(i.price.id),
    );
    if (now?.price.id === priceId) return c.json({ changed: false as const, plan });
    const from = now && planOfPrice(billingConfig.plans, now.price.id);
    const up =
      !from ||
      PLAN_KEYS.indexOf(plan) > PLAN_KEYS.indexOf(from.plan) ||
      (plan === from.plan && chosen === "year");
    const updated = await moveSubscription(stripe, billingConfig, subscription, { priceId, up });
    const pending = updated.pending_update !== null;
    const row = await subscriptionRowFor(db, updated.id);
    const fields = subscriptionFields(updated, billingConfig);
    if (row && fields && !pending) await applyStripeSubscription(db, row, fields);
    return c.json({ changed: !pending, pending, plan });
  })

  .post("/billing/portal", zValidator("json", portalBody), async (c) => {
    requireBilling(c.var.config);
    await requireBillingManager(c);
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
