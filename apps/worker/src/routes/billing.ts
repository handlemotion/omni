// The workspace's plan (ADR 0015): what it is, this month's AI triage against the allowance,
// and the two ways out to Stripe. Checkout and the portal go through Better Auth's Stripe plugin,
// always for the member's active workspace; its own /api/auth/subscription/* POSTs are closed.
import { zValidator } from "@hono/zod-validator";
import { createStripeClient, mayManageBilling, PLAN_NAME } from "@omni/auth";
import { claimTrial, createStripeSubscription, schema, trialUnavailable } from "@omni/db";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { subscriptionFields } from "../billing-reconcile.ts";
import { requireBilling, workspaceBilling } from "../billing.ts";
import type { AppEnv } from "../context.ts";

/** A path in the web app (`/onboarding`), never another origin (`//evil.example`). */
const appPath = z
  .string()
  .regex(/^\/(?![/\\])[\w\-./]*$/, "use a path in the app, like /onboarding")
  .max(200);

const interval = z.enum(["month", "year"]).default("month");

const checkoutBody = z.object({
  interval,
  /** Where Stripe sends the person back, paid or not. */
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
  /** The Stripe product's name: what customers call the plan. */
  name: string | null;
};

/**
 * The plan's prices as Stripe has them (amounts live only in Stripe, ADR 0015), so the app shows
 * what Checkout will charge. Cached per isolate for a few minutes: a price change shows up soon,
 * and the onboarding page costs no Stripe call each time.
 */
const priceCache = new Map<string, { price: PlanPrice | null; until: number }>();

async function planPrice(
  c: { var: AppEnv["Variables"] },
  secretKey: string,
  priceId: string | undefined,
): Promise<PlanPrice | null> {
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
    // Stripe down or the id wrong: the page offers the plan without its amount (Checkout still
    // shows it), rather than blocking setup.
    c.var.log.warn("billing.price_unavailable", { priceId, error });
    return null;
  }
}

export async function requireBillingManager(c: { var: AppEnv["Variables"] }) {
  if (!(await mayManageBilling(c.var.db, c.var.user.id, c.var.member.orgId))) {
    throw new HTTPException(403, { message: "only owners and admins manage billing" });
  }
}

/**
 * Only the newest Checkout stays open, so two tabs (or two admins) cannot both subscribe the
 * workspace. Expired after the new one exists, so a failure here never leaves no session; the
 * customer is the workspace's, created by its first checkout.
 */
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
      // Completed since it was listed: the webhook's duplicate check handles that one.
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
      /** The plan's name as customers see it: its Stripe product's name. */
      planName: month?.name ?? year?.name ?? null,
      /** In the currency's smallest unit (cents), as Stripe has them. */
      prices: { month: amount(month), year: amount(year) },
      trialDays: plans.trialDays,
      /**
       * This person can start a free trial here: one is configured, this workspace never had one,
       * and they never started one for another workspace. Otherwise the plan is paid on Checkout.
       */
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
        /** Set when the allowance is used up: new mail is not AI-triaged until then. */
        pausedUntil: triage.paused ? triage.periodEnd.toISOString() : null,
      },
    });
  })

  /**
   * Starts the workspace's one free trial (also the starter's one, across all their workspaces) on
   * the chosen interval, here and now: no card and no
   * Stripe page (a card is added before it ends, or it cancels, ADR 0015). The row is written at
   * once, so setup moves on; Stripe's webhook for it then finds it and changes nothing. Starting
   * it again, or with a plan already in good standing, changes nothing either.
   */
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
    // One trial per workspace and one per account, ever: a person's next workspace pays.
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

  /**
   * Starts Stripe Checkout for the one plan, for a workspace whose trial is over (or where none is
   * offered): paid up front. Promotion codes go in on Stripe's page.
   */
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
    // The plugin answers with a portal link instead when Stripe already has the subscription.
    await expireOtherCheckouts(c, plans.secretKey, "id" in session ? session.id : null);
    return c.json({ url: session.url });
  })

  /** Opens the Stripe customer portal: payment method, interval, invoices, cancel. */
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
