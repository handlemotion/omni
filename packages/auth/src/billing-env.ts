import type { PaidPlanKey } from "@omni/contracts";
import { z } from "zod";

export const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/**
 * Billing: a Free plan, then flat plans per workspace (Team, Business), never per member. What
 * each plan allows is `PLAN_LIMITS` in `@omni/contracts`; amounts live in Stripe as prices, and
 * only their ids are config. All of it is optional: with no `STRIPE_SECRET_KEY` there is no
 * Stripe plugin, no plan and no limit.
 */
export const billingFields = {
  /** `off` turns billing off even with the Stripe settings below in place. */
  BILLING: optionalText.pipe(z.enum(["off"]).optional()),
  STRIPE_SECRET_KEY: optionalText,
  STRIPE_WEBHOOK_SECRET: optionalText,
  /** Team's monthly price. (The name is the one plan's from before there were tiers.) */
  STRIPE_PRICE_MONTHLY: optionalText,
  /** Team's optional yearly price. Empty offers Team monthly only. */
  STRIPE_PRICE_YEARLY: optionalText,
  /** Business's monthly price. Empty: Business is not offered. */
  STRIPE_PRICE_BUSINESS_MONTHLY: optionalText,
  /** Business's optional yearly price. */
  STRIPE_PRICE_BUSINESS_YEARLY: optionalText,
  /**
   * Optional publishable key (`pk_test_…` / `pk_live_…`), public by design: Stripe.js in the
   * browser needs it to take a card for the workspace. Empty: cards can be listed, made default
   * and removed in the app, but a new one is added in Stripe's customer portal.
   */
  STRIPE_PUBLISHABLE_KEY: optionalText.pipe(
    z
      .string()
      .regex(
        /^pk_(test|live)_[A-Za-z0-9]+$/,
        "use a Stripe publishable key (pk_test_… or pk_live_…)",
      )
      .optional(),
  ),
  /**
   * Extra storage past a paid plan's: the metered price extra GB are billed at, and the event
   * name of the Stripe meter behind it. Both or none; with none, a plan's storage is a hard cap.
   */
  STRIPE_PRICE_STORAGE: optionalText,
  STRIPE_STORAGE_METER_EVENT: optionalText.pipe(z.string().max(100).optional()),
};

const STORAGE_BILLING = ["STRIPE_PRICE_STORAGE", "STRIPE_STORAGE_METER_EVENT"] as const;

const billingEnvSchema = z.object(billingFields);
type BillingEnv = z.output<typeof billingEnvSchema>;

/** Half a billing setup is a mistake, not "billing off": names what is missing or mismatched. */
export function checkBillingEnv(env: BillingEnv, ctx: z.RefinementCtx) {
  if (env.BILLING === "off") return;
  if (!env.STRIPE_SECRET_KEY) {
    const stray = [
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_MONTHLY",
      "STRIPE_PRICE_YEARLY",
      "STRIPE_PRICE_BUSINESS_MONTHLY",
      "STRIPE_PRICE_BUSINESS_YEARLY",
      "STRIPE_PUBLISHABLE_KEY",
      ...STORAGE_BILLING,
    ] as const;
    for (const name of stray.filter((n) => env[n] !== undefined)) {
      ctx.addIssue({ code: "custom", path: [name], message: "needs STRIPE_SECRET_KEY" });
    }
    return;
  }
  for (const name of ["STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_MONTHLY"] as const) {
    if (env[name] === undefined) {
      ctx.addIssue({ code: "custom", path: [name], message: "is required with STRIPE_SECRET_KEY" });
    }
  }
  if (env.STRIPE_PRICE_BUSINESS_YEARLY && !env.STRIPE_PRICE_BUSINESS_MONTHLY) {
    ctx.addIssue({
      code: "custom",
      path: ["STRIPE_PRICE_BUSINESS_MONTHLY"],
      message: "is required with STRIPE_PRICE_BUSINESS_YEARLY",
    });
  }
  const prices = [
    env.STRIPE_PRICE_MONTHLY,
    env.STRIPE_PRICE_YEARLY,
    env.STRIPE_PRICE_BUSINESS_MONTHLY,
    env.STRIPE_PRICE_BUSINESS_YEARLY,
  ].filter(Boolean);
  if (new Set(prices).size !== prices.length) {
    ctx.addIssue({
      code: "custom",
      path: ["STRIPE_PRICE_MONTHLY"],
      message: "each plan price must be a different Stripe price",
    });
  }
  const storage = STORAGE_BILLING.filter((name) => env[name] !== undefined);
  if (storage.length === 1) {
    for (const name of STORAGE_BILLING.filter((n) => env[n] === undefined)) {
      ctx.addIssue({ code: "custom", path: [name], message: `is required with ${storage[0]}` });
    }
  }
  const mode = (key: string) => (/^[a-z]+_live_/.test(key) ? "live" : "test");
  if (
    env.STRIPE_PUBLISHABLE_KEY &&
    mode(env.STRIPE_PUBLISHABLE_KEY) !== mode(env.STRIPE_SECRET_KEY)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["STRIPE_PUBLISHABLE_KEY"],
      message: "must be the same mode (test or live) as STRIPE_SECRET_KEY",
    });
  }
}

export interface PlanPrices {
  monthlyPriceId: string;
  yearlyPriceId: string | undefined;
}

/** The billing config, or undefined with billing off. */
export function billingConfig(env: BillingEnv) {
  if (
    env.BILLING === "off" ||
    !env.STRIPE_SECRET_KEY ||
    !env.STRIPE_WEBHOOK_SECRET ||
    !env.STRIPE_PRICE_MONTHLY
  ) {
    return undefined;
  }
  const plans: Partial<Record<PaidPlanKey, PlanPrices>> = {
    team: { monthlyPriceId: env.STRIPE_PRICE_MONTHLY, yearlyPriceId: env.STRIPE_PRICE_YEARLY },
  };
  if (env.STRIPE_PRICE_BUSINESS_MONTHLY) {
    plans.business = {
      monthlyPriceId: env.STRIPE_PRICE_BUSINESS_MONTHLY,
      yearlyPriceId: env.STRIPE_PRICE_BUSINESS_YEARLY,
    };
  }
  return {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
    plans,
    storage:
      env.STRIPE_PRICE_STORAGE && env.STRIPE_STORAGE_METER_EVENT
        ? { priceId: env.STRIPE_PRICE_STORAGE, meterEvent: env.STRIPE_STORAGE_METER_EVENT }
        : undefined,
  };
}

/** The paid plan a Stripe price belongs to, and its interval, or null when it is no plan's. */
export function planOfPrice(plans: Partial<Record<PaidPlanKey, PlanPrices>>, priceId: string) {
  for (const [plan, prices] of Object.entries(plans) as [PaidPlanKey, PlanPrices][]) {
    if (prices.monthlyPriceId === priceId) return { plan, interval: "month" as const };
    if (prices.yearlyPriceId === priceId) return { plan, interval: "year" as const };
  }
  return null;
}

/** Every price id a plan is sold at. */
export function planPriceIds(plans: Partial<Record<PaidPlanKey, PlanPrices>>) {
  return Object.values(plans).flatMap((p) => [p.monthlyPriceId, p.yearlyPriceId ?? []].flat());
}
