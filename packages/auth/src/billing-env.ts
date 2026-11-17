import { z } from "zod";

export const optionalText = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const wholeNumber = z.string().regex(/^\d+$/, "use a whole number").transform(Number);
const positiveInt = optionalText.pipe(wholeNumber.pipe(z.number().positive()).optional());

/**
 * Billing (ADR 0015): one flat plan per workspace, with a monthly allowance of AI-triaged emails.
 * All of it is optional: with no `STRIPE_SECRET_KEY` there is no Stripe plugin and no limit.
 * Amounts live in Stripe as prices; only their ids are config.
 */
export const billingFields = {
  /** `off` turns billing off even with the Stripe settings below in place. */
  BILLING: optionalText.pipe(z.enum(["off"]).optional()),
  STRIPE_SECRET_KEY: optionalText,
  STRIPE_WEBHOOK_SECRET: optionalText,
  /** Monthly price of the plan. */
  STRIPE_PRICE_MONTHLY: optionalText,
  /** Optional yearly price (usually discounted). Empty offers monthly only. */
  STRIPE_PRICE_YEARLY: optionalText,
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
  /** Free trial length in days, once per workspace and once per account. Empty or 0: no trial. */
  BILLING_TRIAL_DAYS: optionalText.pipe(wholeNumber.optional()).transform((days) => days ?? 0),
  /** AI-triaged emails per workspace per month. */
  BILLING_TRIAGE_ALLOWANCE: positiveInt,
  /**
   * Storage on the plan (ADR 0034 decision 7): the GB a company's plan includes, the metered
   * price extra GB are billed at, and the event name of the Stripe meter behind that price. All
   * three or none; with none, the plan has no storage allowance and nothing is metered.
   */
  BILLING_STORAGE_INCLUDED_GB: optionalText.pipe(
    z.coerce.number<string | undefined>().positive().optional(),
  ),
  STRIPE_PRICE_STORAGE: optionalText,
  STRIPE_STORAGE_METER_EVENT: optionalText.pipe(z.string().max(100).optional()),
};

const STORAGE_BILLING = [
  "BILLING_STORAGE_INCLUDED_GB",
  "STRIPE_PRICE_STORAGE",
  "STRIPE_STORAGE_METER_EVENT",
] as const;

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
      "STRIPE_PUBLISHABLE_KEY",
      "BILLING_TRIAGE_ALLOWANCE",
      ...STORAGE_BILLING,
    ] as const;
    for (const name of stray.filter((n) => env[n] !== undefined)) {
      ctx.addIssue({ code: "custom", path: [name], message: "needs STRIPE_SECRET_KEY" });
    }
    return;
  }
  for (const name of [
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_MONTHLY",
    "BILLING_TRIAGE_ALLOWANCE",
  ] as const) {
    if (env[name] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: "is required with STRIPE_SECRET_KEY",
      });
    }
  }
  const storage = STORAGE_BILLING.filter((name) => env[name] !== undefined);
  if (storage.length > 0 && storage.length < STORAGE_BILLING.length) {
    for (const name of STORAGE_BILLING.filter((n) => env[n] === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [name],
        message: `is required with ${storage[0]}`,
      });
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

/** The billing config, or undefined with billing off. */
export function billingConfig(env: BillingEnv) {
  return env.BILLING !== "off" &&
    env.STRIPE_SECRET_KEY &&
    env.STRIPE_WEBHOOK_SECRET &&
    env.STRIPE_PRICE_MONTHLY
    ? {
        secretKey: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        monthlyPriceId: env.STRIPE_PRICE_MONTHLY,
        yearlyPriceId: env.STRIPE_PRICE_YEARLY,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY,
        trialDays: env.BILLING_TRIAL_DAYS,
        triageAllowance: env.BILLING_TRIAGE_ALLOWANCE!,
        storage:
          env.BILLING_STORAGE_INCLUDED_GB !== undefined &&
          env.STRIPE_PRICE_STORAGE &&
          env.STRIPE_STORAGE_METER_EVENT
            ? {
                includedGb: env.BILLING_STORAGE_INCLUDED_GB,
                priceId: env.STRIPE_PRICE_STORAGE,
                meterEvent: env.STRIPE_STORAGE_METER_EVENT,
              }
            : undefined,
      }
    : undefined;
}
