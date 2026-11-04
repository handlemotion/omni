// The workspace's plan (ADR 0014): what it is, this month's AI triage against the allowance,
// and the two ways out to Stripe. Checkout and the portal go through Better Auth's Stripe plugin,
// always for the member's active workspace; its own /api/auth/subscription/* POSTs are closed.
import { zValidator } from "@hono/zod-validator";
import { mayManageBilling, PLAN_NAME } from "@omni/auth";
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
