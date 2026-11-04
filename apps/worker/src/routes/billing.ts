// The workspace's plan (ADR 0015): what it is, this month's AI triage against the allowance,
// and the two ways out to Stripe. Checkout and the portal go through Better Auth's Stripe plugin,
// always for the member's active workspace; its own /api/auth/subscription/* POSTs are closed.
import { zValidator } from "@hono/zod-validator";
import { createStripeClient, mayManageBilling, PLAN_NAME } from "@omni/auth";
import { schema } from "@omni/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireBilling, workspaceBilling } from "../billing.ts";
import type { AppEnv } from "../context.ts";

const checkoutBody = z.object({ interval: z.enum(["month", "year"]).default("month") });

function settingsUrl(c: { var: AppEnv["Variables"] }) {
  const base = c.var.config.auth.webAppURL;
  return new URL("/settings/billing", base).toString();
}

async function requireBillingManager(c: { var: AppEnv["Variables"] }) {
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
    return c.json({
      enabled: true as const,
      readOnly,
      canManage: await mayManageBilling(c.var.db, c.var.user.id, c.var.member.orgId),
      intervals: plans.yearlyPriceId ? (["month", "year"] as const) : (["month"] as const),
      trialDays: plans.trialDays,
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

  /** Starts Stripe Checkout for the one plan (with the trial, if the workspace never had one). */
  .post("/billing/checkout", zValidator("json", checkoutBody), async (c) => {
    const plans = requireBilling(c.var.config);
    await requireBillingManager(c);
    const { interval } = c.req.valid("json");
    if (interval === "year" && !plans.yearlyPriceId) {
      throw new HTTPException(400, { message: "yearly billing is not offered" });
    }
    const state = await workspaceBilling(c.var.db, c.var.config, c.var.member.orgId);
    if (state.enabled && !state.readOnly) {
      throw new HTTPException(409, {
        message: "already subscribed; manage the plan in the portal",
      });
    }
    const url = settingsUrl(c);
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
  .post("/billing/portal", async (c) => {
    requireBilling(c.var.config);
    await requireBillingManager(c);
    const portal = await c.var.auth.api.createBillingPortal({
      headers: c.req.raw.headers,
      body: {
        customerType: "organization",
        referenceId: c.var.member.orgId,
        returnUrl: settingsUrl(c),
        disableRedirect: true,
      },
    });
    return c.json({ url: portal.url });
  });
